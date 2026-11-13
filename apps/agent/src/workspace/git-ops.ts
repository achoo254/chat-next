// Source Control's git commands on a workspace: stage, unstage, discard
// (untracked files to the operating system's trash), commit (hooks never
// run), branches, fetch, pull (fast-forward only), push (never forced), log,
// what the branch committed since its base, one file's diff, and the web
// page that opens a pull request. Paths go to git through stdin
// (--pathspec-from-file, NUL-separated, literal), refs are checked by git
// itself before use, and nothing a device sends is ever read as an option.
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import { hasControl } from "../projects/git.ts";
import { OutsideFolderError } from "../safety/session-files.ts";
import type { Trash } from "../safety/trash.ts";
import { GIT_LIMITS, type GitFileChange, clipDiff, newFileDiff, splitDiff } from "../threads/git-changes.ts";
import { type GitCall, type GitRunner, gitError, parseConfigList } from "./git-run.ts";
import { type FileState, type StatusEntry, parseNumstatZ, parseStatusV2 } from "./git-status.ts";
import { type IsSensitive, gitPath, relParts, resolveInside, within } from "./paths.ts";

/** A relative path the workspace holds secret or sensitive (secret names, and the machine's sensitive folders). */
export type SensitiveRel = (rel: string) => boolean;

export const OPS_LIMITS = {
  paths: 1000,
  messageChars: 65_536,
  logMax: 50,
  compareFiles: 1000,
  readTimeoutMs: 15_000,
  writeTimeoutMs: 60_000,
  networkTimeoutMs: 120_000,
  maxBytes: 16 * 1024 * 1024,
};

const read = (args: string[], extra: Partial<GitCall> = {}): GitCall => ({ args, kind: "read", timeoutMs: OPS_LIMITS.readTimeoutMs, maxBytes: OPS_LIMITS.maxBytes, ...extra });
const write = (args: string[], input?: string): GitCall => ({ args, kind: "write", timeoutMs: OPS_LIMITS.writeTimeoutMs, maxBytes: OPS_LIMITS.maxBytes, ...(input === undefined ? {} : { input }) });
const network = (args: string[]): GitCall => ({ args, kind: "network", timeoutMs: OPS_LIMITS.networkTimeoutMs, maxBytes: OPS_LIMITS.maxBytes });

const text = async (run: GitRunner, root: string, call: GitCall) => (await run(root, call)).stdout.toString("utf8");

/** The paths of a request as git pathspecs: plain relative paths, at most 1000, at least one. */
export function pathspecs(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > OPS_LIMITS.paths) throw new AgentError(ErrorCode.INVALID, `between 1 and ${OPS_LIMITS.paths} paths`, { reason: ErrorReason.UNSPECIFIED });
  return paths.map(gitPath);
}

/** NUL-separated pathspecs for --pathspec-from-file=- --pathspec-file-nul. */
const nul = (paths: readonly string[]) => `${paths.join("\0")}\0`;
const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"];

async function hasHead(run: GitRunner, root: string): Promise<boolean> {
  try {
    await run(root, read(["rev-parse", "-q", "--verify", "HEAD^{commit}"]));
    return true;
  } catch {
    return false;
  }
}

/** Secret files among `paths` that the request did not name: refused, listing them (never their content). */
function confirmSensitive(paths: readonly string[], sensitive: SensitiveRel, confirmed: readonly string[]): void {
  const ok = new Set(confirmed);
  const missing = [...new Set(paths)].filter((p) => sensitive(p) && !ok.has(p));
  if (missing.length === 0) return;
  throw new AgentError(ErrorCode.NEEDS_CONSENT, "secret files need the user's confirmation", {
    reason: ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED,
    subject: missing.join("\n").slice(0, 2000),
  });
}

export async function stage(run: GitRunner, root: string, paths: readonly string[], all: boolean, sensitive: SensitiveRel, confirmed: readonly string[]): Promise<void> {
  const specs = all ? ["."] : pathspecs(paths);
  // What `add` would take in: the changed and untracked files below the pathspecs.
  const taking = parseStatusV2(
    await text(run, root, read(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...specs], { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 })),
    Number.MAX_SAFE_INTEGER,
  ).entries.filter((e) => e.area !== "staged");
  confirmSensitive(
    taking.map((e) => e.path.replace(/\/$/, "")),
    sensitive,
    confirmed,
  );
  // All: the workspace's changes, whatever a capped status listed.
  if (all) return void (await run(root, write(["add", "--all", "--", "."])));
  await run(root, write(["add", "--all", ...FROM_STDIN], nul(specs)));
}

export async function unstage(run: GitRunner, root: string, paths: readonly string[], all: boolean): Promise<void> {
  const head = await hasHead(run, root);
  if (all) {
    if (head) await run(root, write(["reset", "-q", "--", "."]));
    else await run(root, write(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]));
    return;
  }
  const input = nul(pathspecs(paths));
  // Before the first commit nothing is in HEAD to go back to: the index entries just go.
  if (head) await run(root, write(["reset", "-q", ...FROM_STDIN], input));
  else await run(root, write(["rm", "-r", "-q", "--cached", "--ignore-unmatch", ...FROM_STDIN], input));
}

/** Files moved to the trash in one call (long argument lists fail). */
export const TRASH_BATCH = 100;

type Planned = { full: string; dev: number; ino: number; dir: boolean; link: boolean };

/**
 * An untracked entry of git status as the thing to move: the entry itself,
 * never what a link points to. Its folder is resolved (and must lie in the
 * workspace); the entry is looked at with lstat. "dir/" (an untracked folder
 * git did not open, such as a nested repository) moves as that folder only
 * when it is one.
 */
async function planMove(root: string, entry: string): Promise<Planned> {
  const folder = entry.endsWith("/");
  const parts = relParts(folder ? entry.slice(0, -1) : entry);
  if (parts.length === 0) throw new OutsideFolderError();
  const parent = await realpath(join(root, ...parts.slice(0, -1)));
  if (!within(root, parent)) throw new OutsideFolderError();
  const full = join(parent, parts.at(-1) ?? "");
  const st = await lstat(full);
  if (folder !== st.isDirectory()) throw changedMeanwhile();
  return { full, dev: st.dev, ino: st.ino, dir: st.isDirectory(), link: st.isSymbolicLink() };
}

const changedMeanwhile = () => gitError(ErrorReason.GIT_FAILED, "the files changed while discarding", "files changed meanwhile; nothing was moved");

/**
 * Throws away the working tree's changes below `paths`: untracked entries go
 * to the trash first (in batches), and only once all of them went do
 * tracked files go back to the index. `beforeTrash` runs between looking
 * at the entries and moving them (tests). Returns how many of each.
 */
export async function discard(
  run: GitRunner,
  root: string,
  paths: readonly string[],
  trash: Trash,
  beforeTrash: () => Promise<void> = async () => undefined,
): Promise<{ restored: number; trashed: number }> {
  const specs = pathspecs(paths);
  const listed = parseStatusV2(
    await text(run, root, read(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...specs], { timeoutMs: 30_000 })),
    Number.MAX_SAFE_INTEGER,
  ).entries;
  // Conflicted files are left alone: resolving them is the terminal's work.
  const tracked = [...new Set(listed.filter((e) => e.area === "unstaged").map((e) => e.path))];
  const planned: Planned[] = [];
  for (const e of listed) if (e.area === "untracked") planned.push(await planMove(root, e.path));
  await beforeTrash();
  // Just before moving: each entry is still the one looked at (a file swapped for a link meanwhile is not moved).
  for (const p of planned) {
    const now = await lstat(p.full).catch(() => undefined);
    if (!now || now.dev !== p.dev || now.ino !== p.ino || now.isDirectory() !== p.dir || now.isSymbolicLink() !== p.link) throw changedMeanwhile();
  }
  let moved = 0;
  for (let i = 0; i < planned.length; i += TRASH_BATCH) {
    const batch = planned.slice(i, i + TRASH_BATCH).map((p) => p.full);
    try {
      await trash(batch);
    } catch {
      throw new AgentError(ErrorCode.INVALID, "the trash did not take the files", {
        reason: ErrorReason.TRASH_UNAVAILABLE,
        subject: `moved ${moved} of ${planned.length} files to the trash; nothing restored`,
      });
    }
    moved += batch.length;
  }
  if (tracked.length > 0) await run(root, write(["restore", "--worktree", ...FROM_STDIN], nul(tracked)));
  return { restored: tracked.length, trashed: moved };
}

export type LogEntry = { oid: string; subject: string; author: string; at: number; refs: string[] };

const LOG_FORMAT = "--format=%H%x1f%ct%x1f%an%x1f%D%x1f%s";

/** `git log -z` in LOG_FORMAT → commits. */
export function parseLog(out: string): LogEntry[] {
  const list: LogEntry[] = [];
  for (const record of out.split("\0")) {
    const parts = record.replace(/^\n/, "").split("\x1f");
    if (parts.length < 5) continue;
    const [oid = "", at = "0", author = "", refs = ""] = parts;
    list.push({ oid, at: Number(at) * 1000, author, refs: refs === "" ? [] : refs.split(", "), subject: parts.slice(4).join("\x1f") });
  }
  return list;
}

/** The repository's config as git would use it (the user's and the repository's, not this agent's -c settings): key → last value. */
async function effectiveConfig(run: GitRunner, root: string): Promise<Map<string, string>> {
  const out = await text(run, root, read(["config", "--show-scope", "--null", "--includes", "--list"], { maxBytes: 1024 * 1024 }));
  const map = new Map<string, string>();
  for (const e of parseConfigList(out)) if (e.scope !== "command") map.set(e.key.toLowerCase(), e.value);
  return map;
}

const TRUE = /^(true|yes|on|1)$/i;

/** States git leaves in its folder while an operation waits for the user; finishing them belongs in a terminal. */
const IN_PROGRESS: [string, string][] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/** Refuses while a merge, rebase, cherry-pick, revert or bisect is in progress. */
async function noOperationInProgress(run: GitRunner, root: string): Promise<void> {
  const gitDir = (await text(run, root, read(["rev-parse", "--absolute-git-dir"]))).replace(/\n$/, "");
  for (const [file, name] of IN_PROGRESS) {
    if (existsSync(join(gitDir, file))) {
      throw new AgentError(ErrorCode.INVALID, `a ${name} is in progress: finish it in a terminal`, { reason: ErrorReason.GIT_OPERATION_IN_PROGRESS, subject: name });
    }
  }
}

/** What an AI reads to write a commit message: the staged files and their patch. */
export type StagedChanges = { files: string; patch: string };

/** Of the staged patch, at most this much, shared among the files; the file list at most `listChars`. */
export const STAGED_LIMITS = { patchChars: 200_000, listChars: 6000 };

/**
 * The staged changes as `git diff --cached` shows them: one "M\tpath" line a
 * file, then the patch of every file that is not secret (a secret file is
 * named only). Each file gets an equal share of the patch budget, and what a
 * small file leaves goes to the larger ones, so one generated file cannot take
 * it all. Throws NOTHING_STAGED when no file, or only secret files, are staged.
 */
export async function stagedChanges(run: GitRunner, root: string, sensitive: SensitiveRel): Promise<StagedChanges> {
  const fields = (await text(run, root, read(["diff", "--cached", "--name-status", "-z", "--no-renames", "--relative"]))).split("\0").filter(Boolean);
  const entries: { state: string; path: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) entries.push({ state: fields[i] ?? "", path: fields[i + 1] ?? "" });
  const open = entries.filter((e) => !sensitive(e.path)).map((e) => e.path);
  if (open.length === 0) throw new AgentError(ErrorCode.INVALID, "nothing is staged", { reason: ErrorReason.NOTHING_STAGED });
  const list = entries.map((e) => `${e.state}\t${e.path}${sensitive(e.path) ? " (secret file: content not shown)" : ""}`).join("\n");
  // git diff takes no pathspec file: the paths go as arguments, in batches a Windows command line holds.
  let out = "";
  for (const batch of argBatches(open.slice(0, OPS_LIMITS.paths).map(gitPath), ARG_CHARS)) {
    out += await text(run, root, read(["diff", "--cached", "--patch", "--minimal", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", "--", ...batch]));
  }
  return { files: list.length > STAGED_LIMITS.listChars ? `${list.slice(0, STAGED_LIMITS.listChars)}\n…` : list, patch: shareBudget(out, STAGED_LIMITS.patchChars) };
}

/** Characters of paths one git command line takes (Windows allows about 32 000 in all). */
const ARG_CHARS = 24_000;

/** `paths` in batches of at most `max` characters (a longer path goes alone). */
export function argBatches(paths: readonly string[], max: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const p of paths) {
    if (batch.length > 0 && size + p.length + 1 > max) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(p);
    size += p.length + 1;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** A multi-file patch cut to `budget` characters, each file's part to its fair share. */
export function shareBudget(patch: string, budget: number): string {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p !== "");
  const order = parts.map((part, at) => ({ part, at })).sort((a, b) => a.part.length - b.part.length);
  const kept: string[] = new Array<string>(parts.length).fill("");
  let left = budget;
  order.forEach(({ part, at }, i) => {
    const share = Math.floor(left / (order.length - i));
    kept[at] = part.length <= share ? part : `${part.slice(0, share)}\n… (cut: this file's change is longer)\n`;
    left -= Math.min(part.length, share);
  });
  return kept.join("");
}

export type CommitOptions = { allowDetached?: boolean; confirmSensitive?: readonly string[] };

export async function commit(run: GitRunner, root: string, message: string, sensitive: SensitiveRel, opts: CommitOptions = {}): Promise<LogEntry> {
  if (message.trim() === "") throw new AgentError(ErrorCode.INVALID, "the commit message is empty", { reason: ErrorReason.EMPTY_MESSAGE });
  if (message.length > OPS_LIMITS.messageChars) throw new AgentError(ErrorCode.INVALID, "the commit message is too long", { reason: ErrorReason.UNSPECIFIED });
  await noOperationInProgress(run, root);
  const onBranch = await run(root, read(["symbolic-ref", "-q", "HEAD"])).then(
    () => true,
    () => false,
  );
  if (!onBranch && !opts.allowDetached) throw new AgentError(ErrorCode.INVALID, "HEAD is detached", { reason: ErrorReason.GIT_DETACHED_HEAD });
  // Signing may ask for a passphrase or a key touch nobody at the machine answers: left to a terminal.
  const config = await effectiveConfig(run, root);
  const format = (config.get("gpg.format") ?? "").toLowerCase();
  if (TRUE.test(config.get("commit.gpgsign") ?? "") || format === "ssh" || format === "x509") {
    throw new AgentError(ErrorCode.INVALID, "git would sign this commit: commit in a terminal", { reason: ErrorReason.GIT_COMMIT_SIGNING });
  }
  const staged = (await text(run, root, read(["diff", "--cached", "--name-only", "-z", "--no-renames", "--relative"]))).split("\0").filter(Boolean);
  confirmSensitive(staged, sensitive, opts.confirmSensitive ?? []);
  // --no-verify on top of the hooks switched off for every call; the message comes on stdin.
  await run(root, write(["commit", "--no-verify", "-q", "-F", "-"], message));
  const [head] = parseLog(await text(run, root, read(["log", "-z", "-n", "1", LOG_FORMAT, "HEAD", "--"])));
  if (!head) throw gitError(ErrorReason.GIT_FAILED, "the new commit cannot be read");
  return head;
}

/** A ref a device names (a branch, tag or commit), as the commit it points to; throws when git does not know it. */
async function resolveRef(run: GitRunner, root: string, ref: string): Promise<string> {
  if (ref === "" || ref.length > 255 || ref.startsWith("-") || hasControl(ref)) throw new AgentError(ErrorCode.INVALID, "not a ref", { reason: ErrorReason.NAME_INVALID, subject: ref.slice(0, 100) });
  try {
    return (await text(run, root, read(["rev-parse", "-q", "--verify", "--end-of-options", `${ref}^{commit}`]))).trim();
  } catch {
    throw new AgentError(ErrorCode.INVALID, "no such ref", { reason: ErrorReason.NAME_INVALID, subject: ref.slice(0, 100) });
  }
}

/** A new branch's name as git takes it. */
async function branchName(run: GitRunner, root: string, name: string): Promise<string> {
  const refuse = () => new AgentError(ErrorCode.INVALID, "not a usable branch name", { reason: ErrorReason.NAME_INVALID, subject: name.slice(0, 100) });
  if (name === "" || name === "HEAD" || name.length > 255 || name.startsWith("-") || hasControl(name)) throw refuse();
  try {
    await run(root, read(["check-ref-format", `refs/heads/${name}`]));
  } catch {
    throw refuse();
  }
  return name;
}

export async function log(run: GitRunner, root: string, ref: string, skip: number, limit: number): Promise<{ commits: LogEntry[]; hasMore: boolean }> {
  const max = Math.min(Math.max(limit || OPS_LIMITS.logMax, 1), OPS_LIMITS.logMax);
  if (ref === "" && !(await hasHead(run, root))) return { commits: [], hasMore: false };
  const oid = await resolveRef(run, root, ref === "" ? "HEAD" : ref);
  const commits = parseLog(await text(run, root, read(["log", "-z", `--skip=${Math.max(0, Math.floor(skip))}`, "-n", String(max + 1), LOG_FORMAT, oid, "--"])));
  return { commits: commits.slice(0, max), hasMore: commits.length > max };
}

export type BranchInfo = { name: string; upstream: string; ahead: number; behind: number; gone: boolean };
export type Branches = { current: string; local: BranchInfo[]; remote: string[] };

/** `git for-each-ref` with "%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)" lines → branches. */
export function parseBranches(out: string): Branches {
  const b: Branches = { current: "", local: [], remote: [] };
  for (const line of out.split("\n")) {
    const [ref = "", upstream = "", track = "", head = ""] = line.split("\0");
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      b.local.push({ name, upstream, ahead: Number(ahead?.[1] ?? 0), behind: Number(behind?.[1] ?? 0), gone: track === "gone" });
      if (head === "*") b.current = name;
    } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      b.remote.push(ref.slice("refs/remotes/".length));
    }
  }
  return b;
}

export async function branches(run: GitRunner, root: string): Promise<Branches> {
  return parseBranches(
    await text(run, root, read(["for-each-ref", "--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads", "refs/remotes"])),
  );
}

export async function checkout(run: GitRunner, root: string, branch: string): Promise<void> {
  const name = await branchName(run, root, branch);
  await noOperationInProgress(run, root);
  // A local branch, or the short name of a remote one git makes a tracking branch for.
  await run(root, write(["switch", "-q", "--no-recurse-submodules", name]));
}

export async function branchCreate(run: GitRunner, root: string, name: string, startPoint: string, switchTo: boolean): Promise<void> {
  const clean = await branchName(run, root, name);
  const start = startPoint === "" ? [] : [startPoint];
  if (startPoint !== "") await resolveRef(run, root, startPoint);
  await run(root, write(switchTo ? ["switch", "-q", "--no-recurse-submodules", "-c", clean, ...start] : ["branch", clean, ...start]));
}

export async function fetch(run: GitRunner, root: string): Promise<void> {
  await run(root, network(["fetch", "--prune", "--recurse-submodules=no", "--quiet"]));
}

export async function pull(run: GitRunner, root: string): Promise<void> {
  await noOperationInProgress(run, root);
  await run(root, network(["pull", "--ff-only", "--no-rebase", "--recurse-submodules=no", "--quiet"]));
}

async function configValue(run: GitRunner, root: string, key: string): Promise<string> {
  try {
    return (await text(run, root, read(["config", "--get", key]))).trim();
  } catch {
    return "";
  }
}

async function currentBranch(run: GitRunner, root: string): Promise<string> {
  try {
    return (await text(run, root, read(["symbolic-ref", "-q", "--short", "HEAD"]))).trim();
  } catch {
    throw gitError(ErrorReason.GIT_FAILED, "HEAD is detached", "HEAD is detached");
  }
}

/** origin, else the only remote; refused when there is none or the name could read as an option. */
async function defaultRemote(run: GitRunner, root: string): Promise<string> {
  const remotes = (await text(run, root, read(["remote"]))).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
  if (remote === undefined || remote.startsWith("-")) throw gitError(ErrorReason.GIT_FAILED, "no remote to push to", "no remote");
  return remote;
}

/**
 * The repository uses Git LFS: a tracked attributes file (at any level)
 * names filter=lfs, or the repository's own config has lfs settings.
 */
async function usesLfs(run: GitRunner, root: string): Promise<boolean> {
  // Attributes files git tracks, read from the index (a pattern pathspec: the paths are ours, not a device's).
  const found = await run(root, read(["grep", "--cached", "-l", "-I", "-F", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"], { okCodes: [1], patternPaths: true }));
  if (found.stdout.length > 0) return true;
  const out = await text(run, root, read(["config", "--show-scope", "--null", "--includes", "--list"], { maxBytes: 1024 * 1024 }));
  return parseConfigList(out).some((e) => (e.scope === "local" || e.scope === "worktree") && /^lfs\./i.test(e.key));
}

/**
 * What a pre-push hook gets for one ref ("<local ref> <local oid> <remote
 * ref> <remote oid>"), the remote oid being what is known of it (zeros when
 * nothing).
 */
async function pushLine(run: GitRunner, root: string, branch: string, remote: string, remoteRef: string): Promise<string> {
  const local = (await text(run, root, read(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]))).trim();
  const tracking = `refs/remotes/${remote}/${remoteRef.slice("refs/heads/".length)}`;
  const known = await text(run, root, read(["rev-parse", "-q", "--verify", `${tracking}^{commit}`])).then(
    (o) => o.trim(),
    () => "0".repeat(local.length),
  );
  return `refs/heads/${branch} ${local} ${remoteRef} ${known}\n`;
}

/**
 * Hooks never run, so Git LFS's pre-push (which uploads the large files)
 * is run here, with the same environment, before the commits go: never
 * pointers without their objects.
 */
async function lfsPrePush(run: GitRunner, root: string, branch: string, remote: string, remoteRef: string): Promise<void> {
  if (!(await usesLfs(run, root))) return;
  const url = (await text(run, root, read(["remote", "get-url", "--push", remote]))).trim();
  const input = await pushLine(run, root, branch, remote, remoteRef);
  const installed = await run(root, read(["lfs", "version"])).then(
    () => true,
    () => false,
  );
  if (!installed) throw new AgentError(ErrorCode.INVALID, "this repository uses Git LFS: install git-lfs on the machine", { reason: ErrorReason.GIT_LFS_MISSING });
  await run(root, { ...network(["lfs", "pre-push", remote, url]), input });
}

/** Pushes the current branch to its upstream (never forced); without one, to the same name on the default remote, which becomes its upstream. */
export async function push(run: GitRunner, root: string): Promise<void> {
  const branch = await currentBranch(run, root);
  const remote = await configValue(run, root, `branch.${branch}.remote`);
  const merge = await configValue(run, root, `branch.${branch}.merge`);
  const common = ["push", "--no-verify", "--recurse-submodules=no", "--quiet"];
  if (remote !== "" && merge.startsWith("refs/heads/") && !remote.startsWith("-")) {
    await lfsPrePush(run, root, branch, remote, merge);
    await run(root, network([...common, remote, `refs/heads/${branch}:${merge}`]));
    return;
  }
  const target = await defaultRemote(run, root);
  await lfsPrePush(run, root, branch, target, `refs/heads/${branch}`);
  await run(root, network([...common, "--set-upstream", target, `refs/heads/${branch}:refs/heads/${branch}`]));
}

/** The base a branch is compared with: origin/HEAD, else origin/main, origin/master, main, master. */
export async function defaultBase(run: GitRunner, root: string): Promise<string> {
  try {
    const target = (await text(run, root, read(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]))).trim();
    if (target.startsWith("refs/remotes/")) return target.slice("refs/remotes/".length);
  } catch {
    // no origin/HEAD
  }
  for (const [ref, name] of [
    ["refs/remotes/origin/main", "origin/main"],
    ["refs/remotes/origin/master", "origin/master"],
    ["refs/heads/main", "main"],
    ["refs/heads/master", "master"],
  ] as const) {
    try {
      await run(root, read(["rev-parse", "-q", "--verify", `${ref}^{commit}`]));
      return name;
    } catch {
      // next
    }
  }
  return "";
}

export type BranchCompare = { base: string; mergeBase: string; ahead: number; behind: number; files: StatusEntry[]; truncated: boolean };

/** `git diff --name-status -z` → files ("X\0path\0", a rename "R100\0old\0new\0"). */
export function parseNameStatus(out: string): { path: string; oldPath: string; state: FileState }[] {
  const records = out.split("\0");
  const list: { path: string; oldPath: string; state: FileState }[] = [];
  const states: Record<string, FileState> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "renamed", T: "typeChanged", U: "conflicted" };
  for (let i = 0; i < records.length; i++) {
    const code = records[i] ?? "";
    if (code === "") continue;
    const letter = code[0] ?? "M";
    if (letter === "R" || letter === "C") {
      list.push({ oldPath: records[i + 1] ?? "", path: records[i + 2] ?? "", state: "renamed" });
      i += 2;
    } else {
      list.push({ oldPath: "", path: records[i + 1] ?? "", state: states[letter] ?? "modified" });
      i += 1;
    }
  }
  return list;
}

const DIFF_COMMON = ["--no-ext-diff", "--no-textconv", "--no-color", "--relative"];

export async function branchCompare(run: GitRunner, root: string, base: string, sensitive: SensitiveRel): Promise<BranchCompare> {
  const empty: BranchCompare = { base: "", mergeBase: "", ahead: 0, behind: 0, files: [], truncated: false };
  const name = base === "" ? await defaultBase(run, root) : base;
  if (name === "" || !(await hasHead(run, root))) return empty;
  const baseOid = await resolveRef(run, root, name);
  let mergeBase: string;
  try {
    mergeBase = (await text(run, root, read(["merge-base", baseOid, "HEAD"]))).trim();
  } catch {
    return { ...empty, base: name };
  }
  const [behind = "0", ahead = "0"] = (await text(run, root, read(["rev-list", "--left-right", "--count", `${baseOid}...HEAD`]))).trim().split(/\s+/);
  const listed = parseNameStatus(await text(run, root, read(["diff", "--name-status", "-z", "-M", ...DIFF_COMMON, mergeBase, "HEAD", "--", "."])));
  const counts = parseNumstatZ(await text(run, root, read(["diff", "--numstat", "-z", "-M", ...DIFF_COMMON, mergeBase, "HEAD", "--", "."])));
  const files = listed.slice(0, OPS_LIMITS.compareFiles).map((f): StatusEntry => {
    const c = counts.get(f.path);
    return { path: f.path, oldPath: f.oldPath, area: "staged", state: f.state, added: c?.added ?? 0, removed: c?.removed ?? 0, binary: c === null, sensitive: sensitive(f.path) || (f.oldPath !== "" && sensitive(f.oldPath)) };
  });
  return { base: name, mergeBase, ahead: Number(ahead), behind: Number(behind), files, truncated: listed.length > OPS_LIMITS.compareFiles };
}

export type DiffSource = "unstaged" | "staged" | "commit" | "branch";

const FULL_OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** One file's diff from `source`; a secret file comes without content. */
export async function fileDiff(
  run: GitRunner,
  root: string,
  req: { path: string; oldPath: string; source: DiffSource; commit: string; base: string },
  sensitive: SensitiveRel,
  isSensitive: IsSensitive,
): Promise<GitFileChange> {
  const path = gitPath(req.path);
  const oldPath = req.oldPath === "" ? "" : gitPath(req.oldPath);
  // Either side being secret keeps the content back (a rename from a key file shows the key).
  const file: GitFileChange = { path, state: "modified", added: 0, removed: 0, unified: "", truncated: false, binary: false, sensitive: sensitive(path) || (oldPath !== "" && sensitive(oldPath)) };
  if (file.sensitive) return file;
  let range: string[];
  if (req.source === "unstaged") {
    const tracked = (await text(run, root, read(["ls-files", "-z", "--", path]))) !== "";
    if (!tracked) {
      if (oldPath !== "") throw notRenamed(req.oldPath);
      const created = await newFileDiff((await resolveInside(root, path, isSensitive)).real, path, GIT_LIMITS);
      if (created === null) return { ...file, state: "untracked", binary: true };
      return { ...file, state: "untracked", added: created.added, ...clipDiff(created.unified, Number.MAX_SAFE_INTEGER, GIT_LIMITS.fileChars) };
    }
    range = [];
  } else if (req.source === "staged") {
    range = ["--cached"];
  } else if (req.source === "commit") {
    if (!FULL_OID.test(req.commit)) throw new AgentError(ErrorCode.INVALID, "a full commit id", { reason: ErrorReason.NAME_INVALID, subject: req.commit.slice(0, 100) });
    const oid = await resolveRef(run, root, req.commit);
    const parent = await resolveRef(run, root, `${oid}^`).catch(() => "");
    // A root commit: against the empty tree.
    range = [parent === "" ? (await text(run, root, read(["hash-object", "-t", "tree", "--stdin"], { input: "" }))).trim() : parent, oid];
  } else {
    const compared = await branchCompare(run, root, req.base, sensitive);
    if (compared.mergeBase === "") throw gitError(ErrorReason.GIT_FAILED, "no base to compare with", "no base");
    range = [compared.mergeBase, "HEAD"];
  }
  const specs = oldPath === "" ? [path] : [oldPath, path];
  const renames = oldPath === "" ? "--no-renames" : "-M";
  // An old path counts only as the source git reports for this rename.
  if (oldPath !== "") {
    const listed = parseNameStatus(await text(run, root, read(["diff", "--name-status", "-z", "-M", ...DIFF_COMMON, ...range, "--", ...specs])));
    if (!listed.some((f) => f.state === "renamed" && f.path === path && f.oldPath === oldPath)) throw notRenamed(req.oldPath);
  }
  const counts = parseNumstatZ(await text(run, root, read(["diff", "--numstat", "-z", renames, ...DIFF_COMMON, ...range, "--", ...specs])));
  const c = counts.get(path);
  if (c === null) return { ...file, binary: true };
  if (c) Object.assign(file, c);
  const out = await text(run, root, read(["diff", renames, ...DIFF_COMMON, "--src-prefix=a/", "--dst-prefix=b/", ...range, "--", ...specs]));
  // Only the diff whose new side is `path` (for a deletion git names the old side, which is `path` too).
  const unified = splitDiff(out).get(path) ?? "";
  const state: GitFileChange["state"] = /^new file mode/m.test(out) ? "added" : /^deleted file mode/m.test(out) ? "deleted" : "modified";
  return { ...file, state, ...clipDiff(unified, Number.MAX_SAFE_INTEGER, GIT_LIMITS.fileChars) };
}

const notRenamed = (oldPath: string) => new AgentError(ErrorCode.INVALID, "git reports no such rename", { reason: ErrorReason.NAME_INVALID, subject: oldPath.slice(0, 300) });

export type PrLink = { url: string; provider: "github" | "gitlab" };

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The host and repository path of a remote URL (https, ssh or scp-like); undefined for anything else. */
export function remoteRepo(url: string): { host: string; path: string[] } | undefined {
  const u = url.trim();
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(u);
  if (!m) return undefined;
  const host = (m[1] ?? "").toLowerCase();
  const path = (m[2] ?? "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith("-") || path.length < 2 || !path.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return undefined;
  return { host, path };
}

/** A branch name in a URL: each part escaped, the slashes kept. */
const urlBranch = (b: string) => b.split("/").map(encodeURIComponent).join("/");

/** The page that opens a pull (GitHub) or merge (GitLab) request of `branch` into `base`. */
export function prLink(remoteUrl: string, branch: string, base: string): PrLink | undefined {
  const repo = remoteRepo(remoteUrl);
  if (!repo) return undefined;
  const site = `https://${repo.host}/${repo.path.join("/")}`;
  if (repo.host.includes("gitlab")) {
    const q = `merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
    return { provider: "gitlab", url: `${site}/-/merge_requests/new?${q}` };
  }
  if (repo.host.includes("github") && repo.path.length === 2) {
    return { provider: "github", url: `${site}/compare/${urlBranch(base)}...${urlBranch(branch)}?expand=1` };
  }
  return undefined;
}

export async function prUrl(run: GitRunner, root: string, base: string): Promise<PrLink> {
  const branch = await currentBranch(run, root);
  const upstreamRemote = await configValue(run, root, `branch.${branch}.remote`);
  const remote = upstreamRemote !== "" && upstreamRemote !== "." ? upstreamRemote : "origin";
  const url = await configValue(run, root, `remote.${remote}.url`);
  let target = base;
  if (target === "") {
    const found = await defaultBase(run, root);
    // "origin/main" names the branch "main" on the remote.
    target = found.startsWith(`${remote}/`) ? found.slice(remote.length + 1) : found.replace(/^[^/]+\//, "");
  }
  if (target === "") target = "main";
  const link = url === "" ? undefined : prLink(url, branch, target);
  if (!link) throw gitError(ErrorReason.GIT_FAILED, "the remote is not on GitHub or GitLab", "unsupported remote");
  return link;
}

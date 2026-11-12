// What is not committed in a thread's folder, as git sees it: changed,
// staged, deleted and untracked files below the folder, each with its lines
// added and removed and a short unified diff against the last commit. Edits
// made by a shell command or outside the AI show here too. git runs with
// safeGitArgs (no repository-chosen programs: no fsmonitor, hooks, external
// diff or textconv), never waits for a prompt, and each call has a timeout;
// a slow or failing git gives what it got so far, marked partial.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { gitEnv, safeGitArgs } from "../projects/git.ts";

export type GitFileState = "modified" | "added" | "deleted" | "untracked" | "typeChanged" | "conflicted";

export type GitFileChange = {
  /** Relative to the thread's folder, with "/". */
  path: string;
  state: GitFileState;
  added: number;
  removed: number;
  /** Unified diff from its "---" line; "" for a binary or sensitive file, or one git did not diff in time. */
  unified: string;
  truncated: boolean;
  binary: boolean;
  sensitive: boolean;
};

export type GitChangesResult = {
  git: boolean;
  files: GitFileChange[];
  /** More files changed than listed. */
  truncated: boolean;
  /** git did not answer in time or failed: the list may be incomplete. */
  partial: boolean;
};

export const GIT_LIMITS = {
  /** Files listed at most. */
  files: 200,
  /** Lines of each file's diff in a list (a file is fetched whole with fileDiff). */
  listLines: 120,
  /** Characters of all diffs in one list together; files past it come without a diff. */
  listChars: 256 * 1024,
  /** Characters of one file's whole diff. */
  fileChars: 1024 * 1024,
  /** An untracked file larger than this is listed without a diff. */
  newFileBytes: 512 * 1024,
  timeoutMs: 5_000,
  maxBuffer: 16 * 1024 * 1024,
};

type Limits = typeof GIT_LIMITS;

class GitFailed extends Error {
  constructor(
    readonly notGit: boolean,
    readonly timedOut: boolean,
  ) {
    super(notGit ? "not a git work tree" : timedOut ? "git took too long" : "git failed");
  }
}

function git(dir: string, args: string[], limits: Limits): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      [...safeGitArgs(), "-c", "core.quotePath=false", "--literal-pathspecs", "-C", dir, ...args],
      { timeout: limits.timeoutMs, env: gitEnv(), maxBuffer: limits.maxBuffer, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return done(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        // No git on the machine counts as no git work tree.
        const notGit = e.code === "ENOENT" || /not a git repository/i.test(String(stderr));
        fail(new GitFailed(notGit, Boolean(e.killed) || e.signal === "SIGTERM"));
      },
    );
  });
}

/** Porcelain "XY" → the file's state. */
export function stateOf(xy: string): GitFileState {
  const [x = " ", y = " "] = xy;
  if (xy === "??") return "untracked";
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "conflicted";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
  if (x === "T" || y === "T") return "typeChanged";
  return "modified";
}

/** `git status --porcelain=v1 -z --no-renames` → paths from the repository root with their state. */
export function parsePorcelain(out: string): { path: string; state: GitFileState }[] {
  const list: { path: string; state: GitFileState }[] = [];
  for (const entry of out.split("\0")) {
    if (entry.length < 4 || entry[2] !== " ") continue;
    list.push({ path: entry.slice(3), state: stateOf(entry.slice(0, 2)) });
  }
  return list;
}

/** `git diff --numstat -z` → added and removed lines by path; null counts for a binary file. */
export function parseNumstat(out: string): Map<string, { added: number; removed: number } | null> {
  const counts = new Map<string, { added: number; removed: number } | null>();
  for (const entry of out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry);
    if (!m || m[3] === undefined) continue;
    counts.set(m[3], m[1] === "-" || m[2] === "-" ? null : { added: Number(m[1]), removed: Number(m[2]) });
  }
  return counts;
}

/**
 * `git diff` of several files → each file's diff from its "---" line, by the
 * path its "+++ b/" (or for a deletion "--- a/") line names.
 */
export function splitDiff(out: string): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const chunk of out.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const from = lines.findIndex((l) => l.startsWith("--- "));
    if (from < 0) continue;
    const minus = lines[from] ?? "";
    const plus = lines[from + 1] ?? "";
    const path = plus.startsWith("+++ b/") ? plus.slice(6) : minus.startsWith("--- a/") ? minus.slice(6) : "";
    if (path === "") continue;
    byPath.set(path, lines.slice(from).join("\n").replace(/\n+$/, ""));
  }
  return byPath;
}

/** At most `maxLines` lines and `maxChars` characters of a diff. */
export function clipDiff(unified: string, maxLines: number, maxChars: number): { unified: string; truncated: boolean } {
  let lines = unified.split("\n");
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    truncated = true;
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { unified: text, truncated };
}

/** A whole new file as a diff that adds every line; null for a binary, unreadable or too large one. */
export async function newFileDiff(full: string, path: string, limits: Limits): Promise<{ unified: string; added: number } | null> {
  try {
    const info = await stat(full);
    if (!info.isFile() || info.size > limits.newFileBytes) return null;
    const data = await readFile(full);
    if (data.includes(0)) return null;
    const lines = data.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const body = lines.map((l) => `+${l}`);
    return { unified: [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...body].join("\n"), added: lines.length };
  } catch {
    return null;
  }
}

type Listed = { root: string; path: string; state: GitFileState };

/**
 * Where the folder stands in git: its prefix in the repository, whether HEAD
 * exists, and the changed files below it (at most limits.files + 1).
 */
async function listFiles(dir: string, limits: Limits): Promise<{ files: Listed[]; head: boolean }> {
  const [inside, prefix = ""] = (await git(dir, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], limits)).split("\n");
  if (inside?.trim() !== "true") throw new GitFailed(true, false);
  const head = await git(dir, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], limits).then(
    () => true,
    (err: unknown) => {
      if (err instanceof GitFailed && err.timedOut) throw err;
      return false;
    },
  );
  const status = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."], limits);
  const files = parsePorcelain(status)
    .filter((f) => f.path.startsWith(prefix))
    .slice(0, limits.files + 1)
    .map((f) => ({ root: f.path, path: f.path.slice(prefix.length), state: f.state }));
  return { files, head };
}

const DIFF_ARGS = ["--relative", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * The uncommitted changes of `dir` and below. Sensitive paths are listed
 * without their content. Outside git: `{ git: false }`.
 */
export async function readGitChanges(dir: string, isSensitive: (path: string) => boolean, limits: Limits = GIT_LIMITS): Promise<GitChangesResult> {
  let listed: { files: Listed[]; head: boolean };
  try {
    listed = await listFiles(dir, limits);
  } catch (err) {
    if (err instanceof GitFailed && err.notGit) return { git: false, files: [], truncated: false, partial: false };
    return { git: true, files: [], truncated: false, partial: true };
  }
  const truncated = listed.files.length > limits.files;
  const shown = listed.files.slice(0, limits.files);
  const files: GitFileChange[] = shown.map((f) => ({
    path: f.path,
    state: f.state,
    added: 0,
    removed: 0,
    unified: "",
    truncated: false,
    binary: false,
    sensitive: isSensitive(resolve(dir, f.path)),
  }));
  let partial = false;
  // Tracked files against the last commit; without one, every file is new.
  const tracked = listed.head ? files.filter((f) => f.state !== "untracked" && f.state !== "conflicted") : [];
  const diffs = new Map<string, string>();
  if (tracked.length > 0) {
    const paths = tracked.map((f) => f.path);
    try {
      const counts = parseNumstat(await git(dir, ["diff", "--numstat", "-z", ...DIFF_ARGS, "HEAD", "--", ...paths], limits));
      for (const f of tracked) {
        const c = counts.get(f.path);
        if (c === null) f.binary = true;
        else if (c) Object.assign(f, c);
      }
      const readable = tracked.filter((f) => !f.binary && !f.sensitive).map((f) => f.path);
      if (readable.length > 0) for (const [p, d] of splitDiff(await git(dir, ["diff", ...DIFF_ARGS, "HEAD", "--", ...readable], limits))) diffs.set(p, d);
    } catch {
      partial = true;
    }
  }
  let budget = limits.listChars;
  for (const f of files) {
    if (f.sensitive || f.binary) continue;
    let unified = diffs.get(f.path);
    if (unified === undefined && (f.state === "untracked" || (!listed.head && f.state !== "deleted"))) {
      const created = await newFileDiff(resolve(dir, f.path), f.path, limits);
      if (created === null) {
        f.binary = true;
        continue;
      }
      unified = created.unified;
      f.added = created.added;
    }
    if (unified === undefined) continue;
    const clipped = clipDiff(unified, limits.listLines, Math.max(0, budget));
    budget -= clipped.unified.length;
    f.unified = clipped.unified;
    f.truncated = clipped.truncated;
  }
  return { git: true, files, truncated, partial };
}

/** One file of the folder's uncommitted changes with its whole diff; undefined when git does not list it now. */
export async function readGitFileDiff(
  dir: string,
  path: string,
  isSensitive: (path: string) => boolean,
  limits: Limits = GIT_LIMITS,
): Promise<GitFileChange | undefined> {
  const whole = { ...limits, listLines: Number.MAX_SAFE_INTEGER, listChars: limits.fileChars };
  let listed: { files: Listed[]; head: boolean };
  try {
    listed = await listFiles(dir, { ...limits, files: Number.MAX_SAFE_INTEGER });
  } catch {
    return undefined;
  }
  const f = listed.files.find((x) => x.path === path);
  if (!f) return undefined;
  const file: GitFileChange = { path, state: f.state, added: 0, removed: 0, unified: "", truncated: false, binary: false, sensitive: isSensitive(resolve(dir, path)) };
  if (file.sensitive) return file;
  if (listed.head && f.state !== "untracked" && f.state !== "conflicted") {
    try {
      const c = parseNumstat(await git(dir, ["diff", "--numstat", "-z", ...DIFF_ARGS, "HEAD", "--", path], whole)).get(path);
      if (c === null) return { ...file, binary: true };
      if (c) Object.assign(file, c);
      const unified = splitDiff(await git(dir, ["diff", ...DIFF_ARGS, "HEAD", "--", path], whole)).get(path) ?? "";
      return { ...file, ...clipDiff(unified, whole.listLines, whole.fileChars) };
    } catch {
      return file;
    }
  }
  if (f.state === "deleted" || f.state === "conflicted") return file;
  const created = await newFileDiff(resolve(dir, path), path, limits);
  if (created === null) return { ...file, binary: true };
  return { ...file, added: created.added, ...clipDiff(created.unified, whole.listLines, whole.fileChars) };
}

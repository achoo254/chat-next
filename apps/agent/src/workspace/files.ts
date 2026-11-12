// The Explorer's reads of a workspace: a folder by pages (with what git
// ignores and what changed), a file for a preview, file names and file
// contents to find. Read only. Every path goes through resolveInside, a
// symbolic link is followed only when it stays inside the workspace, secret
// files are never listed, read or searched, and every walk, read and git
// call has a cap.
import { constants, type Dirent } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import type { GitRunner } from "./git-run.ts";
import { type FileState, parseStatusV2 } from "./git-status.ts";
import { type IsSensitive, isSecretName, isSecretPath, naturalCompare, resolveInside, secretFileError, toRel, within } from "./paths.ts";

export const FILE_LIMITS = {
  /** Entries a folder may have to be listed at all. */
  dirEntries: 100_000,
  pageDefault: 500,
  pageMax: 2000,
  textBytes: 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  namesDefault: 100,
  namesMax: 500,
  /** Entries a walk (outside git) looks at. */
  walkMax: 100_000,
  queryMax: 2048,
  matchesMax: 2000,
  grepTimeoutMs: 15_000,
  /** Files larger than this are left out of content search. */
  grepFileBytes: 5 * 1024 * 1024,
  lineChars: 300,
  gitTimeoutMs: 15_000,
};

export type DirEntryInfo = {
  name: string;
  dir: boolean;
  symlink: boolean;
  outside: boolean;
  size: number;
  mtime: number;
  ignored: boolean;
  /** "" when unchanged or outside git. */
  git: FileState | "";
};

export type DirPage = { path: string; entries: DirEntryInfo[]; hasMore: boolean; total: number };

export type DirPageRequest = { afterName: string; afterDir: boolean; limit: number; showHidden: boolean; hideIgnored: boolean };

const notADirectory = () => Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
const tooLong = () => new AgentError(ErrorCode.INVALID, "the query is too long", { reason: ErrorReason.UNSPECIFIED });

type Candidate = { name: string; dir: boolean; symlink: boolean; outside: boolean; target: string };

/** The listable entries of a folder (secret names and sensitive folders never; hidden ones on request). */
async function candidates(root: string, real: string, showHidden: boolean, isSensitive: IsSensitive): Promise<Candidate[]> {
  const list: Candidate[] = [];
  let seen = 0;
  const handle = await opendir(real);
  try {
    for await (const d of handle as AsyncIterable<Dirent>) {
      if (++seen > FILE_LIMITS.dirEntries) throw new AgentError(ErrorCode.INVALID, "the folder has too many entries", { reason: ErrorReason.FOLDER_TOO_LARGE });
      if (isSecretName(d.name) || (!showHidden && d.name.startsWith("."))) continue;
      const full = join(real, d.name);
      if (isSensitive(full)) continue;
      if (d.isDirectory() || d.isFile()) {
        list.push({ name: d.name, dir: d.isDirectory(), symlink: false, outside: false, target: full });
        continue;
      }
      if (!d.isSymbolicLink()) continue; // devices, sockets, pipes: never shown
      let target: string;
      try {
        target = await realpath(full);
      } catch {
        list.push({ name: d.name, dir: false, symlink: true, outside: true, target: "" });
        continue;
      }
      if (!within(root, target)) {
        list.push({ name: d.name, dir: false, symlink: true, outside: true, target: "" });
        continue;
      }
      if (isSecretPath(toRel(root, target)) || isSensitive(target)) continue;
      const info = await stat(target).catch(() => undefined);
      if (!info || (!info.isDirectory() && !info.isFile())) continue;
      list.push({ name: d.name, dir: info.isDirectory(), symlink: true, outside: false, target });
    }
  } finally {
    // for-await closes the handle on a normal end; a throw above leaves it to us.
    await handle.close().catch(() => undefined);
  }
  return list;
}

/** The paths git ignores among `rels` (relative to the workspace); none outside git or when git fails. */
async function ignoredOf(run: GitRunner, root: string, rels: readonly string[]): Promise<Set<string>> {
  if (rels.length === 0) return new Set();
  try {
    const out = await run(root, {
      // check-ignore takes plain paths (it refuses the literal pathspec setting); they come from the folder, not a device.
      args: ["check-ignore", "-z", "--stdin"],
      kind: "read",
      patternPaths: true,
      input: `${rels.join("\0")}\0`,
      okCodes: [1],
      timeoutMs: FILE_LIMITS.gitTimeoutMs,
      maxBytes: 16 * 1024 * 1024,
    });
    return new Set(out.stdout.toString("utf8").split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/** git's mark of each entry of the folder `relDir` ("" the root): a file's own state, a folder's summary. */
async function marksOf(run: GitRunner, root: string, relDir: string): Promise<Map<string, FileState>> {
  const marks = new Map<string, FileState>();
  let out;
  try {
    out = await run(root, {
      args: ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", relDir === "" ? "." : relDir],
      kind: "read",
      timeoutMs: FILE_LIMITS.gitTimeoutMs,
      maxBytes: 8 * 1024 * 1024,
      partial: true,
    });
  } catch {
    return marks;
  }
  const prefix = relDir === "" ? "" : `${relDir}/`;
  const dirs = new Map<string, boolean>(); // name → everything below untracked
  for (const e of parseStatusV2(out.stdout.toString("utf8"), Number.MAX_SAFE_INTEGER).entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      dirs.set(name, (dirs.get(name) ?? true) && e.state === "untracked");
    } else if (!marks.has(rest) || marks.get(rest) === "modified") {
      // A file staged and changed again keeps its more telling state (added, renamed, …).
      marks.set(rest, e.state);
    }
  }
  for (const [name, untracked] of dirs) marks.set(name, untracked ? "untracked" : "modified");
  return marks;
}

const order = (a: { name: string; dir: boolean }, b: { name: string; dir: boolean }) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : naturalCompare(a.name, b.name));

/** One page of the folder `rel` of the workspace whose real folder is `root`. */
export async function listDirPage(run: GitRunner, root: string, rel: string, req: DirPageRequest, isSensitive: IsSensitive): Promise<DirPage> {
  const { real } = await resolveInside(root, rel, isSensitive);
  if (!(await stat(real)).isDirectory()) throw notADirectory();
  const relDir = toRel(root, real);
  const childRel = (name: string) => (relDir === "" ? name : `${relDir}/${name}`);
  let all = await candidates(root, real, req.showHidden, isSensitive);
  // git's marks only where the workspace is its repository's top folder.
  const git = await isRepoTop(run, root);
  let ignored: Set<string> | undefined = git ? undefined : new Set();
  if (req.hideIgnored && git) {
    ignored = await ignoredOf(run, root, all.map((c) => childRel(c.name)));
    all = all.filter((c) => !ignored?.has(childRel(c.name)));
  }
  all.sort(order);
  const cursor = { name: req.afterName, dir: req.afterDir };
  const from = req.afterName === "" ? 0 : all.findIndex((c) => order(c, cursor) > 0);
  const limit = Math.min(Math.max(req.limit || FILE_LIMITS.pageDefault, 1), FILE_LIMITS.pageMax);
  const start = from < 0 ? all.length : from;
  const page = all.slice(start, start + limit);
  if (!ignored) ignored = await ignoredOf(run, root, page.map((c) => childRel(c.name)));
  const marks = git ? await marksOf(run, root, relDir) : new Map<string, FileState>();
  const entries = await Promise.all(
    page.map(async (c): Promise<DirEntryInfo> => {
      const info = c.target === "" ? undefined : await stat(c.target).catch(() => undefined);
      return {
        name: c.name,
        dir: c.dir,
        symlink: c.symlink,
        outside: c.outside,
        size: c.dir || !info ? 0 : info.size,
        mtime: info ? Math.floor(info.mtimeMs) : 0,
        ignored: ignored?.has(childRel(c.name)) ?? false,
        git: marks.get(c.name) ?? "",
      };
    }),
  );
  return { path: relDir, entries, hasMore: start + limit < all.length, total: all.length };
}

export type FileKind = "text" | "image" | "binary" | "tooLarge";
export type FilePreview = { kind: FileKind; size: number; mtime: number; mime: string; text: string; data: Uint8Array };

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const SNIFF_BYTES = 8192;

/** A regular file of the workspace for a read-only preview, within the size limits of its kind. */
export async function readFilePreview(root: string, rel: string, isSensitive: IsSensitive): Promise<FilePreview> {
  const { real } = await resolveInside(root, rel, isSensitive);
  // Never blocks on a pipe, never follows a link swapped in since it was resolved.
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(real, flags);
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new AgentError(ErrorCode.INVALID, "not a regular file", { reason: ErrorReason.UNSPECIFIED });
    // A second name of a file may be a secret file elsewhere under an innocent name.
    if (info.nlink > 1) throw secretFileError();
    const base = { size: info.size, mtime: Math.floor(info.mtimeMs), mime: "", text: "", data: new Uint8Array() };
    const ext = real.slice(real.lastIndexOf(".") + 1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime) {
      if (info.size > FILE_LIMITS.imageBytes) return { ...base, kind: "tooLarge", mime };
      return { ...base, kind: "image", mime, data: await readAll(fh, info.size) };
    }
    if (info.size > FILE_LIMITS.textBytes) {
      const head = await readAll(fh, Math.min(info.size, SNIFF_BYTES));
      return { ...base, kind: head.includes(0) ? "binary" : "tooLarge" };
    }
    const bytes = await readAll(fh, info.size);
    if (bytes.includes(0)) return { ...base, kind: "binary" };
    try {
      return { ...base, kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { ...base, kind: "binary" };
    }
  } finally {
    await fh.close();
  }
}

async function readAll(fh: Awaited<ReturnType<typeof open>>, size: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await fh.read(buf, at, size - at, at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return buf.subarray(0, at);
}

/**
 * Where the workspace stands in git: "top" when it is its repository's top
 * folder, "inside" when it is a folder within a larger repository, "none"
 * outside git. Refusals of the repository's config (core.worktree) throw.
 */
export async function gitPlace(run: GitRunner, root: string): Promise<"top" | "inside" | "none"> {
  let out;
  try {
    out = await run(root, { args: ["rev-parse", "--show-toplevel"], kind: "read", timeoutMs: FILE_LIMITS.gitTimeoutMs, maxBytes: 64 * 1024 });
  } catch (err) {
    if ((err as { reason?: unknown }).reason === ErrorReason.NOT_A_GIT_REPOSITORY) return "none";
    throw err;
  }
  const top = out.stdout.toString("utf8").replace(/\n$/, "");
  const real = await realpath(top).catch(() => "");
  return real === root ? "top" : "inside";
}

/** git may be asked about the workspace's files: it is its repository's top folder (never throws). */
async function isRepoTop(run: GitRunner, root: string): Promise<boolean> {
  return (await gitPlace(run, root).catch(() => "none")) === "top";
}

const WALK_SKIPPED = new Set(["node_modules"]);

/** Every file below the root outside git, breadth first, links never walked into, sensitive folders left out. */
async function walkFiles(root: string, isSensitive: IsSensitive): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  const queue = [""];
  let seen = 0;
  for (let head = 0; head < queue.length; head++) {
    const rel = queue[head] ?? "";
    let handle;
    try {
      handle = await opendir(join(root, rel));
    } catch {
      continue; // unreadable or gone
    }
    for await (const d of handle as AsyncIterable<Dirent>) {
      if (++seen > FILE_LIMITS.walkMax) {
        await handle.close().catch(() => undefined);
        return { paths, truncated: true };
      }
      const path = rel === "" ? d.name : `${rel}/${d.name}`;
      if (WALK_SKIPPED.has(d.name) || isSecretName(d.name) || isSensitive(join(root, path))) continue;
      if (d.isDirectory()) queue.push(path);
      else if (d.isFile() || d.isSymbolicLink()) paths.push(path);
    }
  }
  return { paths, truncated: false };
}

/** Query words: every one must be in the path, case-insensitive. */
export function queryTokens(query: string): string[] {
  if (query.length > FILE_LIMITS.queryMax) throw tooLong();
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Files whose relative path holds every word of `query`, shortest first. */
export async function findNames(run: GitRunner, root: string, query: string, limit: number, isSensitive: IsSensitive): Promise<{ paths: string[]; truncated: boolean }> {
  const tokens = queryTokens(query);
  const max = Math.min(Math.max(limit || FILE_LIMITS.namesDefault, 1), FILE_LIMITS.namesMax);
  if (tokens.length === 0) return { paths: [], truncated: false };
  let all: string[];
  let partial: boolean;
  if (await isRepoTop(run, root)) {
    const out = await run(root, {
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", "."],
      kind: "read",
      timeoutMs: FILE_LIMITS.grepTimeoutMs,
      maxBytes: 64 * 1024 * 1024,
      partial: true,
    });
    partial = out.capped || out.timedOut;
    all = out.stdout.toString("utf8").split("\0").filter(Boolean);
    // A capped list ends in a cut name.
    if (out.capped) all.pop();
  } else {
    const walked = await walkFiles(root, isSensitive);
    all = walked.paths;
    partial = walked.truncated;
  }
  const matches = all.filter((p) => {
    const lower = p.toLowerCase();
    return tokens.every((t) => lower.includes(t)) && !isSecretPath(p) && !isSensitive(join(root, p));
  });
  matches.sort((a, b) => a.length - b.length || naturalCompare(a, b));
  return { paths: matches.slice(0, max), truncated: partial || matches.length > max };
}

export type ContentQuery = { query: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; limit: number };
export type ContentMatch = { line: number; column: number; text: string };
export type ContentFile = { path: string; matches: ContentMatch[] };
export type ContentResult = { files: ContentFile[]; totalMatches: number; truncated: boolean; timedOut: boolean };

/** `git grep -z -n --column` output ("path\0line\0column\0text\n" each) → matches; a cut last one is dropped. */
export function parseGrep(out: string): { path: string; line: number; column: number; text: string }[] {
  const list: { path: string; line: number; column: number; text: string }[] = [];
  let at = 0;
  for (;;) {
    const a = out.indexOf("\0", at);
    const b = a < 0 ? -1 : out.indexOf("\0", a + 1);
    const c = b < 0 ? -1 : out.indexOf("\0", b + 1);
    const d = c < 0 ? -1 : out.indexOf("\n", c + 1);
    if (d < 0) return list;
    list.push({ path: out.slice(at, a), line: Number(out.slice(a + 1, b)), column: Number(out.slice(b + 1, c)), text: out.slice(c + 1, d) });
    at = d + 1;
  }
}

/** Lines holding the query in the files git does not ignore (git grep, no shell, capped and timed). */
export async function findContents(run: GitRunner, root: string, q: ContentQuery, isSensitive: IsSensitive): Promise<ContentResult> {
  if (q.query.length > FILE_LIMITS.queryMax) throw tooLong();
  if (q.query === "") return { files: [], totalMatches: 0, truncated: false, timedOut: false };
  const max = Math.min(Math.max(q.limit || FILE_LIMITS.matchesMax, 1), FILE_LIMITS.matchesMax);
  const git = await isRepoTop(run, root);
  // Stops git once well past the limit (newlines count matches closely enough).
  let lines = 0;
  const out = await run(root, {
    args: [
      "grep",
      "-z",
      "-n",
      "--column",
      "-I",
      "--no-color",
      git ? "--untracked" : "--no-index",
      "--exclude-standard",
      ...(q.caseSensitive ? [] : ["-i"]),
      ...(q.wholeWord ? ["-w"] : []),
      q.regex ? "-E" : "-F",
      "-e",
      q.query,
      "--",
      ".",
    ],
    kind: "read",
    okCodes: [1],
    timeoutMs: FILE_LIMITS.grepTimeoutMs,
    maxBytes: 32 * 1024 * 1024,
    partial: true,
    onData: (chunk) => {
      for (const byte of chunk) if (byte === 10) lines++;
      return lines <= max * 2;
    },
  });
  const sizes = new Map<string, boolean>();
  const small = async (path: string) => {
    let ok = sizes.get(path);
    if (ok === undefined) {
      ok = await stat(join(root, path)).then(
        (s) => s.size <= FILE_LIMITS.grepFileBytes,
        () => false,
      );
      sizes.set(path, ok);
    }
    return ok;
  };
  const files: ContentFile[] = [];
  let total = 0;
  let truncated = out.capped || out.stopped;
  for (const m of parseGrep(out.stdout.toString("utf8"))) {
    if (isSecretPath(m.path) || isSensitive(join(root, m.path)) || !(await small(m.path))) continue;
    if (total >= max) {
      truncated = true;
      break;
    }
    total++;
    let file = files.at(-1);
    if (file?.path !== m.path) {
      file = { path: m.path, matches: [] };
      files.push(file);
    }
    file.matches.push({ line: m.line, column: m.column, text: m.text.replace(/\r$/, "").slice(0, FILE_LIMITS.lineChars) });
  }
  return { files, totalMatches: total, truncated, timedOut: out.timedOut };
}

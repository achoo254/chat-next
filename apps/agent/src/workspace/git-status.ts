// A workspace's git status for Source Control: `git status --porcelain=v2
// -z` read into staged, unstaged, untracked and conflicted entries (renames
// with their old path), at most 1000, each with its lines added and removed
// from `git diff --numstat -z`. Paths are relative to the workspace and are
// taken from git verbatim (-z), so spaces, newlines or quotes in a name are
// just characters.
import { createHash } from "node:crypto";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import type { GitRunner } from "./git-run.ts";
import { isSecretPath } from "./paths.ts";

const NOT_GIT = ErrorReason.NOT_A_GIT_REPOSITORY;

export type FileState = "modified" | "added" | "deleted" | "renamed" | "typeChanged" | "conflicted" | "untracked";
export type Area = "staged" | "unstaged" | "untracked" | "conflicted";

export type StatusEntry = {
  path: string;
  /** A rename's or copy's old path; "" otherwise. */
  oldPath: string;
  area: Area;
  state: FileState;
  added: number;
  removed: number;
  binary: boolean;
  sensitive: boolean;
};

export type Upstream = { name: string; ahead: number; behind: number };

export type WorkspaceStatus = {
  git: boolean;
  branch: string;
  head: string;
  upstream?: Upstream;
  entries: StatusEntry[];
  truncated: boolean;
};

export const STATUS_LIMITS = { entries: 1000, timeoutMs: 30_000, maxBytes: 32 * 1024 * 1024 };

const LETTER: Record<string, FileState> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "renamed", T: "typeChanged", U: "conflicted" };

/** The first `n` space-separated fields of a record and the rest (a path, which may hold spaces). */
function fields(record: string, n: number): { head: string[]; rest: string } | undefined {
  const head: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const sp = record.indexOf(" ", at);
    if (sp < 0) return undefined;
    head.push(record.slice(at, sp));
    at = sp + 1;
  }
  return { head, rest: record.slice(at) };
}

function entry(path: string, oldPath: string, area: Area, letter: string): StatusEntry {
  return { path, oldPath, area, state: area === "untracked" ? "untracked" : area === "conflicted" ? "conflicted" : (LETTER[letter] ?? "modified"), added: 0, removed: 0, binary: false, sensitive: false };
}

/** `git status --porcelain=v2 -z --branch` → branch, upstream and at most `limit` entries. */
export function parseStatusV2(out: string, limit = STATUS_LIMITS.entries): Omit<WorkspaceStatus, "git"> {
  const s: Omit<WorkspaceStatus, "git"> = { branch: "", head: "", entries: [], truncated: false };
  const records = out.split("\0");
  const push = (e: StatusEntry) => {
    if (s.entries.length >= limit) s.truncated = true;
    else s.entries.push(e);
  };
  for (let i = 0; i < records.length; i++) {
    const r = records[i] ?? "";
    if (r.startsWith("# branch.oid ")) {
      const oid = r.slice("# branch.oid ".length);
      s.head = oid === "(initial)" ? "" : oid;
    } else if (r.startsWith("# branch.head ")) {
      const head = r.slice("# branch.head ".length);
      s.branch = head === "(detached)" ? "" : head;
    } else if (r.startsWith("# branch.upstream ")) {
      s.upstream = { name: r.slice("# branch.upstream ".length), ahead: 0, behind: 0 };
    } else if (r.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(r);
      if (m && s.upstream) {
        s.upstream.ahead = Number(m[1]);
        s.upstream.behind = Number(m[2]);
      }
    } else if (r.startsWith("1 ") || r.startsWith("2 ")) {
      const renamed = r.startsWith("2 ");
      const f = fields(r, renamed ? 9 : 8);
      // A rename's old path is the next record.
      const oldPath = renamed ? (records[++i] ?? "") : "";
      if (!f) continue;
      const [x = ".", y = "."] = f.head[1] ?? "..";
      if (x !== ".") push(entry(f.rest, x === "R" || x === "C" ? oldPath : "", "staged", x));
      if (y !== ".") push(entry(f.rest, y === "R" || y === "C" ? oldPath : "", "unstaged", y));
    } else if (r.startsWith("u ")) {
      const f = fields(r, 10);
      if (f) push(entry(f.rest, "", "conflicted", "U"));
    } else if (r.startsWith("? ")) {
      push(entry(r.slice(2), "", "untracked", "?"));
    }
  }
  return s;
}

/**
 * `git diff --numstat -z` → lines added and removed by (new) path; null for
 * a binary file. A rename comes as "added\tremoved\t\0old\0new\0".
 */
export function parseNumstatZ(out: string): Map<string, { added: number; removed: number } | null> {
  const counts = new Map<string, { added: number; removed: number } | null>();
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(records[i] ?? "");
    if (!m) continue;
    let path = m[3] ?? "";
    if (path === "") {
      i += 2;
      path = records[i] ?? "";
    }
    counts.set(path, m[1] === "-" || m[2] === "-" ? null : { added: Number(m[1]), removed: Number(m[2]) });
  }
  return counts;
}

const NUMSTAT = ["diff", "--numstat", "-z", "-M", "--relative", "--no-ext-diff", "--no-textconv", "--no-color"];

function applyCounts(entries: StatusEntry[], counts: Map<string, { added: number; removed: number } | null>): void {
  for (const e of entries) {
    if (!counts.has(e.path)) continue;
    const c = counts.get(e.path);
    if (c === null || c === undefined) e.binary = c === null;
    else {
      e.added = c.added;
      e.removed = c.removed;
    }
  }
}

/** The workspace's status; `{ git: false }` outside a git work tree. */
export async function readStatus(run: GitRunner, root: string, isSensitive: (abs: string) => boolean, abs: (rel: string) => string): Promise<WorkspaceStatus> {
  let out;
  try {
    out = await run(root, {
      args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."],
      kind: "read",
      timeoutMs: STATUS_LIMITS.timeoutMs,
      maxBytes: STATUS_LIMITS.maxBytes,
      partial: true,
    });
  } catch (err) {
    if ((err as { reason?: unknown }).reason === NOT_GIT) return { git: false, branch: "", head: "", entries: [], truncated: false };
    throw err;
  }
  const parsed = parseStatusV2(out.stdout.toString("utf8"));
  const status: WorkspaceStatus = { git: true, ...parsed, truncated: parsed.truncated || out.capped || out.timedOut };
  const secret = (rel: string) => isSecretPath(rel) || isSensitive(abs(rel));
  for (const e of status.entries) e.sensitive = secret(e.path) || (e.oldPath !== "" && secret(e.oldPath));
  // Line counts only for a list git gave whole (as Orca: none past the cap).
  if (!status.truncated && status.entries.length > 0) {
    const read = (args: string[]) =>
      run(root, { args, kind: "read", timeoutMs: STATUS_LIMITS.timeoutMs, maxBytes: 8 * 1024 * 1024 }).then(
        (o) => parseNumstatZ(o.stdout.toString("utf8")),
        () => new Map<string, { added: number; removed: number } | null>(),
      );
    const unstaged = status.entries.filter((e) => e.area === "unstaged");
    const staged = status.entries.filter((e) => e.area === "staged");
    if (unstaged.length > 0) applyCounts(unstaged, await read([...NUMSTAT, "--", "."]));
    if (staged.length > 0) applyCounts(staged, await read([...NUMSTAT, "--cached", "--", "."]));
  }
  return status;
}

/** A fingerprint of the status (for change events): a hash of the porcelain output. */
export async function statusFingerprint(run: GitRunner, root: string): Promise<string | undefined> {
  try {
    const out = await run(root, {
      args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."],
      kind: "read",
      timeoutMs: STATUS_LIMITS.timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      partial: true,
    });
    return createHash("sha256").update(out.stdout).digest("hex");
  } catch {
    return undefined;
  }
}

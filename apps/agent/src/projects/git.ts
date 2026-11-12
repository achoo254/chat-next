// git as projects use it: a cheap status (branch, changed files, ahead and
// behind), checking a clone URL, and `git` invocations that never run a
// repository's own commands. A repository's config can name programs git
// runs on its own (core.fsmonitor on status, hooks on checkout); every call
// here switches those off, and a clone gets no hook templates and only the
// https and ssh transports.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Settings every git call starts with: no repository-chosen programs, no prompts. */
export function safeGitArgs(): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
  ];
}

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    // ssh may not ask for anything either: an unknown host or a key passphrase fails instead.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
}

export type GitStatus = { git: boolean; branch: string; changed: number; ahead: number; behind: number; upstream: boolean };

/** `git status --porcelain=v2 --branch` output → the status. */
export function parseStatus(out: string): GitStatus {
  const s: GitStatus = { git: true, branch: "", changed: 0, ahead: 0, behind: 0, upstream: false };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      s.branch = head === "(detached)" ? "" : head;
    } else if (line.startsWith("# branch.upstream ")) {
      s.upstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (/^[12u?] /.test(line)) {
      s.changed += 1;
    }
  }
  return s;
}

/** The status of the work tree at `dir`; `{ git: false }` outside git; undefined when git is missing or too slow. */
export async function gitStatus(dir: string, timeoutMs = 3_000): Promise<GitStatus | undefined> {
  try {
    const { stdout } = await run("git", [...safeGitArgs(), "-C", dir, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
      timeout: timeoutMs,
      env: gitEnv(),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return parseStatus(stdout);
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown };
    if (typeof e.stderr === "string" && /not a git repository/i.test(e.stderr)) return { git: false, branch: "", changed: 0, ahead: 0, behind: 0, upstream: false };
    return undefined;
  }
}

/** Runs a read-only git command in `dir`; its output, or undefined when git fails, is missing or too slow. */
async function gitRead(dir: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", [...safeGitArgs(), "-C", dir, ...args], { timeout: timeoutMs, env: gitEnv(), maxBuffer: 64 * 1024, windowsHide: true });
    return stdout;
  } catch {
    return undefined;
  }
}

const REMOTE_MAX = 2048;
const BRANCH_MAX = 255;

/** C0 and C1 control characters and DEL. */
export function hasControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** The first line of git's answer, when it is one clean line of at most `max` characters. */
function oneLine(out: string, max: number): string | undefined {
  const line = (out.split(/\r?\n/)[0] ?? "").trim();
  return line === "" || line.length > max || hasControl(line) ? undefined : line;
}

const URL_USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@/]*)@(.*)$/;

/**
 * A remote URL as devices get it: as git has it, but never with a password
 * (`scheme://user:password@`) and, for http(s), never with a user either,
 * which is where hosts put access tokens.
 */
export function reportableRemote(raw: string): string | undefined {
  const url = oneLine(raw, REMOTE_MAX);
  if (url === undefined) return undefined;
  const m = URL_USERINFO.exec(url);
  if (!m) return url;
  const scheme = m[1] ?? "";
  const userinfo = m[2] ?? "";
  const rest = m[3] ?? "";
  if (/^https?:\/\/$/i.test(scheme)) return scheme + rest;
  const user = userinfo.split(":")[0] ?? "";
  return user === "" ? scheme + rest : `${scheme}${user}@${rest}`;
}

/**
 * The folder's `remote.origin.url`, reportable (reportableRemote); undefined
 * outside git, without that remote, or when git fails or is slow. Reading
 * config runs nothing of the repository's.
 */
export async function gitOriginUrl(dir: string, timeoutMs = 3_000): Promise<string | undefined> {
  const out = await gitRead(dir, ["config", "--get", "remote.origin.url"], timeoutMs);
  return out === undefined ? undefined : reportableRemote(out);
}

/** The checked-out branch of the folder; undefined outside git, when detached, or when git fails or is slow. */
export async function gitBranch(dir: string, timeoutMs = 3_000): Promise<string | undefined> {
  const out = await gitRead(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs);
  return out === undefined ? undefined : oneLine(out, BRANCH_MAX);
}

/**
 * A clone URL tunelo takes: https:// or ssh (ssh://… or user@host:path),
 * without a password, nothing that git could read as an option. Returns the
 * repository's name for the folder, or undefined when refused.
 */
export function cloneUrlName(url: string): string | undefined {
  const u = url.trim();
  if (u === "" || u.length > 2048 || u.startsWith("-") || /\s/.test(u)) return undefined;
  let path: string;
  if (/^(https|ssh):\/\//i.test(u)) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return undefined;
    }
    if (parsed.password !== "" || parsed.hostname === "" || parsed.hostname.startsWith("-")) return undefined;
    if (parsed.protocol === "https:" && parsed.username !== "") return undefined;
    path = parsed.pathname;
  } else {
    // scp-like ssh: [user@]host:path, where host has no "/" and is not a drive letter.
    const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(u);
    if (!m || (m[2] ?? "").length < 2 || (m[2] ?? "").startsWith("-") || (m[1] ?? "").startsWith("-")) return undefined;
    path = m[3] ?? "";
  }
  const name = path.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "";
  return name === "" || name === "." || name === ".." ? undefined : name;
}

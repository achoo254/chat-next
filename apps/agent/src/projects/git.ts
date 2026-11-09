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

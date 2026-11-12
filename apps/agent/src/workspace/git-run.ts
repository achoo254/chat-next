// git for a workspace's panel: spawned with an argument list (never a
// shell), in a process group of its own so a timeout stops git and every
// helper it started (remote helpers, ssh, credential programs), with a cap
// on what it may print, never prompting, and never running a program the
// repository names. Every call starts from safeGitArgs plus a few more
// switches; hooks go to an empty folder of the agent's own.
//
// A repository's own config (local or worktree scope; the user's global and
// system config are theirs) may still name programs git would run on its
// own: credential helpers, ssh commands, filters, diff and merge drivers,
// signing programs. Before every call the config is listed: a read runs
// with those programs switched off, a write or network command in such a
// repository is refused naming the key, a network command is refused too
// where the repository sets its own proxy, TLS or header settings, and any
// call is refused where it moves the work tree (core.worktree).
//
// Accepted risk: the config is read just before git reads it again. A
// program key written in between (by another process of the user's) would
// be used by that one call. Writes and network calls list the config again
// afterwards and report such a change (GIT_UNSAFE_CONFIG), and reads and
// local writes run with credential helpers off whatever the config says.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import { gitEnv, hasControl, safeGitArgs } from "../projects/git.ts";

export type GitKind = "read" | "write" | "network";

export type GitCall = {
  args: readonly string[];
  kind: GitKind;
  timeoutMs: number;
  /** stdout kept at most; past it git is stopped and `capped` set. */
  maxBytes: number;
  input?: string;
  /** Exit codes that are answers, not failures (e.g. 1 for "nothing matched"). */
  okCodes?: readonly number[];
  /** Ran out of time or space: give what came so far instead of failing. */
  partial?: boolean;
  /** Each piece of stdout as it comes; return false to stop git (what came so far, this piece included, is the answer). */
  onData?: (chunk: Buffer) => boolean;
  /** Paths as patterns; only for commands that refuse literal pathspecs (check-ignore), never with a device's pathspec. */
  patternPaths?: boolean;
};

export type GitOutput = { stdout: Buffer; stderr: string; code: number | null; capped: boolean; timedOut: boolean; stopped: boolean };

export type GitRunner = (root: string, call: GitCall) => Promise<GitOutput>;

/** What every workspace git call adds to safeGitArgs. */
const WORKSPACE_ARGS = [
  "-c",
  "core.quotePath=false",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "status.relativePaths=true",
  // Nothing signs by accident (a commit git would sign is refused before).
  "-c",
  "commit.gpgSign=false",
  // A background gc after a commit or fetch could outlast the timeout.
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** A network call that stalls (fewer than 1000 bytes a second for 30 s) ends before its timeout. */
const NETWORK_ARGS = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"];

/**
 * Environment variables of the agent's own process that would point git at
 * another repository or add settings of their own.
 */
const FOREIGN_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

/** Environment of every call: no prompt of any kind, no editor or pager, literal pathspecs, English messages. */
export function workspaceGitEnv(overrides: readonly [string, string][] = [], literal = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !FOREIGN_ENV.test(k))),
    GIT_LITERAL_PATHSPECS: literal ? "1" : "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    // A program that answers nothing, where one exists; elsewhere none, and GIT_TERMINAL_PROMPT=0 stops git asking.
    GIT_ASKPASS: process.platform === "win32" ? "" : "true",
    SSH_ASKPASS: process.platform === "win32" ? "" : "true",
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
  // Settings of this call only, key and value apart (no "=" parsing as with -c).
  if (overrides.length > 0) {
    env.GIT_CONFIG_COUNT = String(overrides.length);
    overrides.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
  return env;
}

/**
 * Config keys that name a program git may run. Keys come lowercased from
 * git except the subsection (`filter.<name>.clean`), which keeps its case.
 */
const PROGRAM_KEYS =
  /^(credential\.(.+\.)?helper|core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|gpg\.(.+\.)?program|gpg\.ssh\.defaultkeycommand|filter\..+\.(clean|smudge|process)|diff\..+\.(textconv|command)|diff\.external|merge\..+\.driver|remote\..+\.(uploadpack|receivepack|vcs))$/i;

/** url.<base>.insteadOf rewriting to a transport that runs a program. */
const PROGRAM_URL = /^url\.(ext|fd)::.*\.(insteadof|pushinsteadof)$/i;

/** Settings that send the repository's network traffic elsewhere, trust other certificates or add headers. */
const NETWORK_KEYS = /^(http\.(.+\.)?(proxy|sslcainfo|sslcapath|curloptresolve|extraheader)|remote\..+\.proxy)$/i;
const SSL_VERIFY = /^http\.(.+\.)?sslverify$/i;
const FALSE = /^(false|no|off|0|)$/i;

/**
 * A key of the repository's own config that git must not follow from a
 * device: `neutral` when an empty value switches it off; `refuse` says for
 * which calls it is refused (writes and network, network only, every call).
 */
export type RiskyKey = { key: string; neutral: boolean; refuse: "write" | "network" | "always" };

/** `git config --show-scope --null --list` ("scope\0key\nvalue\0" each) → the local and worktree keys git must not follow. */
export function parseRiskyConfig(out: string): RiskyKey[] {
  const risky: RiskyKey[] = [];
  for (const { scope, key, value } of parseConfigList(out)) {
    if (scope !== "local" && scope !== "worktree") continue;
    if (PROGRAM_KEYS.test(key)) risky.push({ key, neutral: true, refuse: "write" });
    else if (PROGRAM_URL.test(key)) risky.push({ key, neutral: false, refuse: "write" });
    else if (/^protocol\.(ext\.)?allow$/i.test(key) && value.toLowerCase() !== "never") risky.push({ key, neutral: false, refuse: "write" });
    else if (NETWORK_KEYS.test(key) || (SSL_VERIFY.test(key) && FALSE.test(value))) risky.push({ key, neutral: false, refuse: "network" });
    else if (/^core\.worktree$/i.test(key)) risky.push({ key, neutral: false, refuse: "always" });
  }
  return risky;
}

export type ConfigEntry = { scope: string; key: string; value: string };

/** `git config --show-scope --null --list` → its entries, in git's order (a later one wins). */
export function parseConfigList(out: string): ConfigEntry[] {
  const records = out.split("\0");
  const list: ConfigEntry[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const entry = records[i + 1] ?? "";
    const nl = entry.indexOf("\n");
    list.push({ scope: records[i] ?? "", key: nl < 0 ? entry : entry.slice(0, nl), value: nl < 0 ? "" : entry.slice(nl + 1) });
  }
  return list;
}

function refusedFor(r: RiskyKey, kind: GitKind): boolean {
  return r.refuse === "always" || (r.refuse === "write" && kind !== "read") || (r.refuse === "network" && kind === "network");
}

export function gitError(reason: ErrorReason, message: string, subject = ""): AgentError {
  return new AgentError(ErrorCode.INVALID, message, { reason, subject });
}

/** git's stderr as a device may see it: its last line, controls out, at most 300 characters, the machine's folders named relatively. */
export function lastLine(stderr: string, root = ""): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => [...l].filter((ch) => !hasControl(ch)).join("").trim())
    .filter((l) => l !== "" && !l.startsWith("hint:"));
  let line = lines.at(-1) ?? "";
  if (root !== "") line = line.replaceAll(root, ".");
  return line.replaceAll(homedir(), "~").slice(0, 300);
}

const NEEDS_CREDENTIALS =
  /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \((publickey|keyboard-interactive|password)|Host key verification failed|HTTP Basic: Access denied|Invalid username or (password|token)|requested URL returned error: 40[13]/i;

/** The repository's git folder (a worktree's .git file names it). */
export function gitDirOf(root: string): string {
  const dotgit = join(root, ".git");
  try {
    if (statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
      if (m?.[1]) return resolve(root, m[1].trim());
    }
  } catch {
    // no .git: git would say so
  }
  return dotgit;
}

/** A failed git call as a device gets it. */
export function failure(out: GitOutput, root = "", kind: GitKind = "read"): AgentError {
  if (out.timedOut) {
    // A write stopped hard may leave git's lock behind: the user removes it once nothing else runs git there.
    const locked = kind !== "read" && root !== "" && existsSync(join(gitDirOf(root), "index.lock"));
    return gitError(ErrorReason.GIT_FAILED, "git took too long", locked ? "timeout; .git/index.lock was left behind" : "timeout");
  }
  if (/not a git repository/i.test(out.stderr)) return gitError(ErrorReason.NOT_A_GIT_REPOSITORY, "not a git work tree");
  if (NEEDS_CREDENTIALS.test(out.stderr)) return gitError(ErrorReason.GIT_NEEDS_CREDENTIALS, "git needs a sign-in on the machine", lastLine(out.stderr, root));
  return gitError(ErrorReason.GIT_FAILED, "git failed", lastLine(out.stderr, root));
}

const STDERR_MAX = 64 * 1024;
const KILL_GRACE_MS = 3_000;
/** After git exits, how long its output may still be open (a helper it left holds it): then the call ends anyway. */
const CLOSE_GRACE_MS = 2_000;
const posix = process.platform !== "win32";

/** Signals git and everything it started (its process group; on Windows its process tree). */
function killTree(pid: number | undefined, hard: boolean): void {
  if (pid === undefined) return;
  if (!posix) {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
  } catch {
    // the group is gone
  }
}

/** Runs git once; resolves with what it printed (rejects only when git could not start). */
function spawnGit(root: string, argv: readonly string[], env: NodeJS.ProcessEnv, call: GitCall): Promise<GitOutput> {
  return new Promise((done, fail) => {
    // Its own process group (POSIX), so stopping it stops its helpers too.
    const child = spawn("git", [...argv], { cwd: root, env, stdio: [call.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true, detached: posix });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let capped = false;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // SIGTERM first: git removes its lock files on it.
    const stop = () => {
      killTree(child.pid, false);
      hardTimer ??= setTimeout(() => killTree(child.pid, true), KILL_GRACE_MS);
      hardTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, call.timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      // Whatever git started and left behind goes with it.
      if (timedOut || capped || stopped) killTree(child.pid, true);
      else clearTimeout(hardTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ stdout: Buffer.concat(chunks), stderr, code, capped, timedOut, stopped });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped || stopped) return;
      if (bytes + chunk.length > call.maxBytes) {
        chunks.push(chunk.subarray(0, call.maxBytes - bytes));
        bytes = call.maxBytes;
        capped = true;
        return stop();
      }
      chunks.push(chunk);
      bytes += chunk.length;
      if (call.onData && !call.onData(chunk)) {
        stopped = true;
        stop();
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (s: string) => {
      if (stderr.length < STDERR_MAX) stderr += s.slice(0, STDERR_MAX - stderr.length);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      fail(err);
    });
    child.on("exit", (code) => {
      closeTimer = setTimeout(() => finish(code), CLOSE_GRACE_MS);
      closeTimer.unref?.();
    });
    child.on("close", (code) => finish(code));
    if (call.input !== undefined && child.stdin) {
      // git may exit before reading everything (a refused call): not an error of ours.
      child.stdin.on("error", () => undefined);
      child.stdin.end(call.input);
    }
  });
}

export type RunnerOptions = {
  /** An empty folder of the agent's own, absolute: git's hooks folder for every call (it runs none from there). */
  hooksDir: string;
  /**
   * More `-c` settings after the safe ones. Tests only: they let a local
   * bare repository or an http server stand in for a remote. Never set in
   * the service.
   */
  extraConfig?: readonly string[];
};

const CONFIG_LIST: GitCall = { args: ["config", "--show-scope", "--null", "--includes", "--list"], kind: "read", timeoutMs: 5_000, maxBytes: 1024 * 1024 };

/** A runner bound to the machine's git, with the repository's config checked before each call. */
export function gitRunner(opts: RunnerOptions): GitRunner {
  const base = [...safeGitArgs(), ...WORKSPACE_ARGS, "-c", `core.hooksPath=${opts.hooksDir}`, ...(opts.extraConfig ?? [])];
  const start = async (root: string, args: readonly string[], env: NodeJS.ProcessEnv, call: GitCall): Promise<GitOutput> => {
    try {
      return await spawnGit(root, [...base, "-C", root, ...args], env, call);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw gitError(ErrorReason.GIT_NOT_INSTALLED, "git is not installed");
      throw err;
    }
  };
  /** The repository's risky keys now. One git cannot read (or one too large to check) tells nothing: refused. */
  const risky = async (root: string): Promise<RiskyKey[]> => {
    const listed = await start(root, CONFIG_LIST.args, workspaceGitEnv(), CONFIG_LIST);
    if (listed.capped || listed.timedOut) throw gitError(ErrorReason.GIT_UNSAFE_CONFIG, "the repository's config cannot be checked", "config");
    // Some git versions answer 1 when there is no config at all.
    if (listed.code !== 0 && !(listed.code === 1 && listed.stdout.length === 0)) throw failure(listed, root);
    return parseRiskyConfig(listed.stdout.toString("utf8"));
  };
  return async (root, call) => {
    // The hooks folder must stay empty: hooks put there would run.
    if (readdirSync(opts.hooksDir).length > 0) throw gitError(ErrorReason.GIT_UNSAFE_CONFIG, "the agent's empty hooks folder is not empty", "core.hooksPath");
    const before = await risky(root);
    const refused = before.find((r) => refusedFor(r, call.kind));
    if (refused) throw gitError(ErrorReason.GIT_UNSAFE_CONFIG, "the repository's config names a program or setting git would use", refused.key);
    // Every such program switched off for this call (an empty value turns it
    // off); credential helpers too, except where a network call needs the user's own.
    const overrides: [string, string][] = before.filter((r) => r.neutral).map((r) => [r.key, ""]);
    if (call.kind !== "network") overrides.unshift(["credential.helper", ""]);
    const args = call.kind === "network" ? [...NETWORK_ARGS, ...call.args] : call.args;
    const out = await start(root, args, workspaceGitEnv(overrides, !call.patternPaths), call);
    if (call.kind !== "read") {
      const known = new Set(before.map((r) => r.key));
      const added = (await risky(root)).find((r) => !known.has(r.key));
      if (added) throw gitError(ErrorReason.GIT_UNSAFE_CONFIG, "the repository's config changed during the command", added.key);
    }
    if (out.code === 0 || out.stopped || (out.code !== null && (call.okCodes ?? []).includes(out.code))) return out;
    if (call.partial && (out.timedOut || out.capped)) return out;
    throw failure(out, root, call.kind);
  };
}

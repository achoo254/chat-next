// The machine's projects (ProjectList and friends in the protocol): folders
// the user keeps, stored in tunelo's config (written atomically by
// ConfigStore), with a cheap git status each, kept for a minute and read again
// once a session there ends a turn. Removing a project never touches its
// folder; creating and cloning only ever write a folder that did not exist,
// and never into a sensitive one.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import type { ConfigStore } from "../config.ts";
import { safeFileName } from "../attachments/project-files.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { type GitStatus, cloneUrlName, gitBranch, gitEnv, gitOriginUrl, gitStatus, safeGitArgs } from "./git.ts";

const run = promisify(execFile);

/** `provider`: the AI new sessions of the project open with; "" lets the device pick one each time. */
export type ProjectDefaults = { provider: string; model: string; permissionMode: string; projectSettings: boolean };

/** One project as tunelo's config keeps it. */
export type ProjectRecord = { id: string; name: string; dir: string; pinned: boolean; defaults: ProjectDefaults; createdAt: number };

/** `gitRemote`: the folder's origin URL as git has it, without credentials (reportableRemote); unset when there is none. */
export type ProjectView = ProjectRecord & { git?: GitStatus; gitRemote?: string; missing: boolean; sensitive: boolean };

/** A folder with sessions that is no project yet, with its origin URL and branch when git has them. */
export type ProjectSuggestion = { dir: string; sessions: number; gitRemote?: string; branch?: string };

export type ProjectList = { projects: ProjectView[]; suggestions: ProjectSuggestion[] };

export type CloneProgress = { cloneId: string; phase: string; percent: number; done: boolean; projectId: string; reason: ErrorReason; message: string };

const STATUS_MS = 60_000;
const NAME_MAX = 64;
const SUGGESTIONS_MAX = 8;
const CLONE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NO_DEFAULTS: ProjectDefaults = { provider: "", model: "", permissionMode: "", projectSettings: false };

const refuse = (reason: ErrorReason, message: string, subject = "") => new AgentError(ErrorCode.INVALID, message, { reason, subject });

/** A project name: one line, no control characters, 1-64 characters. */
export function cleanName(name: string): string | undefined {
  const clean = [...name]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return clean === "" || [...clean].length > NAME_MAX ? undefined : clean;
}

/** A new folder's name: one safe path part, exactly as asked (no renaming behind the user's back). */
function folderName(name: string): string {
  const safe = safeFileName(name);
  if (name.trim() === "" || safe !== name.trim()) throw refuse(ErrorReason.NAME_INVALID, "not a usable folder name", name.slice(0, 100));
  return safe;
}

const caseless = process.platform === "win32" || process.platform === "darwin";
const norm = (p: string) => (caseless ? resolve(p).toLowerCase() : resolve(p));
const sameDir = (a: string, b: string) => norm(a) === norm(b);
/** `dir` is `parent` or inside it. */
const within = (dir: string, parent: string) => {
  const d = norm(dir);
  const p = norm(parent);
  return d === p || d.startsWith(p.endsWith(sep) ? p : p + sep);
};

export type ProjectsOptions = {
  config: ConfigStore;
  audit: AuditLog;
  isSensitive: (p: string) => boolean;
  /** Folders sessions ran in, with how many: tunelo's threads and the AI's own transcripts. */
  sessionDirs: () => Promise<{ dir: string; sessions: number }[]>;
  /** The machine's home folder (never suggested). */
  home: string;
  /** Reads a git status (tests replace it). */
  status?: (dir: string) => Promise<GitStatus | undefined>;
  /** Reads a folder's origin URL, reportable (tests replace it). */
  remote?: (dir: string) => Promise<string | undefined>;
  /** Reads a folder's branch (tests replace it). */
  branch?: (dir: string) => Promise<string | undefined>;
  now?: () => number;
};

type Cached<T> = Map<string, { at: number; value: T }>;

export class Projects {
  private readonly cache: Cached<GitStatus | undefined> = new Map();
  private readonly remotes: Cached<string | undefined> = new Map();
  private readonly branches: Cached<string | undefined> = new Map();
  private readonly clones = new Map<string, { child: ChildProcess; target: string; cancelled: boolean }>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly status: (dir: string) => Promise<GitStatus | undefined>;
  private readonly remote: (dir: string) => Promise<string | undefined>;
  private readonly branch: (dir: string) => Promise<string | undefined>;

  constructor(private readonly opts: ProjectsOptions) {
    this.now = opts.now ?? Date.now;
    this.status = opts.status ?? ((dir) => gitStatus(dir));
    this.remote = opts.remote ?? ((dir) => gitOriginUrl(dir));
    this.branch = opts.branch ?? ((dir) => gitBranch(dir));
  }

  /** Called whenever the list changed (every device gets it again). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private records(): ProjectRecord[] {
    return (this.opts.config.get().projects ?? []).map((p) => ({ ...p, defaults: { ...NO_DEFAULTS, ...p.defaults } }));
  }

  private save(records: ProjectRecord[]): void {
    this.opts.config.update((c) => {
      c.projects = records;
    });
    for (const fn of this.listeners) fn();
  }

  /** The folder of project `id` (a workspace of the right panel); undefined for an unknown id. */
  folderOf(id: string): string | undefined {
    return this.records().find((p) => p.id === id)?.dir;
  }

  /** The project a folder belongs to (the deepest one holding it). */
  projectOf(dir: string): ProjectRecord | undefined {
    return this.records()
      .filter((p) => within(dir, p.dir))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  }

  async list(): Promise<ProjectList> {
    const records = this.records().sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const projects = await Promise.all(
      records.map(async (p): Promise<ProjectView> => {
        const missing = !isDir(p.dir);
        const [git, gitRemote] = missing ? [undefined, undefined] : await Promise.all([this.cached(this.cache, p.dir, this.status), this.cached(this.remotes, p.dir, this.remote)]);
        return { ...p, missing, sensitive: this.opts.isSensitive(p.dir), ...(git ? { git } : {}), ...(gitRemote ? { gitRemote } : {}) };
      }),
    );
    let dirs: { dir: string; sessions: number }[] = [];
    try {
      dirs = await this.opts.sessionDirs();
    } catch {
      // no suggestions this time
    }
    const suggestions = await Promise.all(
      dirs
        .filter((d) => d.dir !== "" && !records.some((p) => sameDir(p.dir, d.dir)) && !sameDir(d.dir, this.opts.home) && !this.opts.isSensitive(d.dir) && isDir(d.dir))
        .sort((a, b) => b.sessions - a.sessions)
        .slice(0, SUGGESTIONS_MAX)
        .map(async (d): Promise<ProjectSuggestion> => {
          const [gitRemote, branch] = await Promise.all([this.cached(this.remotes, d.dir, this.remote), this.cached(this.branches, d.dir, this.branch)]);
          return { dir: d.dir, sessions: d.sessions, ...(gitRemote ? { gitRemote } : {}), ...(branch ? { branch } : {}) };
        }),
    );
    return { projects, suggestions };
  }

  /** A session there ended a turn: its git status (and remote and branch) are read again on the next list. */
  invalidate(dir: string): boolean {
    const p = this.projectOf(dir);
    for (const key of p ? [resolve(p.dir), resolve(dir)] : [resolve(dir)]) {
      this.cache.delete(key);
      this.remotes.delete(key);
      this.branches.delete(key);
    }
    return p !== undefined;
  }

  /** `read(dir)`, kept for a minute. */
  private async cached<T>(cache: Cached<T>, dir: string, read: (dir: string) => Promise<T>): Promise<T> {
    const key = resolve(dir);
    const hit = cache.get(key);
    if (hit && this.now() - hit.at < STATUS_MS) return hit.value;
    const value = await read(dir);
    cache.set(key, { at: this.now(), value });
    return value;
  }

  add(req: { dir: string; name: string; sensitive: boolean; device: string }): string {
    const dir = resolve(req.dir);
    if (!isDir(dir)) throw refuse(ErrorReason.FOLDER_NOT_FOUND, "folder not found", dir);
    const sensitive = this.opts.isSensitive(dir);
    if (sensitive && !req.sensitive) throw new AgentError(ErrorCode.NEEDS_CONSENT, "sensitive folder", { reason: ErrorReason.SENSITIVE_FOLDER, subject: dir });
    const id = this.insert(dir, req.name);
    if (sensitive) this.opts.audit.write({ device: req.device, action: "project_add", path: dir, detail: "" });
    return id;
  }

  private insert(dir: string, name: string): string {
    const records = this.records();
    if (records.some((p) => sameDir(p.dir, dir))) throw refuse(ErrorReason.PROJECT_EXISTS, "this folder is a project already", dir);
    const clean = name.trim() === "" ? cleanName(basename(dir)) || dir : cleanName(name);
    if (clean === undefined) throw refuse(ErrorReason.NAME_INVALID, "not a usable name", name.slice(0, 100));
    const id = randomUUID();
    records.push({ id, name: clean, dir, pinned: false, defaults: { ...NO_DEFAULTS }, createdAt: this.now() });
    this.save(records);
    return id;
  }

  /** A folder for create or clone: `parent`/`name`, new, not sensitive. */
  private newFolder(parent: string, name: string): string {
    const base = resolve(parent);
    if (!isDir(base)) throw refuse(ErrorReason.FOLDER_NOT_FOUND, "folder not found", base);
    const target = join(base, folderName(name));
    if (this.opts.isSensitive(target)) throw refuse(ErrorReason.SENSITIVE_FOLDER, "sensitive folder", target);
    if (existsSync(target)) throw refuse(ErrorReason.PROJECT_EXISTS, "the folder exists", target);
    return target;
  }

  async create(req: { parent: string; name: string; gitInit: boolean }): Promise<string> {
    const target = this.newFolder(req.parent, req.name);
    mkdirSync(target);
    if (req.gitInit) {
      try {
        await run("git", [...safeGitArgs(), "init", "--quiet", "--template=", target], { timeout: 15_000, env: gitEnv(), windowsHide: true });
      } catch (err) {
        rmSync(target, { recursive: true, force: true });
        throw (err as { code?: unknown }).code === "ENOENT"
          ? refuse(ErrorReason.GIT_NOT_INSTALLED, "git is not installed")
          : refuse(ErrorReason.CLONE_FAILED, "git init failed", lastLine(err));
      }
    }
    return this.insert(target, req.name);
  }

  /** Starts a clone; checks come first and throw, the rest reports through `progress`. */
  clone(req: { url: string; parent: string; name: string; cloneId: string }, progress: (p: CloneProgress) => void): void {
    if (!CLONE_ID.test(req.cloneId) || this.clones.has(req.cloneId)) throw refuse(ErrorReason.UNSPECIFIED, "bad clone id");
    const repo = cloneUrlName(req.url);
    if (repo === undefined) throw refuse(ErrorReason.CLONE_URL_INVALID, "only https or ssh URLs without a password");
    const target = this.newFolder(req.parent, req.name.trim() === "" ? repo : req.name);
    const base = { cloneId: req.cloneId, projectId: "", reason: ErrorReason.UNSPECIFIED, message: "" };
    const child = spawn("git", [...safeGitArgs(), "clone", "--progress", "--template=", "--", req.url.trim(), target], { env: gitEnv(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const entry = { child, target, cancelled: false };
    this.clones.set(req.cloneId, entry);
    let last = "";
    let sent = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/[\r\n]+/)) {
        if (line.trim() === "") continue;
        last = line.trim().slice(0, 300);
        const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)%/.exec(line.trim());
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        if (key === sent) continue;
        sent = key;
        progress({ ...base, phase: (m[1] ?? "").trim(), percent: Number(m[2]), done: false });
      }
    });
    const finish = (code: number | null, spawnError?: NodeJS.ErrnoException) => {
      this.clones.delete(req.cloneId);
      if (code === 0 && !entry.cancelled) {
        try {
          const projectId = this.insert(target, req.name.trim() === "" ? repo : req.name);
          progress({ ...base, phase: "", percent: 100, done: true, projectId });
        } catch (err) {
          const e = err as AgentError;
          progress({ ...base, phase: "", percent: 0, done: true, reason: e.reason ?? ErrorReason.UNSPECIFIED, message: e.message });
        }
        return;
      }
      // Only the folder this clone made, which did not exist before.
      rmSync(target, { recursive: true, force: true });
      if (entry.cancelled) return progress({ ...base, phase: "", percent: 0, done: true });
      const reason = spawnError?.code === "ENOENT" ? ErrorReason.GIT_NOT_INSTALLED : ErrorReason.CLONE_FAILED;
      progress({ ...base, phase: "", percent: 0, done: true, reason, message: last });
    };
    child.on("error", (err) => finish(null, err as NodeJS.ErrnoException));
    child.on("close", (code) => finish(code));
  }

  cancelClone(cloneId: string): void {
    const c = this.clones.get(cloneId);
    if (!c) return;
    c.cancelled = true;
    c.child.kill();
  }

  /** `permissionModes`: the modes a device may pick for an AI; undefined for an AI the machine does not know. */
  update(req: { id: string; name?: string; pinned?: boolean; defaults?: ProjectDefaults }, permissionModes: (provider: string) => readonly string[] | undefined): void {
    const records = this.records();
    const p = records.find((x) => x.id === req.id);
    if (!p) throw refuse(ErrorReason.PROJECT_NOT_FOUND, "no such project");
    if (req.name !== undefined) {
      const clean = cleanName(req.name);
      if (clean === undefined) throw refuse(ErrorReason.NAME_INVALID, "not a usable name", req.name.slice(0, 100));
      p.name = clean;
    }
    if (req.pinned !== undefined) p.pinned = req.pinned;
    if (req.defaults) {
      const { provider, model, permissionMode: mode, projectSettings } = req.defaults;
      // A model or a mode belongs to one AI: it needs the AI named.
      if (provider === "" && (mode !== "" || model !== "")) throw refuse(ErrorReason.PROVIDER_REQUIRED, "a model or permission mode needs an AI");
      const modes = provider === "" ? [] : permissionModes(provider);
      if (modes === undefined) throw refuse(ErrorReason.UNKNOWN_AI, "unknown AI", provider.slice(0, 100));
      if (mode !== "" && !modes.includes(mode)) throw refuse(ErrorReason.PERMISSION_MODE_NOT_ALLOWED, "mode not allowed", mode);
      p.defaults = { provider, model: model.slice(0, 100), permissionMode: mode, projectSettings };
    }
    this.save(records);
  }

  reorder(ids: readonly string[]): void {
    const records = this.records();
    if (ids.length !== records.length || new Set(ids).size !== ids.length || !ids.every((id) => records.some((p) => p.id === id))) {
      throw refuse(ErrorReason.PROJECT_NOT_FOUND, "the order must name every project once");
    }
    this.save(ids.map((id) => records.find((p) => p.id === id) as ProjectRecord));
  }

  /** Drops it from the list; the folder stays. */
  remove(id: string): void {
    const records = this.records();
    if (!records.some((p) => p.id === id)) throw refuse(ErrorReason.PROJECT_NOT_FOUND, "no such project");
    this.save(records.filter((p) => p.id !== id));
  }

  /** Stops clones that run (the service is stopping). */
  stop(): void {
    for (const id of [...this.clones.keys()]) this.cancelClone(id);
  }
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function lastLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? (stderr.trim().split("\n").at(-1) ?? "").slice(0, 300) : "";
}

// A workspace's files and git for devices (the right panel): a workspace is
// one of the machine's projects, named by its id, and every request works in
// that project's real folder only. A device never names a folder. git works
// only where the workspace is its repository's top folder. git writes of one
// workspace go one at a time (the lock is let go however git ends) and are
// written to the consent log (what was done and how many files, never a
// path, a file's content or a commit message). Watching a workspace runs
// only while some device does.
import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import type { AuditAction, AuditLog } from "../safety/audit-log.ts";
import { type Trash, systemTrash } from "../safety/trash.ts";
import type { GitFileChange } from "../threads/git-changes.ts";
import { type ContentQuery, type ContentResult, type DirPage, type DirPageRequest, type FilePreview, findContents, findNames, gitPlace, listDirPage, readFilePreview } from "./files.ts";
import { type GitRunner, gitError, gitRunner } from "./git-run.ts";
import * as ops from "./git-ops.ts";
import { type WorkspaceStatus, readStatus, statusFingerprint } from "./git-status.ts";
import { type IsSensitive, isSecretPath } from "./paths.ts";
import { type FileWatch, type WatchTimings, type WorkspaceChange, WorkspaceWatcher } from "./watch.ts";

export type WorkspacesOptions = {
  /** The folder of the machine's project `id`; undefined for an unknown id. */
  folderOf: (id: string) => string | undefined;
  audit: AuditLog;
  isSensitive: IsSensitive;
  /** An absolute folder of the agent's own that stays empty: git's hooks folder (made when missing). */
  hooksDir: string;
  trash?: Trash;
  /** Tests only: more `-c` settings for git (see RunnerOptions.extraConfig). */
  extraGitConfig?: readonly string[];
  /** Tests only: runs between looking at untracked entries and moving them to the trash. */
  beforeTrash?: () => Promise<void>;
  watchTimings?: WatchTimings;
  fileWatch?: FileWatch;
};

type Watching = { watcher: WorkspaceWatcher; listeners: Set<(change: WorkspaceChange) => void> };

/** Longest a git write may hold its workspace, whatever git does: its own timeouts plus room to stop. */
const WRITE_DEADLINE_MS = () => ops.OPS_LIMITS.networkTimeoutMs * 2 + 30_000;

export class Workspaces {
  private readonly run: GitRunner;
  private readonly trash: Trash;
  private readonly writing = new Set<string>();
  private readonly watching = new Map<string, Watching>();

  constructor(private readonly opts: WorkspacesOptions) {
    mkdirSync(opts.hooksDir, { recursive: true, mode: 0o700 });
    this.run = gitRunner({ hooksDir: opts.hooksDir, ...(opts.extraGitConfig ? { extraConfig: opts.extraGitConfig } : {}) });
    this.trash = opts.trash ?? systemTrash();
  }

  /** The real folder of workspace `id`. */
  async root(id: string): Promise<string> {
    const dir = this.opts.folderOf(id);
    if (dir === undefined) throw new AgentError(ErrorCode.INVALID, "no such workspace", { reason: ErrorReason.PROJECT_NOT_FOUND });
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      throw new AgentError(ErrorCode.INVALID, "the workspace folder is gone", { reason: ErrorReason.FOLDER_NOT_FOUND });
    }
    if (!(await stat(real)).isDirectory()) throw new AgentError(ErrorCode.INVALID, "the workspace folder is gone", { reason: ErrorReason.FOLDER_NOT_FOUND });
    return real;
  }

  /** Secret names and the machine's sensitive folders, for paths relative to `root`. */
  private sensitive(root: string): ops.SensitiveRel {
    return (rel) => isSecretPath(rel) || this.opts.isSensitive(join(root, rel));
  }

  // --- Explorer (read only) ---

  async dirList(id: string, path: string, req: DirPageRequest): Promise<DirPage> {
    return listDirPage(this.run, await this.root(id), path, req, this.opts.isSensitive);
  }

  async fileRead(id: string, path: string): Promise<FilePreview> {
    return readFilePreview(await this.root(id), path, this.opts.isSensitive);
  }

  async findNames(id: string, query: string, limit: number): Promise<{ paths: string[]; truncated: boolean }> {
    return findNames(this.run, await this.root(id), query, limit, this.opts.isSensitive);
  }

  async findContents(id: string, q: ContentQuery): Promise<ContentResult> {
    return findContents(this.run, await this.root(id), q, this.opts.isSensitive);
  }

  /**
   * Calls `listener` with the workspace's changes until the returned stop;
   * the watch runs while anyone listens. A listener of a watch that polls
   * hears so at once.
   */
  async watch(id: string, listener: (change: WorkspaceChange) => void): Promise<() => void> {
    const root = await this.root(id);
    let w = this.watching.get(id);
    if (!w) {
      const listeners = new Set<(change: WorkspaceChange) => void>();
      const watcher = new WorkspaceWatcher({
        root,
        emit: (change) => {
          for (const l of listeners) l(change);
        },
        statusKey: () => statusFingerprint(this.run, root),
        ...(this.opts.watchTimings ? { timings: this.opts.watchTimings } : {}),
        ...(this.opts.fileWatch ? { fileWatch: this.opts.fileWatch } : {}),
      });
      w = { watcher, listeners };
      this.watching.set(id, w);
      watcher.start();
    }
    const entry = w;
    entry.listeners.add(listener);
    if (entry.watcher.polling) listener({ dirs: [], overflow: false, git: false, polling: true });
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && this.watching.get(id) === entry) {
        entry.watcher.stop();
        this.watching.delete(id);
      }
    };
  }

  /** Workspaces watched now (tests and shutdown). */
  get watched(): number {
    return this.watching.size;
  }

  stop(): void {
    for (const w of this.watching.values()) w.watcher.stop();
    this.watching.clear();
  }

  // --- Source Control ---

  async status(id: string): Promise<WorkspaceStatus> {
    const root = await this.root(id);
    const place = await this.place(root);
    if (place === "none") return { git: false, branch: "", head: "", entries: [], truncated: false };
    if (place === "inside") throw new AgentError(ErrorCode.INVALID, "the workspace is a folder inside a larger repository", { reason: ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT });
    return this.statusOf(root);
  }

  private statusOf(root: string): Promise<WorkspaceStatus> {
    return readStatus(this.run, root, (abs) => this.opts.isSensitive(abs), (rel) => join(root, rel));
  }

  async diff(id: string, req: { path: string; oldPath: string; source: ops.DiffSource; commit: string; base: string }): Promise<GitFileChange> {
    const root = await this.gitRoot(id);
    return ops.fileDiff(this.run, root, req, this.sensitive(root), this.opts.isSensitive);
  }

  async branches(id: string): Promise<ops.Branches> {
    return ops.branches(this.run, await this.gitRoot(id));
  }

  async log(id: string, ref: string, skip: number, limit: number): Promise<{ commits: ops.LogEntry[]; hasMore: boolean }> {
    return ops.log(this.run, await this.gitRoot(id), ref, skip, limit);
  }

  async branchCompare(id: string, base: string): Promise<ops.BranchCompare> {
    const root = await this.gitRoot(id);
    return ops.branchCompare(this.run, root, base, this.sensitive(root));
  }

  async prUrl(id: string, base: string): Promise<ops.PrLink> {
    return ops.prUrl(this.run, await this.gitRoot(id), base);
  }

  stage(id: string, paths: readonly string[], all: boolean, device: string, confirmSensitive: readonly string[] = []): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_stage", async (root) => {
      await ops.stage(this.run, root, paths, all, this.sensitive(root), confirmSensitive);
      return all ? "all" : `${paths.length} files`;
    });
  }

  unstage(id: string, paths: readonly string[], all: boolean, device: string): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_unstage", async (root) => {
      await ops.unstage(this.run, root, paths, all);
      return all ? "all" : `${paths.length} files`;
    });
  }

  discard(id: string, paths: readonly string[], confirm: boolean, device: string): Promise<WorkspaceStatus> {
    if (!confirm) return Promise.reject(new AgentError(ErrorCode.NEEDS_CONSENT, "discarding needs the user's confirmation", { reason: ErrorReason.DISCARD_NOT_CONFIRMED }));
    return this.write(id, device, "git_discard", async (root) => {
      const done = await ops.discard(this.run, root, paths, this.trash, this.opts.beforeTrash);
      return `restored ${done.restored}, trashed ${done.trashed}`;
    });
  }

  async commit(id: string, message: string, device: string, opts: ops.CommitOptions = {}): Promise<ops.LogEntry> {
    let made: ops.LogEntry | undefined;
    await this.write(id, device, "git_commit", async (root) => {
      made = await ops.commit(this.run, root, message, this.sensitive(root), opts);
      return "";
    });
    if (!made) throw gitError(ErrorReason.GIT_FAILED, "the new commit cannot be read");
    return made;
  }

  checkout(id: string, branch: string, device: string): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_checkout", (root) => ops.checkout(this.run, root, branch).then(() => ""));
  }

  branchCreate(id: string, name: string, startPoint: string, checkout: boolean, device: string): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_branch_create", (root) => ops.branchCreate(this.run, root, name, startPoint, checkout).then(() => ""));
  }

  /** A fetch changes no file of the workspace, only what git knows of the remote: not logged. */
  fetch(id: string): Promise<WorkspaceStatus> {
    return this.write(id, "", undefined, (root) => ops.fetch(this.run, root).then(() => ""));
  }

  pull(id: string, device: string): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_pull", (root) => ops.pull(this.run, root).then(() => ""));
  }

  push(id: string, device: string): Promise<WorkspaceStatus> {
    return this.write(id, device, "git_push", (root) => ops.push(this.run, root).then(() => ""));
  }

  private place(root: string): Promise<"top" | "inside" | "none"> {
    return gitPlace(this.run, root);
  }

  /** The workspace's folder, which must be its repository's top folder. */
  private async gitRoot(id: string): Promise<string> {
    const root = await this.root(id);
    const place = await this.place(root);
    if (place === "none") throw new AgentError(ErrorCode.INVALID, "not a git work tree", { reason: ErrorReason.NOT_A_GIT_REPOSITORY });
    if (place === "inside") throw new AgentError(ErrorCode.INVALID, "the workspace is a folder inside a larger repository", { reason: ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT });
    return root;
  }

  /**
   * One git write of the workspace at a time, logged once git did it (with
   * what `fn` says of it), then the status after it. The lock goes however
   * git ends, at the latest at the write deadline.
   */
  private async write(id: string, device: string, action: AuditAction | undefined, fn: (root: string) => Promise<string>): Promise<WorkspaceStatus> {
    // Taken before anything is awaited: the first request in is the one that runs.
    if (this.writing.has(id)) throw new AgentError(ErrorCode.INVALID, "another git command of this workspace is running", { reason: ErrorReason.GIT_BUSY });
    this.writing.add(id);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let root: string;
    try {
      root = await this.gitRoot(id);
      const expired = new Promise<never>((_, fail) => {
        deadline = setTimeout(() => fail(gitError(ErrorReason.GIT_FAILED, "git took too long", "timeout")), WRITE_DEADLINE_MS());
        deadline.unref?.();
      });
      const count = await Promise.race([fn(root), expired]);
      if (action) this.opts.audit.write({ device, action, path: root, detail: count === "" ? `workspace ${id}` : `workspace ${id}: ${count}` });
    } finally {
      clearTimeout(deadline);
      this.writing.delete(id);
    }
    return this.statusOf(root);
  }
}

// A device's requests for a workspace's files and git (the right panel),
// over its sealed link: each answered later by id (git may take a while,
// and the frames after it go on meanwhile), and the workspaces it watches,
// whose changes it hears until it stops or its connection closes.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, type Frame, type FrameSchema, GitFileState, WsFileKind, WsGitArea, WsGitDiffSource } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import type { FileKind } from "../workspace/files.ts";
import type { DiffSource, LogEntry } from "../workspace/git-ops.ts";
import type { Area, FileState, StatusEntry, WorkspaceStatus } from "../workspace/git-status.ts";
import type { Workspaces } from "../workspace/workspaces.ts";
import { isDiskAccessDenial } from "../safety/disk-access.ts";
import { OutsideFolderError } from "../safety/session-files.ts";
import type { GitFileChange } from "../threads/git-changes.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

export type WorkspaceFrame = Extract<
  Frame["body"],
  {
    case:
      | "wsDirList"
      | "wsFileRead"
      | "wsFindNames"
      | "wsFindContents"
      | "wsWatch"
      | "wsGitStatus"
      | "wsGitDiff"
      | "wsGitStage"
      | "wsGitUnstage"
      | "wsGitDiscard"
      | "wsGitCommit"
      | "wsGitBranches"
      | "wsGitCheckout"
      | "wsGitBranchCreate"
      | "wsGitFetch"
      | "wsGitPull"
      | "wsGitPush"
      | "wsGitLog"
      | "wsGitBranchCompare"
      | "wsGitPrUrl";
  }
>;

const FILE_STATE: Record<FileState, GitFileState> = {
  modified: GitFileState.MODIFIED,
  added: GitFileState.ADDED,
  deleted: GitFileState.DELETED,
  renamed: GitFileState.RENAMED,
  typeChanged: GitFileState.TYPE_CHANGED,
  conflicted: GitFileState.CONFLICTED,
  untracked: GitFileState.UNTRACKED,
};

const AREA: Record<Area, WsGitArea> = {
  staged: WsGitArea.STAGED,
  unstaged: WsGitArea.UNSTAGED,
  untracked: WsGitArea.UNTRACKED,
  conflicted: WsGitArea.CONFLICTED,
};

const KIND: Record<FileKind, WsFileKind> = {
  text: WsFileKind.TEXT,
  image: WsFileKind.IMAGE,
  binary: WsFileKind.BINARY,
  tooLarge: WsFileKind.TOO_LARGE,
};

const DIFF_SOURCE: Partial<Record<WsGitDiffSource, DiffSource>> = {
  [WsGitDiffSource.UNSTAGED]: "unstaged",
  [WsGitDiffSource.STAGED]: "staged",
  [WsGitDiffSource.COMMIT]: "commit",
  [WsGitDiffSource.BRANCH]: "branch",
};

const DIFF_STATE: Record<GitFileChange["state"], GitFileState> = {
  modified: GitFileState.MODIFIED,
  added: GitFileState.ADDED,
  deleted: GitFileState.DELETED,
  untracked: GitFileState.UNTRACKED,
  typeChanged: GitFileState.TYPE_CHANGED,
  conflicted: GitFileState.CONFLICTED,
};

/** One file's diff as devices get it (a thread's changes and a workspace's diff alike). */
export function gitFileBody(f: GitFileChange) {
  return { path: f.path, state: DIFF_STATE[f.state], added: f.added, removed: f.removed, unified: f.unified, truncated: f.truncated, binary: f.binary, sensitive: f.sensitive };
}

function entryBody(e: StatusEntry) {
  return { path: e.path, oldPath: e.oldPath, area: AREA[e.area], state: FILE_STATE[e.state], added: e.added, removed: e.removed, binary: e.binary, sensitive: e.sensitive };
}

export function statusBody(workspaceId: string, s: WorkspaceStatus) {
  return {
    workspaceId,
    git: s.git,
    branch: s.branch,
    head: s.head,
    ...(s.upstream ? { upstream: s.upstream } : {}),
    entries: s.entries.map(entryBody),
    truncated: s.truncated,
  };
}

const logBody = (c: LogEntry) => ({ oid: c.oid, subject: c.subject, author: c.author, at: BigInt(c.at), refs: c.refs });

export class WorkspaceLink {
  /** Workspace id → stop watching, for this connection. */
  private readonly watches = new Map<string, () => void>();
  /** Watch requests of each workspace, applied one after another; the last one asked is what holds. */
  private readonly wanted = new Map<string, boolean>();
  private readonly watchQueue = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly workspaces: Workspaces,
    private readonly send: (id: string, body: Body) => void,
    private readonly device: () => string,
  ) {}

  close(): void {
    this.closed = true;
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
  }

  /** One request; a failure the file system gave comes without any of the machine's absolute paths. */
  async handle(id: string, b: WorkspaceFrame): Promise<void> {
    try {
      await this.dispatch(id, b);
    } catch (err) {
      throw publicError(err, "path" in b.value && typeof b.value.path === "string" ? b.value.path : "");
    }
  }

  private async dispatch(id: string, b: WorkspaceFrame): Promise<void> {
    const w = this.workspaces;
    const device = this.device();
    const status = (workspaceId: string, s: WorkspaceStatus) => this.send(id, { case: "wsGitStatusResult", value: statusBody(workspaceId, s) });
    switch (b.case) {
      case "wsDirList": {
        const v = b.value;
        const page = await w.dirList(v.workspaceId, v.path, { afterName: v.afterName, afterDir: v.afterDir, limit: v.limit, showHidden: v.showHidden, hideIgnored: v.hideIgnored });
        const entries = page.entries.map((e) => ({ ...e, size: BigInt(e.size), mtime: BigInt(e.mtime), git: e.git === "" ? GitFileState.UNSPECIFIED : FILE_STATE[e.git] }));
        return this.send(id, { case: "wsDirListResult", value: { workspaceId: v.workspaceId, path: page.path, entries, hasMore: page.hasMore, total: page.total } });
      }
      case "wsFileRead": {
        const v = b.value;
        const f = await w.fileRead(v.workspaceId, v.path);
        return this.send(id, {
          case: "wsFileReadResult",
          value: { workspaceId: v.workspaceId, path: v.path, kind: KIND[f.kind], size: BigInt(f.size), mtime: BigInt(f.mtime), mime: f.mime, text: f.text, data: f.data },
        });
      }
      case "wsFindNames": {
        const v = b.value;
        const r = await w.findNames(v.workspaceId, v.query, v.limit);
        return this.send(id, { case: "wsFindNamesResult", value: { workspaceId: v.workspaceId, ...r } });
      }
      case "wsFindContents": {
        const v = b.value;
        const r = await w.findContents(v.workspaceId, { query: v.query, caseSensitive: v.caseSensitive, wholeWord: v.wholeWord, regex: v.regex, limit: v.limit });
        return this.send(id, { case: "wsFindContentsResult", value: { workspaceId: v.workspaceId, ...r } });
      }
      case "wsWatch":
        await this.watch(b.value.workspaceId, b.value.on);
        return this.send(id, { case: "ack", value: {} });
      case "wsGitStatus":
        return status(b.value.workspaceId, await w.status(b.value.workspaceId));
      case "wsGitDiff": {
        const v = b.value;
        const source = DIFF_SOURCE[v.source];
        if (source === undefined) throw new AgentError(ErrorCode.INVALID, "no diff source", { reason: ErrorReason.UNSPECIFIED });
        const f = await w.diff(v.workspaceId, { path: v.path, oldPath: v.oldPath, source, commit: v.commit, base: v.base });
        return this.send(id, { case: "wsGitDiffResult", value: { workspaceId: v.workspaceId, file: gitFileBody(f) } });
      }
      case "wsGitStage":
        return status(b.value.workspaceId, await w.stage(b.value.workspaceId, b.value.paths, b.value.all, device, b.value.confirmSensitive));
      case "wsGitUnstage":
        return status(b.value.workspaceId, await w.unstage(b.value.workspaceId, b.value.paths, b.value.all, device));
      case "wsGitDiscard":
        return status(b.value.workspaceId, await w.discard(b.value.workspaceId, b.value.paths, b.value.confirm, device));
      case "wsGitCommit": {
        const v = b.value;
        const c = await w.commit(v.workspaceId, v.message, device, { allowDetached: v.allowDetached, confirmSensitive: v.confirmSensitive });
        return this.send(id, { case: "wsGitCommitResult", value: { workspaceId: b.value.workspaceId, commit: logBody(c) } });
      }
      case "wsGitBranches": {
        const r = await w.branches(b.value.workspaceId);
        return this.send(id, { case: "wsGitBranchesResult", value: { workspaceId: b.value.workspaceId, ...r } });
      }
      case "wsGitCheckout":
        return status(b.value.workspaceId, await w.checkout(b.value.workspaceId, b.value.branch, device));
      case "wsGitBranchCreate": {
        const v = b.value;
        return status(v.workspaceId, await w.branchCreate(v.workspaceId, v.name, v.startPoint, v.checkout, device));
      }
      case "wsGitFetch":
        return status(b.value.workspaceId, await w.fetch(b.value.workspaceId));
      case "wsGitPull":
        return status(b.value.workspaceId, await w.pull(b.value.workspaceId, device));
      case "wsGitPush":
        return status(b.value.workspaceId, await w.push(b.value.workspaceId, device));
      case "wsGitLog": {
        const v = b.value;
        const r = await w.log(v.workspaceId, v.ref, v.skip, v.limit);
        return this.send(id, { case: "wsGitLogResult", value: { workspaceId: v.workspaceId, commits: r.commits.map(logBody), hasMore: r.hasMore } });
      }
      case "wsGitBranchCompare": {
        const r = await w.branchCompare(b.value.workspaceId, b.value.base);
        return this.send(id, { case: "wsGitBranchCompareResult", value: { workspaceId: b.value.workspaceId, ...r, files: r.files.map(entryBody) } });
      }
      case "wsGitPrUrl": {
        const r = await w.prUrl(b.value.workspaceId, b.value.base);
        return this.send(id, { case: "wsGitPrUrlResult", value: { workspaceId: b.value.workspaceId, ...r } });
      }
    }
  }

  /** Asks for the workspace watched or not; requests apply in order, so an "off" sent while an "on" starts is not lost. */
  private watch(workspaceId: string, on: boolean): Promise<void> {
    this.wanted.set(workspaceId, on);
    const previous = this.watchQueue.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.applyWatch(workspaceId));
    this.watchQueue.set(workspaceId, next);
    return next;
  }

  private async applyWatch(workspaceId: string): Promise<void> {
    const want = this.wanted.get(workspaceId) === true && !this.closed;
    const current = this.watches.get(workspaceId);
    if (!want) {
      current?.();
      this.watches.delete(workspaceId);
      return;
    }
    if (current) return;
    const stop = await this.workspaces.watch(workspaceId, (change) => this.send("", { case: "wsChanged", value: { workspaceId, ...change } }));
    // The connection closed meanwhile.
    if (this.closed) return stop();
    this.watches.set(workspaceId, stop);
  }
}

/**
 * What a device gets for a failed workspace request: the agent's own errors
 * as they are (their messages are fixed and name relative paths only), and
 * a file system error as a fixed message naming the request's relative path,
 * never the absolute path the system put in its message.
 */
export function publicError(err: unknown, rel: string): unknown {
  if (err instanceof AgentError || err instanceof OutsideFolderError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return new AgentError(ErrorCode.INTERNAL, "the workspace request failed", { reason: ErrorReason.UNSPECIFIED });
  if (code === "ENOENT") return new AgentError(ErrorCode.INVALID, "no such file or folder", { reason: ErrorReason.FOLDER_NOT_FOUND, subject: rel });
  if (code === "ENOTDIR") return new AgentError(ErrorCode.INVALID, "not a folder", { reason: ErrorReason.FOLDER_NOT_FOUND, subject: rel });
  if (isDiskAccessDenial(err)) return new AgentError(ErrorCode.INVALID, "the system refused access", { reason: ErrorReason.FULL_DISK_ACCESS_NEEDED, subject: rel });
  if (code === "EACCES" || code === "EPERM") return new AgentError(ErrorCode.INVALID, "the system refused access", { reason: ErrorReason.ACCESS_DENIED, subject: rel });
  if (code === "ELOOP") return new AgentError(ErrorCode.INVALID, "too many links", { reason: ErrorReason.UNSPECIFIED, subject: rel });
  return new AgentError(ErrorCode.INVALID, `the file system refused (${code.slice(0, 20)})`, { reason: ErrorReason.UNSPECIFIED, subject: rel });
}

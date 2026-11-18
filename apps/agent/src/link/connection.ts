// One WebSocket from one device: the handshake first (only a device key the
// owner's account lists gets in, device-trust.ts), then sealed frames
// dispatched to the core.
import { resolve } from "node:path";
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  ErrorReason,
  type Frame,
  FrameSchema,
  HandshakeErrorCode,
  type Item,
  type MachineInfo,
  type ProjectConfigLevel,
  type AdvisorAttachment,
  AdvisorTone,
  TermPath,
  ThreadKind,
  type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import { type KeyPair, type Session, acceptHello, decodePlain, encodeHandshakeError } from "@achoo254/chat-remote-protocol";
import { AgentError, type AgentCore } from "../core/agent-core.ts";
import { type AgentUpdater, UpdateBusy, UpdateUnavailable } from "../agent-updater.ts";
import { AttachmentError } from "../attachments/uploads.ts";
import { AdvisorKeyError, type AdvisorKeyStore, rememberAdvisorKey } from "../advisor/advisor-key-store.ts";
import type { AdvisorAttachmentInput, AdvisorToneInput } from "../advisor/advisor-thread.ts";
import { redactSecrets } from "../mcp/redact.ts";
import { type ConfigStore, deviceLabel } from "../config.ts";
import type { TrustVerdict } from "../device-trust.ts";
import { AccountError } from "../accounts/errors.ts";
import type { AgentProvider } from "../providers/types.ts";
import { ACCOUNT_REASONS, accountListBody, accountsOf, readAccounts } from "./accounts-link.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import type { LocalForward } from "../tunnels/forward.ts";
import { listDir } from "../safety/dirs.ts";
import { homedir } from "node:os";
import { MacFolderRefused, type MacFolders } from "../safety/mac-folders.ts";
import { OutsideFolderError, listSessionFiles } from "../safety/session-files.ts";
import type { ProjectList, Projects } from "../projects/projects.ts";
import { SecretInputError } from "../sign-in-secrets/secret-names.ts";
import type { SavedSecretInfo } from "../sign-in-secrets/secret-store.ts";
import { type SecretEvent, SecretNotFound, SecretPromptGone, type SecretService } from "../sign-in-secrets/secret-service.ts";
import type { GitChangesResult } from "../threads/git-changes.ts";
import { InputError } from "../remote-browser/browser-input.ts";
import { BrowserNotRunning, BrowserToolError, BrowserUnavailable, type RemoteBrowser, TakeoverGone } from "../remote-browser/remote-browser.ts";
import { type BrowserFrame, BrowserLink } from "./browser-link.ts";
import { ScreenShareBusy, ScreenShareGone, type ScreenShare, ScreenSharingOff } from "../screen-share/screen-share.ts";
import { ScreenShareLink } from "./screen-share-link.ts";
import { wireItem } from "./wire.ts";
import type { TerminalConnection } from "../terminal/terminal-connection.ts";
import type { TerminalService } from "../terminal/terminal-service.ts";
import type { CommitMessageRequest } from "../workspace/commit-message.ts";
import type { Workspaces } from "../workspace/workspaces.ts";
import { type WorkspaceFrame, WorkspaceLink, gitFileBody } from "./workspace-link.ts";
import { type UsageApi, type UsageFrame, handleUsage } from "./usage-link.ts";
import { LedgerUnreadable } from "../usage/ledger.ts";
import { type OfficeHub, type OfficeSink, officeHubFor } from "../office/office-hub.ts";
import { ReportRangeError } from "../usage/report.ts";

export type Socket = {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued and not yet sent (a busy device skips browser pictures). */
  buffered?(): number;
};

export type LinkContext = {
  core: AgentCore;
  config: ConfigStore;
  audit: AuditLog;
  /** The machine's static key pair. */
  machineKey: () => KeyPair;
  /** Whether a device key may shake hands; asks Chat about a key it does not know yet (device-trust.ts). */
  trust: { check(key: Uint8Array): Promise<TrustVerdict> };
  /** A handshake was refused, for the machine's log. */
  onRefused?: (deviceKey: Uint8Array, verdict: TrustVerdict) => void;
  machineInfo: () => Promise<MachineInfo>;
  isSensitive: (p: string) => boolean;
  /** A device is looking at the machine (for push decisions). */
  onPing: () => void;
  /** The machine's AIs; those with accounts answer AccountList and the requests beside it. */
  providers?: readonly AgentProvider[];
  /** The machine's projects; absent where the machine has none (tests). */
  projects?: Projects;
  /** Localman's requests for localhost; absent where the machine has none (tests). */
  localForward?: LocalForward;
  /** Sign-in secrets Claude asks the user for; absent where the machine has none (tests). */
  secrets?: SecretService;
  /** The tunelo browser the user may take over; absent where the machine has none (tests). */
  browser?: RemoteBrowser;
  /** The machine's own Screen Sharing (macOS); absent where the machine has none (tests). */
  screenShare?: ScreenShare;
  /** macOS: the folders macOS protects (safety/mac-folders.ts); absent where the machine has none (tests). */
  macFolders?: MacFolders;
  /** Updates tunelo for a device; absent where the machine has none (tests). */
  updater?: AgentUpdater;
  /** The machine's terminal; absent where the machine has none (tests). */
  terminal?: TerminalService;
  /** Workspaces' files and git for the right panel; absent where the machine has none (tests). */
  workspaces?: Workspaces;
  /** An AI of the machine writes a commit message for a workspace; absent where the machine has none (tests). */
  commitMessage?: (req: CommitMessageRequest) => Promise<string>;
  /** The AIs' token usage on the machine; absent where the machine keeps none (tests). */
  usage?: UsageApi;
  /** Advisor's TypeSafe key on the machine; absent where the machine has no Advisor (tests). */
  advisorKeys?: AdvisorKeyStore;
  /** Advisor's key was set or removed: every device hears the machine's info again. */
  onAdvisorKey?: () => void;
};

/** What a device gets for a failed request: a class, a stable reason to word it, and English for the rest. */
export function errorBody(err: unknown): { code: ErrorCode; message: string; reason: ErrorReason; subject: string; failureId?: string } {
  // No secret this process holds (a sign-in secret, Advisor's key) ever leaves in an error, whatever it echoes.
  const message = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
  if (err instanceof AdvisorKeyError) {
    return err.kind === "invalid"
      ? { code: ErrorCode.INVALID, message, reason: ErrorReason.ADVISOR_KEY_INVALID, subject: "" }
      : { code: ErrorCode.INTERNAL, message, reason: ErrorReason.ADVISOR_KEY_NOT_SAVED, subject: "" };
  }
  if (err instanceof MacFolderRefused) return { code: ErrorCode.INVALID, message, reason: ErrorReason.MAC_FOLDER_ACCESS, subject: err.folder };
  if (err instanceof AgentError) return { code: err.code, message, reason: err.reason, subject: err.subject, ...(err.failureId ? { failureId: err.failureId } : {}) };
  if (err instanceof AccountError) return { code: ErrorCode.INVALID, message, reason: ACCOUNT_REASONS[err.kind], subject: err.subject };
  if (err instanceof AttachmentError) return { code: ErrorCode.INVALID, message, reason: err.reason, subject: err.subject };
  if (err instanceof OutsideFolderError) return { code: ErrorCode.INVALID, message, reason: ErrorReason.PATH_OUTSIDE_FOLDER, subject: "" };
  if (err instanceof SecretPromptGone) return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.SECRET_PROMPT_GONE, subject: "" };
  if (err instanceof SecretNotFound) return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.SECRET_NOT_FOUND, subject: "" };
  if (err instanceof SecretInputError) return { code: ErrorCode.INVALID, message, reason: ErrorReason.SECRET_INVALID, subject: "" };
  if (err instanceof TakeoverGone) return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.TAKEOVER_GONE, subject: "" };
  if (err instanceof BrowserNotRunning) return { code: ErrorCode.INVALID, message, reason: ErrorReason.BROWSER_NOT_RUNNING, subject: "" };
  if (err instanceof BrowserUnavailable) return { code: ErrorCode.INVALID, message, reason: ErrorReason.BROWSER_UNAVAILABLE, subject: "" };
  if (err instanceof ScreenSharingOff) return { code: ErrorCode.INVALID, message, reason: ErrorReason.SCREEN_SHARING_OFF, subject: "" };
  if (err instanceof ScreenShareBusy) return { code: ErrorCode.INVALID, message, reason: ErrorReason.SCREEN_SHARE_BUSY, subject: "" };
  if (err instanceof UpdateUnavailable) return { code: ErrorCode.INVALID, message, reason: ErrorReason.UPDATE_UNAVAILABLE, subject: "" };
  if (err instanceof UpdateBusy) return { code: ErrorCode.INVALID, message, reason: ErrorReason.UPDATE_BUSY, subject: "" };
  if (err instanceof ScreenShareGone) return { code: ErrorCode.NOT_FOUND, message, reason: ErrorReason.SCREEN_SHARE_GONE, subject: "" };
  if (err instanceof ReportRangeError) return { code: ErrorCode.INVALID, message, reason: ErrorReason.USAGE_RANGE_INVALID, subject: "" };
  if (err instanceof LedgerUnreadable) return { code: ErrorCode.INVALID, message, reason: ErrorReason.USAGE_LEDGER_BLOCKED, subject: "" };
  if (err instanceof InputError || err instanceof BrowserToolError) return { code: ErrorCode.INVALID, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
  if (isFsError(err)) {
    const fsCode = (err as { code: string }).code;
    const reason =
      fsCode === "ENOENT" || fsCode === "ENOTDIR"
        ? ErrorReason.FOLDER_NOT_FOUND
        : fsCode === "EACCES" || fsCode === "EPERM"
          ? ErrorReason.ACCESS_DENIED
          : ErrorReason.UNSPECIFIED;
    return { code: ErrorCode.INVALID, message, reason, subject: "" };
  }
  return { code: ErrorCode.INTERNAL, message, reason: ErrorReason.UNSPECIFIED, subject: "" };
}

/** Bytes waiting on a device's socket over which its office events are dropped (it sees a gap in seq and asks for a snapshot). */
const OFFICE_BUFFERED_MAX = 1024 * 1024;

/** How often a followed thread's transcript is looked at for turns typed outside Chat. */
const FOLLOW_MS = 1_500;

const refusal = (message: string, reason: ErrorReason) => ({ code: ErrorCode.INVALID, message, reason, subject: "" });

/** A thread's uncommitted changes as devices get them (only over the sealed link). */
export function gitChangesBody(threadId: string, r: GitChangesResult) {
  return { threadId, git: r.git, files: r.files.map(gitFileBody), truncated: r.truncated, partial: r.partial };
}

/** The saved secrets as devices get them: never a value. */
export function secretListBody(list: readonly SavedSecretInfo[]) {
  return {
    secrets: list.map((s) => ({ id: s.id, name: s.name, origin: s.origin, createdAt: BigInt(s.createdAt), lastUsedAt: BigInt(s.lastUsedAt) })),
  };
}

/** The projects as devices get them. */
/** `levelOf`: the folder's project configuration level (AgentCore.projectConfig); unset sends none. */
export function projectListBody(list: ProjectList, levelOf?: (dir: string) => ProjectConfigLevel) {
  return {
    projects: list.projects.map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      pinned: p.pinned,
      defaults: p.defaults,
      missing: p.missing,
      sensitive: p.sensitive,
      ...(p.git ? { git: p.git } : {}),
      gitRemote: p.gitRemote ?? "",
      ...(levelOf ? { projectConfig: levelOf(p.dir) } : {}),
    })),
    suggestions: list.suggestions.map((s) => ({ dir: s.dir, sessions: s.sessions, gitRemote: s.gitRemote ?? "", branch: s.branch ?? "" })),
  };
}

const KEY_LENGTH = 32;

/** The style a device picked for Advisor's answer; "" for none or a value this machine does not know (ignored). */
export function advisorToneOf(tone: AdvisorTone): AdvisorToneInput {
  switch (tone) {
    case AdvisorTone.SHORT:
      return "short";
    case AdvisorTone.FUN:
      return "fun";
    case AdvisorTone.SERIOUS:
      return "serious";
    default:
      return "";
  }
}

/** An attachment of a question to Advisor as the core takes it. */
function advisorAttachment(a: AdvisorAttachment): AdvisorAttachmentInput {
  const c = a.context;
  return {
    text: a.text,
    ...(c
      ? { context: { screen: c.screen, dir: c.dir, branch: c.branch, threadId: c.threadId, panel: c.panel, action: c.action, errorCode: c.errorCode, failureId: c.failureId } }
      : {}),
  };
}

export class Connection {
  // "confirming": the handshake answered, but the device has not yet proven
  // its key with a first valid frame; it holds no session until then.
  private state: "new" | "confirming" | "open" | "closed" = "new";
  /** Last time any message arrived, for the idle timeout. */
  lastSeen = Date.now();
  private session: Session | undefined;
  private device = "";
  private subscribed = new Set<string>();
  /**
   * The device knows Advisor's threads (ThreadList.advisor, or it opened or
   * followed one): they are listed for it and their status reaches it. A
   * device that never says so never hears of them.
   */
  private advisorAware = false;
  /** The tail this device last asked for (ThreadSubscribe.tail): it pages older items itself. 0: it takes everything. */
  private tail = 0;
  /** Looks at the transcripts of the threads this device follows, for turns typed outside Chat. */
  private followTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void)[] = [];
  private queue: Promise<void> = Promise.resolve();
  private browserLink: BrowserLink | undefined;
  private screenShareLink: ScreenShareLink | undefined;
  private terminal: TerminalConnection | undefined;
  private workspaceLink: WorkspaceLink | undefined;
  /** The machine's offices (OfficeWatch), and where this connection gets the events of those it watches. */
  private office: OfficeHub | undefined;
  private readonly officeSink: OfficeSink = (events) => {
    if ((this.socket.buffered?.() ?? 0) > OFFICE_BUFFERED_MAX) return;
    this.send("", { case: "officeEvents", value: events });
  };
  /** Messages queued before the link opened, not yet opened (decrypted). */
  private rawPending = 0;
  readonly opened = Date.now();

  constructor(
    private readonly socket: Socket,
    private readonly ctx: LinkContext,
  ) {}

  get isOpen(): boolean {
    return this.state === "open";
  }

  get deviceKey(): Uint8Array | undefined {
    return this.session?.peerStatic;
  }

  /**
   * Requests are handled one at a time, in order. Once the link is open,
   * every message is opened here as it arrives (the session's counter needs
   * arrival order), so a terminal frame goes straight to the terminal and
   * never waits behind a slow request; the rest still queue in order.
   */
  receive(data: Uint8Array): void {
    this.lastSeen = Date.now();
    const session = this.session;
    if (this.state === "open" && this.rawPending === 0 && session) {
      let f: Frame;
      try {
        f = session.open(data);
      } catch {
        return this.close(1008, "protocol error");
      }
      if (f.body.case === "termData") return this.termData(f.body.value);
      // Advisor's key is hidden from every output from the moment it arrives, before it waits in the queue.
      if (f.body.case === "advisorSetKey") rememberAdvisorKey(f.body.value.key);
      this.queue = this.queue.then(() => (this.state === "closed" ? undefined : this.frame(f))).catch(() => this.close(1008, "protocol error"));
      return;
    }
    this.rawPending++;
    this.queue = this.queue
      .then(() => {
        this.rawPending--;
        return this.handle(data);
      })
      .catch(() => this.close(1008, "protocol error"));
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearInterval(this.followTimer);
    for (const u of this.unsubscribe) u();
    this.browserLink?.close();
    this.screenShareLink?.close();
    if (this.terminal) this.ctx.terminal?.forget(this.terminal);
    this.workspaceLink?.close();
    this.office?.forget(this.officeSink);
    this.socket.close(code, reason);
  }

  /** One terminal frame of the relay path: handed on at once (never behind the queue). */
  private termData(v: Extract<Frame["body"], { case: "termData" }>["value"]): void {
    if (this.terminal) return this.terminal.data(v);
    this.send("", { case: "termStatus", value: { link: v.link, path: TermPath.CLOSED, reason: "unavailable" } });
  }

  private async handle(data: Uint8Array): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") return this.frame(this.session?.open(data));
    if (this.state === "confirming") {
      const first = this.session?.open(data); // throws on a forged frame
      this.confirmed();
      return this.frame(first);
    }
    const body = decodePlain(data).body;
    if (body.case !== "hello") throw new Error("expected hello");
    const hello = body.value;
    // Only a well-formed hello may make the machine ask Chat about its key;
    // acceptHello refuses the rest as malformed.
    const wellFormed = hello.staticKey.length === KEY_LENGTH && hello.ephemeralKey.length === KEY_LENGTH && hello.nonce.length === KEY_LENGTH;
    const verdict: TrustVerdict = wellFormed ? await this.ctx.trust.check(hello.staticKey) : "unknown";
    if (this.isClosed) return;
    if (verdict === "stale") {
      // The list of trusted devices is too old to stand in for Chat: try later.
      this.ctx.onRefused?.(hello.staticKey, verdict);
      this.socket.send(encodeHandshakeError(HandshakeErrorCode.BUSY));
      return this.close(1000, "this machine has not reached Chat for over 24 hours");
    }
    const result = await acceptHello(data, { machine: this.ctx.machineKey(), deviceStatus: () => verdict });
    this.socket.send(result.reply);
    if (!result.ok) {
      if (wellFormed) this.ctx.onRefused?.(hello.staticKey, verdict);
      return this.close(1000, "handshake refused");
    }
    this.session = result.session;
    this.device = deviceLabel(result.deviceKey, this.ctx.config.deviceName(result.deviceKey));
    this.state = "confirming";
  }

  private get isClosed(): boolean {
    return this.state === "closed";
  }

  /** The device proved its key: serve it. */
  private confirmed(): void {
    if (!this.session) throw new Error("no session");
    this.state = "open";
    this.followTimer = setInterval(() => {
      for (const threadId of this.subscribed) this.ctx.core.followHistory(threadId);
    }, FOLLOW_MS);
    this.followTimer.unref?.();
    this.unsubscribe.push(
      this.ctx.core.onItems((threadId, items) => {
        if (this.subscribed.has(threadId)) this.sendItems(threadId, items);
      }),
      this.ctx.core.onStatus((thread) => {
        if (thread.kind === ThreadKind.ADVISOR && !this.advisorAware) return;
        this.send("", { case: "threadStatus", value: { thread } });
      }),
      this.ctx.core.onActivity((activity) => {
        if (this.subscribed.has(activity.threadId)) this.send("", { case: "threadActivity", value: activity });
      }),
      this.ctx.core.onInfo((threadId) => {
        if (this.subscribed.has(threadId)) this.sendInfo(threadId);
      }),
      this.ctx.core.onDeleted((threadId, trashed) => {
        this.subscribed.delete(threadId);
        this.send("", { case: "threadDeleted", value: { threadId, trashed } });
      }),
      // A turn may have changed files: devices following the thread get its git changes unasked.
      this.ctx.core.onTurnEnd((threadId) => {
        if (this.subscribed.has(threadId)) void this.pushGitChanges(threadId);
      }),
    );
    this.office = officeHubFor(this.ctx.core, this.ctx.providers ?? []);
    this.unsubscribe.push(this.office.attach());
    const secrets = this.ctx.secrets;
    if (secrets) {
      this.unsubscribe.push(secrets.onEvent((event) => this.secretEvent(event)));
      for (const prompt of secrets.openPrompts()) this.secretEvent({ type: "prompt", prompt });
    }
    const browser = this.ctx.browser;
    if (browser) {
      this.browserLink = new BrowserLink(
        browser,
        (id, body) => this.send(id, body),
        (id, err) => this.sendError(id, err),
        () => this.socket.buffered?.() ?? 0,
        () => this.device,
        () => this.ctx.machineInfo(),
      );
      this.unsubscribe.push(this.browserLink.subscribe());
    }
    if (this.ctx.screenShare?.supported) {
      this.screenShareLink = new ScreenShareLink(
        this.ctx.screenShare,
        (id, body) => this.send(id, body),
        (id, err) => this.sendError(id, err),
        () => this.socket.buffered?.() ?? 0,
        () => this.device,
      );
    }
    if (this.ctx.workspaces) this.workspaceLink = new WorkspaceLink(this.ctx.workspaces, (id, body) => this.send(id, body), () => this.device, this.ctx.commitMessage);
    if (this.ctx.terminal) {
      this.terminal = this.ctx.terminal.connection({
        send: (id, body) => this.send(id, body),
        buffered: () => this.socket.buffered?.() ?? 0,
        deviceKey: () => this.session?.peerStatic,
      });
    }
  }

  private async pushGitChanges(threadId: string): Promise<void> {
    try {
      const r = await this.ctx.core.gitChanges(threadId);
      if (this.subscribed.has(threadId)) this.send("", { case: "gitChanges", value: gitChangesBody(threadId, r) });
    } catch {
      // the thread went away meanwhile
    }
  }

  /** A prompt for a secret opened or closed: every device hears it, outside any thread's journal. */
  private secretEvent(event: SecretEvent): void {
    if (event.type === "ended") return this.send("", { case: "secretPromptEnded", value: { requestId: event.requestId } });
    const p = event.prompt;
    this.send("", {
      case: "secretPrompt",
      value: { requestId: p.requestId, threadId: p.threadId, name: p.name, purpose: p.purpose, origin: p.origin, expiresAt: BigInt(p.expiresAt) },
    });
  }

  /** Secrets: the value arrives only here, sealed end to end, and goes straight to the store; it is never logged or echoed. */
  private async secretFrame(id: string, b: SecretFrame): Promise<void> {
    const secrets = this.ctx.secrets;
    if (!secrets) return this.send(id, { case: "error", value: refusal("this machine keeps no secrets", ErrorReason.UNSUPPORTED_REQUEST) });
    switch (b.case) {
      case "secretProvide":
        await secrets.provide(b.value.requestId, b.value.value, b.value.remember, this.device);
        return this.send(id, { case: "ack", value: {} });
      case "secretDecline":
        secrets.decline(b.value.requestId);
        return this.send(id, { case: "ack", value: {} });
      case "secretList":
        return this.send(id, { case: "secretListResult", value: secretListBody(secrets.list()) });
      case "secretRemove":
        return this.send(id, { case: "secretListResult", value: secretListBody(secrets.remove(b.value.id, this.device)) });
    }
  }

  /** Advisor's key: it arrives only here, sealed end to end, and goes straight to its own store; it is never logged or echoed. */
  private async advisorFrame(id: string, b: AdvisorFrame): Promise<void> {
    const keys = this.ctx.advisorKeys;
    if (!keys) return this.send(id, { case: "error", value: refusal("this machine has no Advisor", ErrorReason.UNSUPPORTED_REQUEST) });
    if (b.case === "advisorSetKey") await keys.set(b.value.key, this.device);
    else await keys.remove(this.device);
    this.send(id, { case: "ack", value: {} });
    this.ctx.onAdvisorKey?.();
  }

  /** This device follows the thread now (it subscribed on this link). */
  follows(threadId: string): boolean {
    return this.state === "open" && this.subscribed.has(threadId);
  }

  /** An event every device gets unasked (the machine's profile and where each session stands). */
  announce(body: NonNullable<MessageInitShape<typeof FrameSchema>["body"]>): void {
    this.send("", body);
  }

  private send(id: string, body: NonNullable<MessageInitShape<typeof FrameSchema>["body"]>): void {
    if (this.state !== "open" || !this.session) return;
    this.socket.send(this.session.seal(create(FrameSchema, { id, body })));
  }

  private sendInfo(threadId: string): void {
    this.send("", { case: "threadInfo", value: this.ctx.core.info(threadId) });
  }

  private sendItems(threadId: string, items: Item[], id = "", earlier = ""): void {
    const cursor = { epoch: this.ctx.core.epoch, seq: this.ctx.core.lastSeq(threadId) };
    this.send(id, { case: "threadItems", value: { threadId, items: items.map(wireItem), cursor, earlier } });
  }

  /** Every AI's accounts: a sign-in code is handed to the AI's CLI and dropped, never kept or logged. */
  private async accountFrame(id: string, b: AccountFrame): Promise<void> {
    const providers = this.ctx.providers ?? [];
    const sendList = async () => this.send(id, { case: "accountListResult", value: accountListBody(await readAccounts(providers, (f) => f.list())) });
    switch (b.case) {
      case "accountList":
        return sendList();
      case "accountSelect":
        await accountsOf(providers, b.value.provider).select(b.value.id, this.device);
        return sendList();
      case "accountSignInBegin": {
        const signIn = accountsOf(providers, b.value.provider).signIn;
        if (!signIn) return this.send(id, { case: "error", value: refusal("this AI does not sign in from a device", ErrorReason.UNSUPPORTED_REQUEST) });
        const r = await signIn.begin();
        if (!r.ok) return this.send(id, { case: "accountSignInResult", value: { provider: b.value.provider, ok: false, error: r.error } });
        return this.send(id, { case: "accountSignInPrompt", value: { provider: b.value.provider, attemptId: r.attemptId, url: r.url, expiresAt: BigInt(r.expiresAt) } });
      }
      case "accountSignInCode": {
        const signIn = accountsOf(providers, b.value.provider).signIn;
        if (!signIn) return this.send(id, { case: "error", value: refusal("this AI does not sign in from a device", ErrorReason.UNSUPPORTED_REQUEST) });
        const r = await signIn.code(b.value.attemptId, b.value.code);
        const value = r.ok ? { provider: b.value.provider, ok: true, id: r.id, email: r.email, organization: r.organization } : { provider: b.value.provider, ok: false, error: r.error };
        return this.send(id, { case: "accountSignInResult", value });
      }
      case "accountSignInCancel":
        await accountsOf(providers, b.value.provider).signIn?.cancel(b.value.attemptId);
        return this.send(id, { case: "ack", value: {} });
      case "accountRemove":
        await accountsOf(providers, b.value.provider).remove(b.value.id, this.device);
        return sendList();
      case "accountCaptureCurrent": {
        const accounts = accountsOf(providers, b.value.provider);
        if (!accounts.captureCurrent) return this.send(id, { case: "error", value: refusal("this AI cannot keep its current sign-in", ErrorReason.UNSUPPORTED_REQUEST) });
        await accounts.captureCurrent(this.device);
        return sendList();
      }
      case "accountAcceptCurrent": {
        const accounts = accountsOf(providers, b.value.provider);
        if (!accounts.acceptCurrent) return this.send(id, { case: "error", value: refusal("this AI does not keep a changed sign-in", ErrorReason.UNSUPPORTED_REQUEST) });
        await accounts.acceptCurrent(b.value.id, this.device);
        return sendList();
      }
      case "usageRefresh": {
        const accounts = accountsOf(providers, b.value.provider);
        if (!accounts.refreshUsage) return this.send(id, { case: "error", value: refusal("this AI cannot read its usage outside a session", ErrorReason.UNSUPPORTED_REQUEST) });
        await accounts.refreshUsage(b.value.id);
        return sendList();
      }
    }
  }

  /** Projects: git may take a moment (status, init, a clone's start), so they answer later, by id. */
  private async projectFrame(id: string, b: ProjectFrame): Promise<void> {
    const projects = this.ctx.projects;
    if (!projects) return this.send(id, { case: "error", value: refusal("this machine keeps no projects", ErrorReason.UNSUPPORTED_REQUEST) });
    const levelOf = (dir: string) => this.ctx.core.projectConfig(dir);
    const sendList = async () => this.send(id, { case: "projectListResult", value: projectListBody(await projects.list(), levelOf) });
    switch (b.case) {
      case "projectList":
        return sendList();
      case "projectAdd":
        this.ctx.macFolders?.assert(b.value.dir);
        projects.add({ dir: b.value.dir, name: b.value.name, sensitive: Boolean(b.value.consent?.sensitive), device: this.device });
        return sendList();
      case "projectCreate":
        this.ctx.macFolders?.assert(b.value.parent);
        await projects.create({ parent: b.value.parent, name: b.value.name, gitInit: b.value.gitInit });
        return sendList();
      case "projectClone":
        this.ctx.macFolders?.assert(b.value.parent);
        projects.clone({ url: b.value.url, parent: b.value.parent, name: b.value.name, cloneId: b.value.cloneId }, (p) =>
          this.send("", { case: "projectCloneProgress", value: p }),
        );
        return this.send(id, { case: "ack", value: {} });
      case "projectCloneCancel":
        projects.cancelClone(b.value.cloneId);
        return this.send(id, { case: "ack", value: {} });
      case "projectUpdate": {
        const v = b.value;
        const d = v.defaults;
        projects.update(
          {
            id: v.id,
            ...(v.name !== undefined ? { name: v.name } : {}),
            ...(v.pinned !== undefined ? { pinned: v.pinned } : {}),
            ...(d ? { defaults: { provider: d.provider, model: d.model, permissionMode: d.permissionMode, effort: d.effort, sessionMode: d.sessionMode, projectSettings: d.projectSettings } } : {}),
          },
          (provider) => this.ctx.core.aiLimits(provider),
        );
        return sendList();
      }
      case "projectReorder":
        projects.reorder(b.value.ids);
        return sendList();
      case "projectRemove":
        projects.remove(b.value.id);
        return sendList();
    }
  }

  private async frame(f: Frame | undefined): Promise<void> {
    if (!f) return;
    const { core } = this.ctx;
    const id = f.id;
    const ack = () => this.send(id, { case: "ack", value: {} });
    try {
      const b = f.body;
      switch (b.case) {
        case "ping":
          this.ctx.onPing();
          return this.send(id, { case: "pong", value: {} });
        case "machineInfoRequest":
          return this.send(id, { case: "machineInfo", value: await this.ctx.machineInfo() });
        case "openDiskAccessSettings":
          // tunelo no longer asks for Full Disk Access: a device asks for each protected folder (macFolderAccessAsk).
          return this.send(id, { case: "error", value: refusal("tunelo does not ask for Full Disk Access", ErrorReason.UNSUPPORTED_REQUEST) });
        case "macFolderAccessAsk": {
          const folders = this.ctx.macFolders;
          if (!folders || process.platform !== "darwin") {
            return this.send(id, { case: "error", value: refusal("only a Mac protects folders", ErrorReason.UNSUPPORTED_REQUEST) });
          }
          if (!folders.ask(b.value.path)) {
            return this.send(id, { case: "error", value: { ...refusal("not a folder macOS protects", ErrorReason.FOLDER_NOT_FOUND), subject: b.value.path } });
          }
          this.ctx.audit.write({ device: this.device, action: "mac_folder_access", path: b.value.path, detail: "ask" });
          return ack();
        }
        case "machineSettingsSet": {
          const forward = this.ctx.localForward;
          if (b.value.localForward !== undefined) {
            if (!forward) {
              return this.send(id, { case: "error", value: refusal("this machine does not forward to localhost", ErrorReason.NO_LOCAL_FORWARD) });
            }
            await forward.setEnabled(b.value.localForward, this.device);
          }
          return this.send(id, { case: "machineInfo", value: await this.ctx.machineInfo() });
        }
        case "threadList": {
          if (b.value.advisor) this.advisorAware = true;
          const threads = this.advisorAware ? core.list() : core.list().filter((t) => t.kind !== ThreadKind.ADVISOR);
          return this.send(id, {
            case: "threadListResult",
            value: { threads, openSessions: core.openSessions(), maxSessions: core.limit },
          });
        }
        case "threadCreate": {
          const v = b.value;
          if (v.kind === ThreadKind.ADVISOR) {
            this.advisorAware = true;
            const thread = await core.createAdvisor({ provider: v.provider, model: v.model, dir: v.dir, consent: { sensitive: Boolean(v.consent?.sensitive) }, device: this.device });
            // The thread may hold earlier questions: the device gets all of it.
            return this.openedThread(id, thread, false);
          }
          const thread: ThreadSummary = await core.create({
            provider: v.provider,
            model: v.model,
            dir: v.dir,
            text: v.text,
            permissionMode: v.permissionMode,
            effort: v.effort,
            consent: {
              sensitive: Boolean(v.consent?.sensitive),
              projectSettings: Boolean(v.consent?.projectSettings),
              trustProject: Boolean(v.consent?.trustProject),
            },
            device: this.device,
          });
          return this.openedThread(id, thread);
        }
        case "sessionList": {
          const v = b.value;
          const page = await core.localSessions({ provider: v.provider, dir: v.dir, query: v.query, offset: v.offset, limit: v.limit });
          const sessions = page.sessions.map((x) => ({
            sessionId: x.sessionId,
            dir: x.dir,
            title: x.title,
            updatedAt: BigInt(x.updatedAt),
            messages: x.messages,
            entrypoint: x.entrypoint,
            threadId: x.threadId,
            busyElsewhere: x.busyElsewhere,
            sensitive: x.sensitive,
          }));
          return this.send(id, { case: "sessionListResult", value: { sessions, total: page.total, dirs: page.dirs } });
        }
        case "sessionOpen": {
          const v = b.value;
          const known = new Set(core.list().map((x) => x.id));
          const thread = await core.openLocal({
            provider: v.provider,
            sessionId: v.sessionId,
            consent: {
              sensitive: Boolean(v.consent?.sensitive),
              projectSettings: Boolean(v.consent?.projectSettings),
              trustProject: Boolean(v.consent?.trustProject),
            },
            openAnyway: v.openAnyway,
            device: this.device,
          });
          // A session a thread holds already gives that thread: the device may hold part of it, so it gets everything.
          return this.openedThread(id, thread, !known.has(thread.id));
        }
        case "threadSubscribe": {
          const { threadId, cursor, tail } = b.value;
          if (tail > 0) this.tail = tail;
          if (core.isAdvisorThread(threadId)) this.advisorAware = true;
          const r = core.subscribe(threadId, cursor, tail);
          this.subscribed.add(threadId);
          this.sendInfo(threadId);
          if (r.resume.kind === "reset") {
            this.send(id, { case: "threadReset", value: { threadId, reason: r.resume.reason } });
            const page = tail > 0 ? core.tailSnapshot(threadId, tail) : { items: core.snapshot(threadId), earlier: "" };
            this.sendItems(threadId, page.items, id, page.earlier);
          } else this.sendItems(threadId, r.items, id, r.earlier);
          // A turn already running: what it does now, without waiting for its next change.
          const activity = core.activity(threadId);
          if (activity) this.send("", { case: "threadActivity", value: activity });
          return;
        }
        case "threadSend":
          // `/clear` alone starts a fresh thread, answered like ThreadCreate: the device moves to it.
          if (b.value.text.trim() === "/clear" && b.value.attachmentIds.length === 0 && !core.isAdvisorThread(b.value.threadId)) {
            return this.openedThread(id, await core.clear(b.value.threadId));
          }
          await core.send(b.value.threadId, b.value.text, b.value.clientMsgId, b.value.attachmentIds, {
            attachments: b.value.advisorAttachments.map(advisorAttachment),
            tone: advisorToneOf(b.value.advisorTone),
            device: this.device,
          });
          return ack();
        case "attachmentUpload": {
          const v = b.value;
          core.upload({
            uploadId: v.uploadId,
            threadId: v.threadId,
            name: v.name,
            mimeType: v.mimeType,
            size: Number(v.size),
            offset: Number(v.offset),
            data: v.data,
          });
          return ack();
        }
        case "attachmentCancel":
          core.cancelUpload(b.value.uploadId);
          return ack();
        case "attachmentSave": {
          const { threadId, uploadId } = b.value;
          return this.send(id, { case: "attachmentSaved", value: { uploadId, path: core.saveUpload(threadId, uploadId) } });
        }
        case "attachmentFetch": {
          const { threadId, attachmentId } = b.value;
          const image = core.attachmentImage(threadId, attachmentId);
          return this.send(id, { case: "attachmentData", value: { threadId, attachmentId, mimeType: image.mimeType, data: image.data } });
        }
        case "threadRespond": {
          const v = b.value;
          const answer =
            v.answer.case === "decision"
              ? { decision: v.answer.value, denyMessage: v.denyMessage }
              : v.answer.case === "answers"
                ? { answers: v.answer.value, denyMessage: v.denyMessage }
                : { denyMessage: v.denyMessage };
          core.respond(v.threadId, v.itemId, v.expectedRevision, answer, this.device);
          return ack();
        }
        case "threadInterrupt":
          await core.interrupt(b.value.threadId, b.value.clientMsgId, this.device);
          return ack();
        case "threadClose":
          await core.close(b.value.threadId);
          this.subscribed.delete(b.value.threadId);
          return ack();
        case "threadDelete": {
          const v = b.value;
          const trashed = await core.deleteThread({ threadId: v.threadId, stopRunning: v.stopRunning, openAnyway: v.openAnyway, device: this.device });
          return this.send(id, { case: "threadDeleted", value: { threadId: v.threadId, trashed } });
        }
        case "threadSetArchived":
          core.setArchived(b.value.threadId, b.value.archived);
          return ack();
        case "threadSetModel":
          await core.setModel(b.value.threadId, b.value.model);
          return ack();
        case "threadSetEffort":
          await core.setEffort(b.value.threadId, b.value.effort);
          return ack();
        case "threadSetPermissionMode":
          await core.setPermissionMode(b.value.threadId, b.value.mode, this.device);
          return ack();
        case "threadSetAdvisor":
          core.setAdvisor(b.value.threadId, b.value.on, this.device);
          return ack();
        case "threadSwitch":
          await core.switchProvider(b.value.threadId, b.value.provider, b.value.model);
          return ack();
        case "threadEarlier": {
          const page = core.earlier(b.value.threadId, b.value.earlier, b.value.limit);
          return this.send(id, { case: "threadEarlierResult", value: { threadId: b.value.threadId, items: page.items.map(wireItem), earlier: page.earlier } });
        }
        case "threadFetchFull":
          return this.send(id, { case: "fullItem", value: { threadId: b.value.threadId, item: core.fullItem(b.value.threadId, b.value.itemId) } });
        case "threadGitChanges":
          return this.send(id, { case: "gitChanges", value: gitChangesBody(b.value.threadId, await core.gitChanges(b.value.threadId)) });
        case "gitFileDiff": {
          const file = await core.gitFileDiff(b.value.threadId, b.value.path);
          return this.send(id, { case: "gitFileDiffResult", value: { threadId: b.value.threadId, file: gitFileBody(file) } });
        }
        case "dirList": {
          const folders = this.ctx.macFolders;
          folders?.assert(b.value.path || homedir());
          const l = listDir(b.value.path, {
            showHidden: b.value.showHidden,
            isSensitive: this.ctx.isSensitive,
            ...(folders ? { mayEnter: (p: string) => folders.allows(p) } : {}),
          });
          return this.send(id, { case: "dirListResult", value: l });
        }
        case "fileList": {
          const { threadId, prefix, limit } = b.value;
          const listing = listSessionFiles(core.threadDir(threadId), prefix, { limit, isSensitive: this.ctx.isSensitive });
          return this.send(id, { case: "fileListResult", value: { threadId, ...listing } });
        }
        case "agentUpdateCheck": {
          if (!this.ctx.updater) return this.send(id, { case: "error", value: refusal("this machine cannot update itself", ErrorReason.UNSUPPORTED_REQUEST) });
          await this.ctx.updater.check();
          return this.send(id, { case: "machineInfo", value: await this.ctx.machineInfo() });
        }
        case "agentUpdateStart": {
          const updater = this.ctx.updater;
          if (!updater) return this.send(id, { case: "error", value: refusal("this machine cannot update itself", ErrorReason.UNSUPPORTED_REQUEST) });
          updater.assertCanRun();
          this.ctx.audit.write({ device: this.device, action: "agent_update", path: "", detail: updater.info().latestVersion });
          void updater.run();
          return ack();
        }
        case "auditList": {
          const entries = this.ctx.audit.list(b.value.limit || 100).map((e) => ({ ...e, at: BigInt(e.at) }));
          return this.send(id, { case: "auditListResult", value: { entries } });
        }
        case "accountList":
        case "accountSelect":
        case "accountSignInBegin":
        case "accountSignInCode":
        case "accountSignInCancel":
        case "accountRemove":
        case "accountCaptureCurrent":
        case "accountAcceptCurrent":
        case "usageRefresh":
          // These may wait on an AI's CLI for seconds: they answer later, by id, and the
          // frames after them (pings, threads) go on meanwhile.
          void this.accountFrame(id, b).catch((err: unknown) => this.sendError(id, err));
          return;
        case "secretProvide":
        case "secretDecline":
        case "secretList":
        case "secretRemove":
          // Sealing waits on the key store: answered later, by id.
          void this.secretFrame(id, b).catch((err: unknown) => this.sendError(id, err));
          return;
        case "advisorSetKey":
        case "advisorRemoveKey":
          if (b.case === "advisorSetKey") rememberAdvisorKey(b.value.key);
          // Sealing waits on the key store: answered later, by id.
          void this.advisorFrame(id, b).catch((err: unknown) => this.sendError(id, err));
          return;
        case "browserControl":
        case "browserView":
        case "browserInput":
        case "browserTakeoverEnd":
        case "browserClear":
          return this.browserFrame(id, b);
        case "screenShareStatusRequest":
        case "screenShareOpen":
        case "screenShareData":
        case "screenShareClose":
          if (!this.screenShareLink) return this.send(id, { case: "error", value: refusal("this machine has no Screen Sharing", ErrorReason.UNSUPPORTED_REQUEST) });
          return this.screenShareLink.handle(id, b);
        case "projectList":
        case "projectAdd":
        case "projectCreate":
        case "projectClone":
        case "projectCloneCancel":
        case "projectUpdate":
        case "projectReorder":
        case "projectRemove":
          void this.projectFrame(id, b).catch((err: unknown) => this.sendError(id, err));
          return;
        case "termListRequest":
        case "termOpen":
        case "termClose":
        case "termResize":
        case "termSignal":
        case "termUpdateNow":
          // Answered later, by id: starting the terminal process may take a moment.
          if (!this.terminal) return this.send(id, { case: "error", value: refusal("this machine has no terminal", ErrorReason.UNSUPPORTED_REQUEST) });
          if (b.case === "termOpen" && b.value.cwd !== "") this.ctx.macFolders?.assert(b.value.cwd);
          return this.terminal.handle(id, b);
        case "termData":
          // Only a frame queued before the link opened comes this way.
          return this.termData(b.value);
        case "wsDirList":
        case "wsFileRead":
        case "wsFindNames":
        case "wsFindContents":
        case "wsWatch":
        case "wsGitStatus":
        case "wsGitDiff":
        case "wsGitStage":
        case "wsGitUnstage":
        case "wsGitDiscard":
        case "wsGitCommit":
        case "wsGitBranches":
        case "wsGitCheckout":
        case "wsGitBranchCreate":
        case "wsGitFetch":
        case "wsGitPull":
        case "wsGitPush":
        case "wsGitRebase":
        case "wsGitLog":
        case "wsGitBranchCompare":
        case "wsGitPrUrl":
        case "wsGitCommitMessage":
          return this.workspaceFrame(id, b);
        case "usageReportRequest":
        case "usageSettingsGet":
        case "usageSettingsSet":
        case "usageDelete":
          return this.usageFrame(id, b);
        case "officeWatch": {
          const office = this.office;
          if (!office) return this.send(id, { case: "error", value: refusal("the link is not open", ErrorReason.UNSUPPORTED_REQUEST) });
          if (!b.value.on) {
            office.unwatch(b.value.threadId, this.officeSink);
            return ack();
          }
          return this.send(id, { case: "officeSnapshot", value: office.watch(b.value.threadId, this.officeSink, b.value.advisorRole) });
        }
        case "projectConfigGet": {
          const dir = b.value.dir;
          if (!dir) return this.send(id, { case: "error", value: refusal("a folder is needed", ErrorReason.FOLDER_NOT_FOUND) });
          return this.send(id, { case: "projectConfig", value: { dir: resolve(dir), level: core.projectConfig(dir) } });
        }
        case "projectConfigSet": {
          const dir = await core.setProjectConfig({ dir: b.value.dir, level: b.value.level, device: this.device });
          return this.send(id, { case: "projectConfig", value: { dir, level: core.projectConfig(dir) } });
        }
        default:
          return this.send(id, { case: "error", value: refusal("unsupported request", ErrorReason.UNSUPPORTED_REQUEST) });
      }
    } catch (err) {
      this.sendError(id, err);
    }
  }

  /** A workspace's files and git: answered later, by id (git may take a while). */
  private workspaceFrame(id: string, b: WorkspaceFrame): void {
    const link = this.workspaceLink;
    if (!link) return this.send(id, { case: "error", value: refusal("this machine has no workspaces", ErrorReason.UNSUPPORTED_REQUEST) });
    void link.handle(id, b).catch((err: unknown) => this.sendError(id, err));
  }

  /** Usage: a report reads the ledger's months from disk, so it answers later, by id. */
  private usageFrame(id: string, b: UsageFrame): void {
    const usage = this.ctx.usage;
    if (!usage) return this.send(id, { case: "error", value: refusal("this machine keeps no usage ledger", ErrorReason.UNSUPPORTED_REQUEST) });
    void handleUsage(usage, id, b, (i, body) => this.send(i, body), this.device).catch((err: unknown) => this.sendError(id, err));
  }

  /** The tunelo browser: answered later, by id; input in order. */
  private browserFrame(id: string, b: BrowserFrame): void {
    if (!this.browserLink) return this.send(id, { case: "error", value: refusal("this machine has no tunelo browser", ErrorReason.UNSUPPORTED_REQUEST) });
    this.browserLink.handle(id, b);
  }

  /**
   * A thread opened for this device: it is followed from now on and gets its
   * statusline and its items. `fresh`: the thread is new, so the device holds
   * none of it and may get only the newest (an existing one may be held in
   * part: newer revisions of older items would be skipped by the cursor).
   */
  private openedThread(id: string, thread: ThreadSummary, fresh = true): void {
    this.subscribed.add(thread.id);
    this.send(id, { case: "threadCreated", value: { thread } });
    this.sendInfo(thread.id);
    // A device that pages older items itself (it asked for a tail on this link) gets the newest ones only.
    if (fresh && this.tail > 0) {
      const page = this.ctx.core.tailSnapshot(thread.id, this.tail);
      this.sendItems(thread.id, page.items, "", page.earlier);
    } else this.sendItems(thread.id, this.ctx.core.snapshot(thread.id));
  }

  private sendError(id: string, err: unknown): void {
    this.send(id, { case: "error", value: errorBody(err) });
  }
}

type ProjectFrame = Extract<
  Frame["body"],
  { case: "projectList" | "projectAdd" | "projectCreate" | "projectClone" | "projectCloneCancel" | "projectUpdate" | "projectReorder" | "projectRemove" }
>;

type SecretFrame = Extract<Frame["body"], { case: "secretProvide" | "secretDecline" | "secretList" | "secretRemove" }>;

type AdvisorFrame = Extract<Frame["body"], { case: "advisorSetKey" | "advisorRemoveKey" }>;

type AccountFrame = Extract<
  Frame["body"],
  {
    case: "accountList" | "accountSelect" | "accountSignInBegin" | "accountSignInCode" | "accountSignInCancel" | "accountRemove" | "accountCaptureCurrent" | "accountAcceptCurrent" | "usageRefresh";
  }
>;

function isFsError(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === "string";
}

// One WebSocket from one device: pairing or handshake first, then sealed
// frames dispatched to the core.
import { type MessageInitShape, create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  type Frame,
  FrameSchema,
  HandshakeErrorCode,
  type Item,
  type MachineInfo,
  type ThreadSummary,
} from "@achoo254/chat-proto/remote/remote";
import {
  type MachineAuth,
  type PairingWindow,
  type Session,
  acceptHello,
  decodePlain,
  encodeHandshakeError,
  encodePlain,
  pakeReply,
} from "@achoo254/chat-remote-protocol";
import { AgentError, type AgentCore } from "../core/agent-core.ts";
import { type ConfigStore, deviceLabel } from "../config.ts";
import { type ClaudeProfiles, type ProfileList, ProfileError } from "../profiles/service.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import type { LocalForward } from "../tunnels/forward.ts";
import { listDir } from "../safety/dirs.ts";
import { wireItem } from "./wire.ts";

export type Socket = {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
};

export type LinkContext = {
  core: AgentCore;
  config: ConfigStore;
  audit: AuditLog;
  auth: () => MachineAuth;
  pairing: () => PairingWindow | undefined;
  machineInfo: () => Promise<MachineInfo>;
  isSensitive: (p: string) => boolean;
  /** A device is looking at the machine (for push decisions). */
  onPing: () => void;
  /** A device was paired (refresh caches, close the install window). */
  onPaired: (via: "install" | "qr" | "code") => void;
  /** The Claude profiles of the machine; absent where the machine has none (tests). */
  profiles?: ClaudeProfiles;
  /** Localman's requests for localhost; absent where the machine has none (tests). */
  localForward?: LocalForward;
};

const window = (w?: { utilization: number; resetsAt: number }) => (w ? { utilization: w.utilization, resetsAt: BigInt(w.resetsAt) } : undefined);

/** The profile list as devices get it: accounts and usage, never a credential. */
function profileListBody(list: ProfileList) {
  return {
    selectedId: list.selectedId,
    profiles: list.profiles.map((p) => {
      const u = p.lastUsage;
      const fiveHour = window(u?.fiveHour);
      const sevenDay = window(u?.sevenDay);
      return {
        id: p.id,
        email: p.email,
        organization: p.organization,
        plan: p.plan,
        signedIn: p.signedIn,
        loginExpiresAt: BigInt(p.loginExpiresAt),
        createdAt: BigInt(p.createdAt),
        usageUpdatedAt: BigInt(u?.updatedAt ?? 0),
        ...(u ? { lastUsage: { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } } : {}),
      };
    }),
  };
}

type Pake = Extract<Awaited<ReturnType<typeof pakeReply>>, { ok: true }>;

export class Connection {
  // "confirming": the handshake answered, but the device has not yet proven
  // its key with a first valid frame; it holds no session until then.
  private state: "new" | "pake" | "confirming" | "open" | "closed" = "new";
  private pairedBy: "install" | "qr" | undefined;
  private deviceName = "";
  /** Last time any message arrived, for the idle timeout. */
  lastSeen = Date.now();
  private session: Session | undefined;
  private pake: Pake | undefined;
  private device = "";
  private subscribed = new Set<string>();
  private unsubscribe: (() => void)[] = [];
  private queue: Promise<void> = Promise.resolve();
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

  /** Messages are handled one at a time, in order. */
  receive(data: Uint8Array): void {
    this.lastSeen = Date.now();
    this.queue = this.queue.then(() => this.handle(data)).catch(() => this.close(1008, "protocol error"));
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const u of this.unsubscribe) u();
    this.socket.close(code, reason);
  }

  private async handle(data: Uint8Array): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "open") return this.frame(this.session?.open(data));
    if (this.state === "confirming") {
      const first = this.session?.open(data); // throws on a forged frame
      this.confirmed();
      return this.frame(first);
    }
    const plain = decodePlain(data);
    const body = plain.body;
    if (this.state === "pake") {
      if (body.case !== "pakeFinish" || !this.pake) throw new Error("expected pake finish");
      const paired = await this.pake.confirm(body.value);
      if (paired) {
        this.ctx.config.addDevice(paired.deviceKey, paired.deviceName);
        this.ctx.audit.write({ device: deviceLabel(paired.deviceKey, paired.deviceName), action: "pair", path: "", detail: "code" });
        this.ctx.onPaired("code");
      }
      // The device reconnects with a normal handshake.
      return this.close(1000, paired ? "paired" : "pairing failed");
    }
    if (body.case === "pakeStart") {
      const window = this.ctx.pairing();
      const auth = this.ctx.auth();
      if (!window) {
        this.socket.send(encodeHandshakeError(HandshakeErrorCode.PAIRING_EXPIRED));
        return this.close(1000, "no pairing window");
      }
      const r = await pakeReply({ window, machineKey: auth.machine.publicKey, start: body.value });
      if (!r.ok) {
        this.socket.send(encodeHandshakeError(r.code));
        return this.close(1000, "pairing refused");
      }
      this.pake = r;
      this.state = "pake";
      this.socket.send(encodePlain({ case: "pakeReply", value: r.reply }));
      return;
    }
    if (body.case !== "hello") throw new Error("expected hello");
    const result = await acceptHello(data, this.ctx.auth());
    this.socket.send(result.reply);
    if (!result.ok) return this.close(1000, "handshake refused");
    this.session = result.session;
    this.device = deviceLabel(result.deviceKey, result.deviceName);
    this.deviceName = result.deviceName;
    this.pairedBy = result.pairedBy;
    this.state = "confirming";
  }

  /** The device proved its key: pair it if this was a pairing, then serve it. */
  private confirmed(): void {
    const key = this.session?.peerStatic;
    if (!key) throw new Error("no session");
    if (this.pairedBy) {
      this.ctx.config.addDevice(key, this.deviceName);
      this.ctx.audit.write({ device: this.device, action: "pair", path: "", detail: this.pairedBy });
      this.ctx.onPaired(this.pairedBy);
    }
    this.state = "open";
    this.unsubscribe.push(
      this.ctx.core.onItems((threadId, items) => {
        if (this.subscribed.has(threadId)) this.sendItems(threadId, items);
      }),
      this.ctx.core.onStatus((thread) => this.send("", { case: "threadStatus", value: { thread } })),
      this.ctx.core.onInfo((threadId) => {
        if (this.subscribed.has(threadId)) this.sendInfo(threadId);
      }),
    );
  }

  private send(id: string, body: NonNullable<MessageInitShape<typeof FrameSchema>["body"]>): void {
    if (this.state !== "open" || !this.session) return;
    this.socket.send(this.session.seal(create(FrameSchema, { id, body })));
  }

  private sendInfo(threadId: string): void {
    this.send("", { case: "threadInfo", value: this.ctx.core.info(threadId) });
  }

  private sendItems(threadId: string, items: Item[], id = ""): void {
    const cursor = { epoch: this.ctx.core.epoch, seq: this.ctx.core.lastSeq(threadId) };
    this.send(id, { case: "threadItems", value: { threadId, items: items.map(wireItem), cursor } });
  }

  /** Claude profiles: the sign-in code is handed on and dropped, never kept or logged. */
  private async profileFrame(id: string, b: ProfileFrame): Promise<void> {
    const profiles = this.ctx.profiles;
    if (!profiles) return this.send(id, { case: "error", value: { code: ErrorCode.INVALID, message: "this machine has no Claude profiles" } });
    const sendList = async () => this.send(id, { case: "profileListResult", value: profileListBody(await profiles.list()) });
    switch (b.case) {
      case "profileList":
        return sendList();
      case "profileSelect":
        await profiles.select(b.value.id, this.device);
        return sendList();
      case "profileSignInBegin": {
        const r = await profiles.beginRemote();
        if (!r.ok) return this.send(id, { case: "profileSignInResult", value: { ok: false, error: r.error } });
        return this.send(id, { case: "profileSignInPrompt", value: { attemptId: r.attemptId, url: r.url, expiresAt: BigInt(r.expiresAt) } });
      }
      case "profileSignInCode": {
        const r = await profiles.submitCode(b.value.attemptId, b.value.code);
        const value = r.ok ? { ok: true, id: r.id, email: r.email, organization: r.organization } : { ok: false, error: r.error };
        return this.send(id, { case: "profileSignInResult", value });
      }
      case "profileSignInCancel":
        await profiles.cancel(b.value.attemptId);
        return this.send(id, { case: "ack", value: {} });
      case "profileRemove":
        await profiles.remove(b.value.id, this.device);
        return sendList();
      case "usageRefresh":
        await profiles.refreshUsage(b.value.id);
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
        case "machineSettingsSet": {
          const forward = this.ctx.localForward;
          if (b.value.localForward !== undefined) {
            if (!forward) return this.send(id, { case: "error", value: { code: ErrorCode.INVALID, message: "this machine does not forward to localhost" } });
            forward.setEnabled(b.value.localForward, this.device);
          }
          return this.send(id, { case: "machineInfo", value: await this.ctx.machineInfo() });
        }
        case "threadList":
          return this.send(id, {
            case: "threadListResult",
            value: { threads: core.list(), openSessions: core.openSessions(), maxSessions: core.limit },
          });
        case "threadCreate": {
          const v = b.value;
          const thread: ThreadSummary = await core.create({
            provider: v.provider,
            model: v.model,
            dir: v.dir,
            text: v.text,
            consent: { sensitive: Boolean(v.consent?.sensitive), projectSettings: Boolean(v.consent?.projectSettings) },
            device: this.device,
          });
          this.subscribed.add(thread.id);
          this.send(id, { case: "threadCreated", value: { thread } });
          this.sendInfo(thread.id);
          return this.sendItems(thread.id, core.snapshot(thread.id));
        }
        case "threadSubscribe": {
          const { threadId, cursor } = b.value;
          const r = core.subscribe(threadId, cursor);
          this.subscribed.add(threadId);
          this.sendInfo(threadId);
          if (r.resume.kind === "reset") {
            this.send(id, { case: "threadReset", value: { threadId, reason: r.resume.reason } });
            return this.sendItems(threadId, core.snapshot(threadId), id);
          }
          return this.sendItems(threadId, r.items, id);
        }
        case "threadSend":
          await core.send(b.value.threadId, b.value.text, b.value.clientMsgId);
          return ack();
        case "threadRespond": {
          const v = b.value;
          const answer = v.answer.case === "decision" ? { decision: v.answer.value } : v.answer.case === "answers" ? { answers: v.answer.value } : {};
          core.respond(v.threadId, v.itemId, v.expectedRevision, answer, this.device);
          return ack();
        }
        case "threadInterrupt":
          await core.interrupt(b.value.threadId);
          return ack();
        case "threadClose":
          await core.close(b.value.threadId);
          this.subscribed.delete(b.value.threadId);
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
        case "threadSwitch":
          await core.switchProvider(b.value.threadId, b.value.provider, b.value.model);
          return ack();
        case "threadFetchFull":
          return this.send(id, { case: "fullItem", value: { threadId: b.value.threadId, item: core.fullItem(b.value.threadId, b.value.itemId) } });
        case "dirList": {
          const l = listDir(b.value.path, { showHidden: b.value.showHidden, isSensitive: this.ctx.isSensitive });
          return this.send(id, { case: "dirListResult", value: l });
        }
        case "auditList": {
          const entries = this.ctx.audit.list(b.value.limit || 100).map((e) => ({ ...e, at: BigInt(e.at) }));
          return this.send(id, { case: "auditListResult", value: { entries } });
        }
        case "profileList":
        case "profileSelect":
        case "profileSignInBegin":
        case "profileSignInCode":
        case "profileSignInCancel":
        case "profileRemove":
        case "usageRefresh":
          // These may wait on claude for seconds: they answer later, by id, and the
          // frames after them (pings, threads) go on meanwhile.
          void this.profileFrame(id, b).catch((err: unknown) => this.sendError(id, err));
          return;
        default:
          return this.send(id, { case: "error", value: { code: ErrorCode.INVALID, message: "unsupported request" } });
      }
    } catch (err) {
      this.sendError(id, err);
    }
  }

  private sendError(id: string, err: unknown): void {
    const code = err instanceof AgentError ? err.code : isFsError(err) || err instanceof ProfileError ? ErrorCode.INVALID : ErrorCode.INTERNAL;
    this.send(id, { case: "error", value: { code, message: (err as Error).message.slice(0, 300) } });
  }
}

type ProfileFrame = Extract<
  Frame["body"],
  { case: "profileList" | "profileSelect" | "profileSignInBegin" | "profileSignInCode" | "profileSignInCancel" | "profileRemove" | "usageRefresh" }
>;

function isFsError(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === "string";
}

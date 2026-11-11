// The agent's side of the terminal process's local control socket
// (docs/terminal-wire.md, "Giao thức điều khiển cục bộ"): a Unix socket on
// POSIX, a named pipe on Windows, both named in `<config>/term-host/control.json`
// with the token the first command must carry. Frames are
// `[length u32][kind u8][payload]`: kind 0 is JSON (commands, replies,
// events), kind 1 is one relay-path terminal frame of a connection.
//
// After every connect the agent says hello, then hands over the revoked
// device keys (`set_revoked`) before the link counts as ready, so no grant
// can ever reach a terminal process that has not heard of a revocation.
// From control minor 1 the hello result also lists the terminal process's
// live connections, so the agent can find the ones an earlier run left.
// The link reconnects by itself while the terminal process runs (its
// control.json exists); a process that exited idle is started again on the
// next terminal use, not here.
import { readFileSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { join } from "node:path";
import { z } from "zod";

export const CONTROL_MAJOR = 1;
export const CONTROL_MINOR = 1;
const KIND_JSON = 0;
const KIND_RELAY = 1;
const MAX_CONTROL_FRAME = 1024 * 1024;
const CALL_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;

/** `<config>/term-host`: the terminal process's private folder. */
export function termHostDir(configDir: string): string {
  return join(configDir, "term-host");
}

const controlInfoSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  pid: z.number().int().positive(),
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  daemonVersion: z.string().max(64),
  socket: z.string().min(1).max(4096).optional(),
  pipe: z.string().min(1).max(4096).optional(),
});
export type ControlInfo = z.infer<typeof controlInfoSchema>;

/** The running terminal process's endpoint and token; undefined when none runs (or the file is not its). */
export function readControlInfo(configDir: string): ControlInfo | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(termHostDir(configDir), "control.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = controlInfoSchema.safeParse(JSON.parse(raw));
    return parsed.success && (parsed.data.socket ?? parsed.data.pipe) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const sessionSchema = z.object({
  session: z.number().int().positive(),
  title: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.number().int().nonnegative(),
  attached: z.boolean(),
  exited: z.object({ code: z.number().int(), signal: z.number().int().nonnegative() }).optional(),
});
export type DaemonSession = z.infer<typeof sessionSchema>;

const auditSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["open", "close", "denied"]),
  session: z.number().int().optional(),
  conn: z.number().int().optional(),
  deviceKey: z.string().max(64).optional(),
  at: z.number().int().nonnegative(),
});
export type DaemonAudit = z.infer<typeof auditSchema>;

const connectionSchema = z.object({
  conn: z.number().int().nonnegative(),
  deviceKey: z.string().max(64),
  // conn_state terms (connecting, direct, relay); a newer minor may add states.
  state: z.string().max(32),
  createdAt: z.number().int().nonnegative(),
});
export type DaemonConnection = z.infer<typeof connectionSchema>;

const helloSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
  daemonVersion: z.string(),
  pid: z.number().int().positive(),
  sessions: z.array(sessionSchema),
  /** Live connections (minor 1 and later); absent from a minor 0 terminal process. */
  connections: z.array(connectionSchema).max(4096).optional(),
  pendingAudit: z.array(auditSchema),
});
export type HelloResult = z.infer<typeof helloSchema>;

export const sessionListSchema = z.array(sessionSchema);

const eventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("signal"),
    conn: z.number().int(),
    kind: z.enum(["answer", "candidate", "end"]),
    sdp: z.string().optional(),
    candidate: z.string().optional(),
    reason: z.string().max(64).optional(),
  }),
  z.object({
    event: z.literal("conn_state"),
    conn: z.number().int(),
    state: z.enum(["connecting", "direct", "relay", "closed"]),
    rttMs: z.number().nonnegative().optional(),
    reason: z.string().max(64).optional(),
  }),
  z.object({ event: z.literal("session_exit"), session: z.number().int(), code: z.number().int(), signal: z.number().int() }),
  auditSchema.extend({ event: z.literal("audit") }),
]);
export type DaemonEvent = z.infer<typeof eventSchema>;

const replySchema = z.object({
  id: z.number().int().nullable(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

/** A command the terminal process refused; `code` is one of its error codes (bad_request, revoked, …). */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export type HostLinkOptions = {
  configDir: string;
  agentVersion: string;
  /** The revoked device keys (32 bytes, base64url) sent after every connect. */
  revoked: () => string[];
  onEvent: (event: DaemonEvent) => void;
  /** One relay-path terminal frame of connection `conn` (a view: copy it to keep it). */
  onRelay: (conn: number, frame: Uint8Array) => void;
  /** Hello answered; called before the revoked keys are handed over (and so before onReady). */
  onHello?: (hello: HelloResult) => void;
  /** Connected, said hello, handed over the revoked keys. */
  onReady: (hello: HelloResult) => void;
  /** The link to a ready terminal process was lost. */
  onDown: () => void;
  log: (line: string) => void;
  /** Opens the socket or pipe; tests may replace it. */
  connect?: (path: string) => Socket;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class HostLink {
  private socket: Socket | undefined;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private inbox: Buffer = Buffer.alloc(0);
  private connecting: Promise<HelloResult> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryMs = RECONNECT_MIN_MS;
  private lastHello: HelloResult | undefined;

  constructor(private readonly opts: HostLinkOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Connects to the running terminal process, says hello and sends the
   * revoked keys. Rejects with ControlError("version_mismatch") for another
   * major, or a plain Error when none answers.
   */
  connect(): Promise<HelloResult> {
    if (this.closed) return Promise.reject(new Error("terminal link closed"));
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<HelloResult> {
    if (this.ready && this.lastHello) return this.lastHello;
    const info = readControlInfo(this.opts.configDir);
    const path = info?.socket ?? info?.pipe;
    if (!info || !path) throw new Error("the terminal process is not running");
    if (info.major !== CONTROL_MAJOR) throw new ControlError("version_mismatch", `the terminal process speaks control version ${info.major}`);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = (this.opts.connect ?? ((p: string) => createConnection(p)))(path);
      s.once("connect", () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });
    this.attach(socket);
    try {
      const raw = await this.request("hello", { major: CONTROL_MAJOR, minor: CONTROL_MINOR, token: info.token, agentVersion: this.opts.agentVersion });
      const hello = helloSchema.parse(raw);
      if (hello.major !== CONTROL_MAJOR) throw new ControlError("version_mismatch", `the terminal process speaks control version ${hello.major}`);
      this.opts.onHello?.(hello);
      // Revocations first: no grant is accepted before this answers.
      await this.request("set_revoked", { deviceKeys: this.opts.revoked() });
      this.ready = true;
      this.retryMs = RECONNECT_MIN_MS;
      this.lastHello = hello;
      this.opts.onReady(hello);
      return hello;
    } catch (err) {
      socket.destroy();
      throw err;
    }
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.inbox = Buffer.alloc(0);
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => this.read(socket, chunk));
    socket.on("error", () => undefined); // "close" follows
    socket.on("close", () => this.lost(socket));
  }

  /** Sends a command once the link is ready; rejects with ControlError when the terminal process refuses it. */
  call(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error("the terminal process is not connected"));
    return this.request(cmd, params);
  }

  private request(cmd: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("the terminal process is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the terminal process did not answer ${cmd}`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame(KIND_JSON, Buffer.from(JSON.stringify({ ...params, id, cmd }))));
    });
  }

  /** Hands one terminal frame of connection `conn` to the terminal process; false when not connected. */
  relay(conn: number, terminalFrame: Uint8Array): boolean {
    const socket = this.socket;
    if (!this.ready || !socket) return false;
    const out = Buffer.allocUnsafe(9 + terminalFrame.length);
    out.writeUInt32BE(5 + terminalFrame.length, 0);
    out[4] = KIND_RELAY;
    out.writeUInt32BE(conn, 5);
    out.set(terminalFrame, 9);
    socket.write(out);
    return true;
  }

  private read(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    this.inbox = this.inbox.length ? Buffer.concat([this.inbox, chunk]) : chunk;
    while (this.inbox.length >= 4) {
      const length = this.inbox.readUInt32BE(0);
      if (length < 1 || length > MAX_CONTROL_FRAME) {
        this.opts.log(`terminal: bad control frame length ${length}; reconnecting`);
        socket.destroy();
        return;
      }
      if (this.inbox.length < 4 + length) return;
      const kind = this.inbox[4];
      const body = this.inbox.subarray(5, 4 + length);
      this.inbox = this.inbox.subarray(4 + length);
      if (kind === KIND_JSON) this.json(body);
      else if (kind === KIND_RELAY && body.length >= 4) this.opts.onRelay(body.readUInt32BE(0), body.subarray(4));
      // Other kinds come from a newer terminal process of the same major: skipped.
    }
  }

  private json(body: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      this.opts.log("terminal: unreadable control message skipped");
      return;
    }
    if (typeof value === "object" && value !== null && "event" in value) {
      const event = eventSchema.safeParse(value);
      if (event.success) this.opts.onEvent(event.data);
      return;
    }
    const reply = replySchema.safeParse(value);
    if (!reply.success || reply.data.id === null) return;
    const waiting = this.pending.get(reply.data.id);
    if (!waiting) return;
    this.pending.delete(reply.data.id);
    clearTimeout(waiting.timer);
    if (reply.data.ok) waiting.resolve(reply.data.result ?? {});
    else waiting.reject(new ControlError(reply.data.error?.code ?? "internal", reply.data.error?.message ?? "refused"));
  }

  private lost(socket: Socket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    const wasReady = this.ready;
    this.ready = false;
    this.lastHello = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("the terminal process went away"));
      this.pending.delete(id);
    }
    if (wasReady) this.opts.onDown();
    if (wasReady && !this.closed) this.scheduleReconnect();
  }

  /** Tries again while the terminal process runs; stops once it exited (its control.json is gone). */
  private scheduleReconnect(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      if (this.closed || this.ready) return;
      if (!readControlInfo(this.opts.configDir)) return;
      this.connect().catch((err: unknown) => {
        if (err instanceof ControlError && err.code === "version_mismatch") return;
        this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
        this.scheduleReconnect();
      });
    }, this.retryMs);
    this.retry.unref?.();
  }

  /** Disconnects for good (the terminal process keeps running). */
  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }
}

function frame(kind: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt32BE(1 + payload.length, 0);
  out[4] = kind;
  payload.copy(out, 5);
  return out;
}

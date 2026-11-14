// A stand-in for tunelo-term-host that speaks the real control protocol
// (docs/terminal-wire.md section 6) on a Unix socket in a test config
// folder: control.json with a token, `[length u32][kind u8][payload]` frames,
// hello/set_revoked/grant/relay_open/signal/list/open/close/resize/
// conn_close/revoke_device/ack_audit/shutdown. With `minor` 1 the hello result lists
// the live connections, as the real one does. On the relay path it answers Hello
// and echoes Input as Output, so a test sees a keystroke come back.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { T, outputFrame, serverHelloFrame } from "./terminal-frames.ts";

export type Command = { cmd: string; [k: string]: unknown };
type Conn = { key: string; relay: boolean; offset: Map<number, bigint> };

export class FakeTermHost {
  readonly commands: Command[] = [];
  readonly token = randomBytes(32).toString("hex");
  /** The order of the commands names, for checking what came before what. */
  readonly order: string[] = [];
  revoked = new Set<string>();
  readonly conns = new Map<number, Conn>();
  sessions: { session: number; title: string; cols: number; rows: number; createdAt: number; attached: boolean }[] = [];
  pendingAudit: Record<string, unknown>[] = [];
  /** Answer hello with this major (another one tests version checks). */
  major = 1;
  /** Control minor: 0 answers hello without `connections`, 1 lists them. */
  minor = 0;
  /** The pid in control.json and hello; `shutdown` ends this process and the next start gets a new one. */
  pid = 999_999;
  /** Holds every relay echo this long (ms). */
  echoDelay = 0;
  private server: Server | undefined;
  private agent: Socket | undefined;
  private seq = 100;
  private nextSession = 1;
  readonly sock: string;
  readonly dir: string;

  constructor(readonly configDir: string) {
    this.dir = join(configDir, "term-host");
    this.sock = join(this.dir, "control.sock");
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    rmSync(this.sock, { force: true });
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((r) => server.listen(this.sock, r));
    this.server = server;
    writeFileSync(
      join(this.dir, "control.json"),
      JSON.stringify({ token: this.token, pid: this.pid, major: this.major, minor: this.minor, daemonVersion: "fake", socket: this.sock }),
      { mode: 0o600 },
    );
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  /** Stops like a crash: the socket closes, control.json stays when `clean` is false. */
  async stop(clean = true): Promise<void> {
    this.agent?.destroy();
    this.agent = undefined;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
    if (clean) rmSync(join(this.dir, "control.json"), { force: true });
  }

  /** Drops the agent's link (the agent reconnects). */
  dropAgent(): void {
    this.agent?.destroy();
  }

  private accept(s: Socket): void {
    // One agent at a time: a new hello replaces the old link.
    let authed = false;
    let inbox = Buffer.alloc(0);
    s.on("data", (chunk: Buffer) => {
      inbox = Buffer.concat([inbox, chunk]);
      while (inbox.length >= 4) {
        const len = inbox.readUInt32BE(0);
        if (inbox.length < 4 + len) return;
        const kind = inbox[4];
        const body = inbox.subarray(5, 4 + len);
        inbox = inbox.subarray(4 + len);
        if (kind === 0) {
          const msg = JSON.parse(body.toString()) as Command & { id: number };
          if (!authed) {
            if (msg.cmd !== "hello" || msg.token !== this.token) {
              this.write(s, 0, Buffer.from(JSON.stringify({ id: msg.id ?? null, ok: false, error: { code: "unauthorized", message: "bad token" } })));
              s.destroy();
              return;
            }
            if (msg.major !== this.major) {
              this.write(s, 0, Buffer.from(JSON.stringify({ id: msg.id, ok: false, error: { code: "version_mismatch", message: "major" } })));
              s.destroy();
              return;
            }
            authed = true;
            if (this.agent && this.agent !== s) this.agent.destroy();
            this.agent = s;
          }
          this.command(s, msg);
        } else if (kind === 1 && s === this.agent) {
          this.relayIn(body.readUInt32BE(0), body.subarray(4));
        }
      }
    });
    s.on("error", () => undefined);
  }

  private write(s: Socket, kind: number, payload: Buffer): void {
    const out = Buffer.alloc(5 + payload.length);
    out.writeUInt32BE(1 + payload.length, 0);
    out[4] = kind;
    payload.copy(out, 5);
    s.write(out);
  }

  emit(event: Record<string, unknown>): void {
    if (this.agent) this.write(this.agent, 0, Buffer.from(JSON.stringify(event)));
  }

  private reply(s: Socket, id: number, result: unknown): void {
    this.write(s, 0, Buffer.from(JSON.stringify({ id, ok: true, result })));
  }

  private refuse(s: Socket, id: number, code: string, message: string): void {
    this.write(s, 0, Buffer.from(JSON.stringify({ id, ok: false, error: { code, message } })));
  }

  audit(kind: "open" | "close" | "denied", extra: Record<string, unknown>): void {
    this.emit({ event: "audit", seq: ++this.seq, kind, at: Date.now(), ...extra });
  }

  private closeConn(conn: number, reason: string): void {
    const c = this.conns.get(conn);
    if (!c) return;
    this.conns.delete(conn);
    for (const session of c.offset.keys()) this.audit("close", { session, conn, deviceKey: c.key });
    this.emit({ event: "conn_state", conn, state: "closed", reason });
  }

  private command(s: Socket, m: Command & { id: number }): void {
    this.commands.push(m);
    this.order.push(m.cmd);
    switch (m.cmd) {
      case "hello":
        return this.reply(s, m.id, {
          major: this.major,
          minor: this.minor,
          daemonVersion: "fake",
          pid: this.pid,
          sessions: this.sessions,
          pendingAudit: this.pendingAudit,
          ...(this.minor >= 1
            ? { connections: [...this.conns].map(([conn, c]) => ({ conn, deviceKey: c.key, state: c.relay ? "relay" : "connecting", createdAt: 1_000 })) }
            : {}),
        });
      case "set_revoked": {
        this.revoked = new Set(m.deviceKeys as string[]);
        let closed = 0;
        for (const [id, c] of [...this.conns]) {
          if (this.revoked.has(c.key)) {
            this.closeConn(id, "revoked");
            closed++;
          }
        }
        return this.reply(s, m.id, { closed });
      }
      case "grant": {
        const key = m.deviceKey as string;
        if (this.revoked.has(key)) {
          this.audit("denied", { conn: m.conn, deviceKey: key });
          return this.refuse(s, m.id, "revoked", "device revoked");
        }
        this.conns.set(m.conn as number, { key, relay: false, offset: new Map() });
        return this.reply(s, m.id, {});
      }
      case "relay_open": {
        const c = this.conns.get(m.conn as number);
        if (!c) return this.refuse(s, m.id, "no_such_conn", "no such conn");
        c.relay = true;
        this.emit({ event: "conn_state", conn: m.conn, state: "relay" });
        return this.reply(s, m.id, {});
      }
      case "signal": {
        const conn = m.conn as number;
        if (!this.conns.has(conn)) return this.refuse(s, m.id, "no_such_conn", "no such conn");
        if (m.kind === "offer") {
          this.emit({ event: "conn_state", conn, state: "connecting" });
          this.emit({ event: "signal", conn, kind: "answer", sdp: "v=0\r\nfake-answer\r\n" });
          this.emit({ event: "signal", conn, kind: "candidate", candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ srflx" });
        }
        return this.reply(s, m.id, {});
      }
      case "conn_close":
        if (!this.conns.has(m.conn as number)) return this.refuse(s, m.id, "no_such_conn", "no such conn");
        this.closeConn(m.conn as number, "closed");
        return this.reply(s, m.id, {});
      case "revoke_device": {
        this.revoked.add(m.deviceKey as string);
        let closed = 0;
        for (const [id, c] of [...this.conns]) {
          if (c.key === m.deviceKey) {
            this.closeConn(id, "revoked");
            closed++;
          }
        }
        return this.reply(s, m.id, { closed });
      }
      case "list":
        return this.reply(s, m.id, this.sessions);
      case "open": {
        if (this.sessions.length >= 20) return this.refuse(s, m.id, "session_limit", "20 sessions");
        const session = this.nextSession++;
        this.sessions.push({ session, title: "", cols: m.cols as number, rows: m.rows as number, createdAt: Date.now(), attached: false });
        return this.reply(s, m.id, { session });
      }
      case "close":
      case "resize": {
        if (!this.sessions.some((x) => x.session === m.session)) return this.refuse(s, m.id, "no_such_session", "no such session");
        if (m.cmd === "close") this.sessions = this.sessions.filter((x) => x.session !== m.session);
        return this.reply(s, m.id, {});
      }
      case "shutdown":
        // Every program ends with the process; the next one starts empty.
        this.reply(s, m.id, {});
        this.sessions = [];
        this.nextSession = 1;
        this.conns.clear();
        this.pid++;
        setTimeout(() => void this.stop(true), 10);
        return;
      case "ack_audit":
        this.pendingAudit = this.pendingAudit.filter((e) => (e.seq as number) > (m.upTo as number));
        return this.reply(s, m.id, {});
      default:
        return this.refuse(s, m.id, "bad_request", "unknown cmd");
    }
  }

  /** The program in `session` exits (it stays listed until closed, as the real one does). */
  exit(session: number, code = 0): void {
    const s = this.sessions.find((x) => x.session === session);
    if (s) Object.assign(s, { exited: { code, signal: 0 } });
    this.emit({ event: "session_exit", session, code, signal: 0 });
  }

  /** A relay frame from the agent: Hello is answered, Attach is audited, Input comes back as Output. */
  private relayIn(conn: number, frame: Buffer): void {
    const c = this.conns.get(conn);
    if (!c?.relay) return;
    const type = frame[0];
    const session = frame.readUInt32BE(1);
    const send = (f: Uint8Array) => {
      const payload = Buffer.alloc(4 + f.length);
      payload.writeUInt32BE(conn, 0);
      payload.set(f, 4);
      if (this.agent) this.write(this.agent, 1, payload);
    };
    if (type === T.HELLO) return send(serverHelloFrame());
    if (type === T.ATTACH) {
      c.offset.set(session, 0n);
      this.audit("open", { session, conn, deviceKey: c.key });
      return;
    }
    if (type === T.INPUT) {
      const data = new Uint8Array(frame.subarray(5));
      const offset = c.offset.get(session) ?? 0n;
      c.offset.set(session, offset + BigInt(data.length));
      const out = () => send(outputFrame(session, offset, data));
      if (this.echoDelay > 0) setTimeout(out, this.echoDelay);
      else out();
    }
  }
}

/** A unit that "starts" the fake terminal process (as launchd would start the real one). */
export function fakeUnit(host: FakeTermHost): {
  current: (bin: string) => boolean;
  install: (bin: string) => Promise<void>;
  start: () => Promise<void>;
  remove: () => Promise<void>;
  installs: string[];
  starts: number;
} {
  const unit = {
    installs: [] as string[],
    starts: 0,
    current: (bin: string) => unit.installs.at(-1) === bin,
    install: async (bin: string) => {
      unit.installs.push(bin);
    },
    start: async () => {
      unit.starts++;
      if (!host.running) await host.start();
    },
    remove: async () => undefined,
  };
  return unit;
}

// The machine's terminal on one device's end-to-end connection: the Term*
// requests, WebRTC signaling of the device's links, and on the relay path
// the terminal frames both ways. Typed bytes and output pass through as they
// are and are never logged or kept.
//
// A link is named by the device (TermSignal.link / TermData.link), scoped to
// this connection, and maps to one connection id of the terminal process,
// unique on the machine, so two devices (or two pages) never collide.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, type Frame, type FrameSchema, TermPath, TermSignalKind } from "@achoo254/chat-proto/remote/remote";
import type { DaemonEvent } from "./host-link.ts";
import type { TerminalService } from "./terminal-service.ts";
import { TerminalError } from "./terminal-error.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;
export type TermRequest = Extract<Frame["body"], { case: "termListRequest" | "termOpen" | "termClose" | "termResize" | "termSignal" }>;
type TermDataBody = Extract<Frame["body"], { case: "termData" }>["value"];

/** Header of a terminal frame (type u8, session u32) and the largest frame (docs/terminal-wire.md). */
const MIN_TERMINAL_FRAME = 5;
const MAX_TERMINAL_FRAME = 65_536;
/** Frames a device may send on a link while it is being granted and opened. */
const MAX_PENDING_FRAMES = 256;
/** Output held for a device that does not read; beyond it the link ends (the terminal's ack window keeps it far below). */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
/** The device's socket holds this much unsent: output waits (only TermData; signaling goes on). */
export const SOCKET_HIGH_WATER = 512 * 1024;
const MAX_DIM = 1000;

/** What the terminal needs of the device's connection. */
export type TerminalPeer = {
  send(id: string, body: Body): void;
  /** Bytes queued on the device's socket and not yet sent. */
  buffered(): number;
  /** The device's key from the end-to-end session (undefined before it is open). */
  deviceKey(): Uint8Array | undefined;
};

type Link = {
  id: number;
  /** The terminal process's connection id, once granted. */
  conn: number | undefined;
  relay: "none" | "opening" | "open";
  /** The path the terminal process reported last. */
  path: "none" | "connecting" | "direct" | "relay";
  /** Frames from the device waiting for the relay to open, in order. */
  pending: Uint8Array[];
  /** Grant, relay_open and signaling of the link, one after another. */
  chain: Promise<void>;
  closed: boolean;
};

export class TerminalConnection {
  private readonly links = new Map<number, Link>();
  private readonly queue: { link: number; data: Uint8Array }[] = [];
  private queuedBytes = 0;
  private closed = false;

  constructor(
    private readonly service: TerminalService,
    private readonly peer: TerminalPeer,
  ) {}

  deviceKey(): Uint8Array | undefined {
    return this.peer.deviceKey();
  }

  /** A Term* request; answered by id (or an error by id). */
  handle(id: string, b: TermRequest): void {
    const ack = () => this.peer.send(id, { case: "ack", value: {} });
    const fail = (err: unknown) => this.peer.send(id, { case: "error", value: this.service.errorBody(err) });
    const run = async (): Promise<void> => {
      this.service.assertPaired(this.peer.deviceKey());
      switch (b.case) {
        case "termListRequest":
          return this.peer.send(id, { case: "termListResult", value: await this.service.list() });
        case "termOpen": {
          const { cols, rows } = b.value;
          if (!validDim(cols) || !validDim(rows)) throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSPECIFIED, "cols and rows must be 1 to 1000");
          const session = await this.service.open(cols, rows, openCwd(b.value.cwd));
          return this.peer.send(id, { case: "termOpened", value: { session } });
        }
        case "termClose":
          await this.service.close(b.value.session);
          return this.peer.send(id, { case: "termClosed", value: { session: b.value.session } });
        case "termResize": {
          const { session, cols, rows } = b.value;
          if (!validDim(cols) || !validDim(rows)) throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSPECIFIED, "cols and rows must be 1 to 1000");
          await this.service.resize(session, cols, rows);
          return ack();
        }
        case "termSignal":
          await this.signal(b.value.link, b.value.kind, b.value.sdp, b.value.candidate);
          return ack();
      }
    };
    run().catch(fail);
  }

  private async signal(linkId: number, kind: TermSignalKind, sdp: string, candidate: string): Promise<void> {
    if (linkId === 0) throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSPECIFIED, "a link id is not 0");
    if (kind === TermSignalKind.OFFER) {
      if (!sdp) throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSPECIFIED, "an offer needs its SDP");
      const link = this.links.get(linkId) ?? this.newLink(linkId);
      return this.step(link, async () => {
        const conn = await this.ensureConn(link);
        await this.service.call("signal", { conn, kind: "offer", sdp });
      });
    }
    if (kind !== TermSignalKind.CANDIDATE && kind !== TermSignalKind.END) {
      throw new TerminalError(ErrorCode.INVALID, ErrorReason.UNSPECIFIED, "a device sends offer, candidate or end");
    }
    const link = this.links.get(linkId);
    if (!link) throw new TerminalError(ErrorCode.NOT_FOUND, ErrorReason.UNSPECIFIED, "no such link");
    return this.step(link, async () => {
      const conn = link.conn;
      if (conn === undefined || link.closed) throw new TerminalError(ErrorCode.NOT_FOUND, ErrorReason.UNSPECIFIED, "no such link");
      await this.service.call("signal", kind === TermSignalKind.END ? { conn, kind: "end" } : { conn, kind: "candidate", candidate });
    });
  }

  /**
   * One terminal frame from the device on the relay path. Called as soon as
   * the frame is opened, never behind the connection's other requests.
   */
  data(v: TermDataBody): void {
    if (this.closed) return;
    const frame = v.data;
    const known = this.links.get(v.link);
    if (v.link === 0 || frame.length < MIN_TERMINAL_FRAME || frame.length > MAX_TERMINAL_FRAME) {
      // A broken frame ends that link only; the connection and its chat go on.
      if (known) this.end(known, "bad_frame", true);
      else this.status(v.link, TermPath.CLOSED, 0, "bad_frame");
      return;
    }
    if (known?.relay === "open" && known.pending.length === 0 && known.conn !== undefined) {
      if (!this.service.relay(known.conn, frame)) this.end(known, "unavailable", false);
      return;
    }
    const link = known ?? this.newLink(v.link);
    if (link.pending.length >= MAX_PENDING_FRAMES) return this.end(link, "overflow", true);
    link.pending.push(frame.slice());
    if (link.relay !== "none") return;
    link.relay = "opening";
    void this.step(link, async () => {
      const conn = await this.ensureConn(link);
      await this.service.call("relay_open", { conn });
      if (link.closed) return;
      link.relay = "open";
      for (const f of link.pending.splice(0)) {
        if (!this.service.relay(conn, f)) return this.end(link, "unavailable", false);
      }
    }).catch((err: unknown) => {
      if (!link.closed) this.end(link, this.service.closeReason(err), true);
    });
  }

  private newLink(id: number): Link {
    const link: Link = { id, conn: undefined, relay: "none", path: "none", pending: [], chain: Promise.resolve(), closed: false };
    this.links.set(id, link);
    return link;
  }

  private step(link: Link, op: () => Promise<void>): Promise<void> {
    const run = link.chain.then(op);
    link.chain = run.catch(() => undefined);
    return run;
  }

  private async ensureConn(link: Link): Promise<number> {
    if (link.closed) throw new TerminalError(ErrorCode.NOT_FOUND, ErrorReason.UNSPECIFIED, "the link closed");
    if (link.conn !== undefined) return link.conn;
    await this.service.ensure();
    const conn = await this.service.grant(this.peer.deviceKey(), this, link.id);
    if (link.closed || this.closed) {
      this.service.release(conn, true);
      throw new TerminalError(ErrorCode.NOT_FOUND, ErrorReason.UNSPECIFIED, "the link closed");
    }
    link.conn = conn;
    return conn;
  }

  /** An event of the terminal process for one of this connection's links. */
  event(linkId: number, e: Extract<DaemonEvent, { event: "signal" | "conn_state" }>): void {
    const link = this.links.get(linkId);
    if (!link || link.closed) return;
    if (e.event === "signal") {
      const kind = e.kind === "answer" ? TermSignalKind.ANSWER : e.kind === "candidate" ? TermSignalKind.CANDIDATE : TermSignalKind.END;
      this.peer.send("", { case: "termSignal", value: { link: linkId, kind, sdp: e.sdp ?? "", candidate: e.candidate ?? "", reason: e.reason ?? "" } });
      return;
    }
    if (e.state === "closed") return this.end(link, e.reason ?? "closed", false);
    link.path = e.state;
    const path = e.state === "connecting" ? TermPath.CONNECTING : e.state === "direct" ? TermPath.DIRECT : TermPath.RELAY;
    this.status(linkId, path, e.rttMs ?? 0, "");
  }

  /** The control link to the terminal process dropped: relay-only links are gone with it, direct ones live on. */
  hostDown(): void {
    for (const link of [...this.links.values()]) {
      if (link.path === "direct") {
        link.relay = "none";
        link.pending = [];
      } else {
        this.end(link, "agent_gone", false);
      }
    }
  }

  /** One relay-path terminal frame for the device: sent now, or after earlier ones within the machine's budget. */
  output(linkId: number, frame: Uint8Array): void {
    if (this.closed || !this.links.has(linkId)) return;
    if (this.queue.length === 0 && this.peer.buffered() < SOCKET_HIGH_WATER && this.service.takeToken()) {
      this.peer.send("", { case: "termData", value: { link: linkId, data: frame } });
      return;
    }
    if (this.queuedBytes + frame.length > MAX_QUEUED_BYTES) {
      const link = this.links.get(linkId);
      if (link) this.end(link, "overflow", true);
      return;
    }
    this.queue.push({ link: linkId, data: frame.slice() });
    this.queuedBytes += frame.length;
    this.service.wake(this);
  }

  /**
   * Sends held output while the budget and the device's socket allow, at
   * most `max` frames. Returns "done" when nothing is left, "budget" or
   * "socket" for what holds the rest.
   */
  flush(max: number): "done" | "budget" | "socket" {
    let sent = 0;
    while (this.queue.length > 0 && !this.closed) {
      if (sent >= max) return "budget";
      if (this.peer.buffered() >= SOCKET_HIGH_WATER) return "socket";
      if (!this.service.takeToken()) return "budget";
      const next = this.queue.shift();
      if (!next) break;
      this.queuedBytes -= next.data.length;
      if (this.links.has(next.link)) this.peer.send("", { case: "termData", value: { link: next.link, data: next.data } });
      sent++;
    }
    return "done";
  }

  private status(link: number, path: TermPath, rttMs: number, reason: string): void {
    this.peer.send("", { case: "termStatus", value: { link, path, rttMs, reason } });
  }

  /** Ends a link: the device hears why; the terminal process is told when it does not know yet. */
  private end(link: Link, reason: string, tellHost: boolean): void {
    if (link.closed) return;
    link.closed = true;
    link.pending = [];
    if (this.links.get(link.id) === link) this.links.delete(link.id);
    if (link.conn !== undefined) this.service.release(link.conn, tellHost);
    if (!this.closed) this.status(link.id, TermPath.CLOSED, 0, reason);
  }

  /** The device's connection closed: its links close in the terminal process too. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const link of [...this.links.values()]) this.end(link, "closed", true);
    this.queue.length = 0;
    this.queuedBytes = 0;
  }
}

function validDim(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_DIM;
}

/** The folder a new shell starts in: the user's home, or an existing absolute folder. */
function openCwd(cwd: string): string {
  if (!cwd) return homedir();
  let dir: boolean;
  try {
    dir = isAbsolute(cwd) && statSync(cwd).isDirectory();
  } catch {
    dir = false;
  }
  if (!dir) throw new TerminalError(ErrorCode.INVALID, ErrorReason.FOLDER_NOT_FOUND, `not a folder: ${cwd}`, cwd);
  return cwd;
}

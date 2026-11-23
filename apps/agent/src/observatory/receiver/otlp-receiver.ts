// The OTLP/HTTP JSON receiver for Claude Code's log events, on
// 127.0.0.1:<the machine's port> only. A request passes request-guard.ts,
// its body is read (read-otlp-body.ts) and answered 200 at once; the body
// waits in a bounded queue (otlp-body-queue.ts) and is parsed and filtered
// (privacy/filter-otel-record.ts) one per turn of the event loop, so Claude
// Code never waits for Observatory (a receiver that answers late slows a
// session's exit) and a burst never holds the agent up. A full queue drops
// the request and counts it. Errors never leave the receiver: they go to the
// throttled problem log, without content.
//
// The tokens are read for every request, so a rotation reaches a running
// receiver. A port another program holds is tried again now and then (the
// same port: Claude Code's settings name it), so a receiver that started
// while an old agent was still exiting comes up by itself.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { FilteredOtelRecord } from "../privacy/filtered-record.ts";
import { filterOtlpLogs } from "../privacy/filter-otel-record.ts";
import { OtlpBodyQueue } from "./otlp-body-queue.ts";
import { readOtlpBody } from "./read-otlp-body.ts";
import { type ReceiverStats, emptyReceiverStats } from "./receiver-stats.ts";
import { listenOn } from "./receiver-port.ts";
import { type ReceiverTokens, tokenMatch } from "./receiver-token.ts";
import { refuseOtlpRequest } from "./request-guard.ts";

export const MAX_OTLP_BODY_BYTES = 4 * 1024 * 1024;
export const BODY_TIMEOUT_MS = 2_000;
export const MAX_QUEUED_BODIES = 64;
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
/** How often a taken port is tried again. */
export const RELISTEN_EVERY_MS = 30_000;

/** listening; port-taken: another program has the port (tried again, never moved); failed: could not listen for another reason. */
export type ReceiverState = "stopped" | "listening" | "port-taken" | "failed";

export type OtlpReceiverOptions = {
  port: number;
  /** The tokens now (read for each request). */
  tokens: () => ReceiverTokens;
  /** Secret values to hide in the labels kept. */
  known: () => Iterable<string>;
  onRecords: (records: FilteredOtelRecord[]) => void;
  problems: (place: string, err: unknown) => void;
  now?: () => number;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  maxQueuedBodies?: number;
  relistenEveryMs?: number;
};

export class OtlpReceiver {
  readonly stats: ReceiverStats = emptyReceiverStats();
  private server: Server | undefined;
  private current: ReceiverState = "stopped";
  private readonly queue: OtlpBodyQueue;
  private relisten: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: OtlpReceiverOptions) {
    this.now = opts.now ?? Date.now;
    this.queue = new OtlpBodyQueue(opts.maxQueuedBodies ?? MAX_QUEUED_BODIES, MAX_QUEUED_BYTES, (body) => this.process(body));
  }

  get state(): ReceiverState {
    return this.current;
  }

  get port(): number {
    return this.opts.port;
  }

  /** Bodies waiting to be filtered. */
  get queueDepth(): number {
    return this.queue.depth;
  }

  /** Listens on the port (on a taken one: tries again every RELISTEN_EVERY_MS); never rejects. */
  async start(): Promise<ReceiverState> {
    if (this.server || this.relisten) return this.current;
    const { state, server } = await this.listen();
    this.server = server;
    this.current = state;
    if (this.current === "port-taken") {
      this.relisten = setInterval(() => void this.tryAgain(), this.opts.relistenEveryMs ?? RELISTEN_EVERY_MS);
      this.relisten.unref?.();
    }
    return this.current;
  }

  /** Stops listening (and trying to), closes every connection, then filters what still waits and passes it on. */
  async stop(): Promise<void> {
    clearInterval(this.relisten);
    this.relisten = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.queue.drainAll();
    this.current = "stopped";
  }

  /** A server listening on the port, or why there is none. */
  private async listen(): Promise<{ state: ReceiverState; server: Server | undefined }> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = 64;
    try {
      if ((await listenOn(server, this.opts.port)) === "taken") return { state: "port-taken", server: undefined };
    } catch (err) {
      this.opts.problems("otlp-listen", err);
      return { state: "failed", server: undefined };
    }
    server.on("error", (err) => this.opts.problems("otlp-server", err));
    return { state: "listening", server };
  }

  private async tryAgain(): Promise<void> {
    if (!this.relisten || this.server) return;
    const { state, server } = await this.listen();
    if (!this.relisten) {
      // Stopped while trying: let go of a port just taken.
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    if (state === "port-taken") return;
    clearInterval(this.relisten);
    this.relisten = undefined;
    this.server = server;
    this.current = state;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let used: "current" | "previous" | undefined;
    const tokenOk = (token: string): boolean => {
      used = tokenMatch(token, this.opts.tokens());
      return used !== undefined;
    };
    const refusal = refuseOtlpRequest(req, this.opts.port, tokenOk);
    if (refusal) {
      if (refusal.reason === "token") this.stats.unauthorized++;
      else this.stats.refused++;
      this.answer(res, refusal.status, true);
      req.resume();
      return;
    }
    if (used === "previous") {
      this.stats.previousToken++;
      this.stats.previousTokenLastAt = this.now();
    }
    const read = await readOtlpBody(req, this.opts.maxBodyBytes ?? MAX_OTLP_BODY_BYTES, this.opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
    if (read.kind === "too-large") {
      this.stats.tooLarge++;
      this.answer(res, 413, true);
    } else if (read.kind === "timeout") {
      this.stats.malformed++;
      this.answer(res, 408, true);
      req.destroy();
    } else if (read.kind === "body") {
      this.stats.requests++;
      this.answer(res, 200, false);
      if (!this.queue.push(read.body)) this.stats.queueFull++;
    }
  }

  private answer(res: ServerResponse, status: number, close: boolean): void {
    if (res.headersSent || res.destroyed) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (close) headers.connection = "close";
    res.writeHead(status, headers).end(status === 200 ? "{}" : "");
  }

  /** Parses and filters one body, passing its kept records on. */
  private process(body: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      this.stats.malformed++;
      return;
    }
    try {
      const result = filterOtlpLogs(parsed, this.opts.known(), this.now());
      this.stats.otherService += result.otherService;
      this.stats.tooLarge += result.tooLarge;
      this.stats.ignored += result.ignored;
      this.stats.malformed += result.malformed;
      this.stats.received += result.records.length;
      if (result.records.length > 0) this.opts.onRecords(result.records);
    } catch (err) {
      this.opts.problems("otlp-records", err);
    }
  }
}

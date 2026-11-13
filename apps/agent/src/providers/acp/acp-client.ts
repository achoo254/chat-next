// A client of the Agent Client Protocol (ACP): JSON-RPC 2.0 as one JSON
// object a line over the stdio of an AI's own CLI (`agy acp`). Shared by every
// adapter that speaks ACP; what the messages mean is the adapter's business.
//
// Requests from us carry numeric ids; requests from the AI (permission
// prompts) may carry string ids, answered with the id as it came. A message
// that is not JSON, a method nobody handles and an answer nobody waits for
// are logged and skipped: an AI's newer protocol never breaks a session. When
// the process ends, every request waiting fails and the client is done; the
// adapter starts another.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type AcpLaunch = { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

type JsonRpcId = number | string;
type Incoming = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

/** An error the AI answered a request with. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** The AI's process is gone (or never started); requests on this client fail. */
export class AcpClosed extends Error {}

export type AcpClientOptions = {
  launch: AcpLaunch;
  log: (line: string) => void;
  /** How long a request waits for its answer; per request when given there. */
  requestTimeoutMs?: number;
  /** Starts the process (tests pass a fake). */
  spawnProcess?: (launch: AcpLaunch) => AcpProcess;
};

/** The part of a child process the client uses. */
export type AcpProcess = Pick<ChildProcessByStdio<Writable, Readable, Readable>, "stdin" | "stdout" | "stderr" | "kill" | "once">;

/** Longest line the client takes from the AI; longer ones are skipped. */
const MAX_LINE = 16 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 60_000;

export class AcpClient {
  private readonly proc: AcpProcess;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly notifications = new Map<string, (params: unknown) => void>();
  private readonly requests = new Map<string, (params: unknown) => Promise<unknown>>();
  private buffer = "";
  private ended: Error | undefined;
  /** Settles once the process is gone. */
  readonly exited: Promise<void>;

  constructor(private readonly opts: AcpClientOptions) {
    this.proc = (opts.spawnProcess ?? spawnAcp)(opts.launch);
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.proc.stderr.setEncoding("utf8");
    // The AI's own log goes nowhere: it may name files or accounts.
    this.proc.stderr.on("data", () => undefined);
    this.proc.stdin.on("error", () => undefined);
    this.exited = new Promise<void>((resolve) => {
      this.proc.once("exit", (code, signal) => {
        this.end(new AcpClosed(`the AI's process ended (${signal ?? `exit ${String(code)}`})`));
        resolve();
      });
      this.proc.once("error", (err) => {
        this.end(new AcpClosed(`the AI's process could not start (${err.message})`));
        resolve();
      });
    });
  }

  get closed(): boolean {
    return this.ended !== undefined;
  }

  /** Handles a notification the AI sends (`session/update`); one handler per method, the last set. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notifications.set(method, handler);
  }

  /** Answers a request the AI sends (`session/request_permission`); a handler that throws answers with an error. */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requests.set(method, handler);
  }

  request<T>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiting.delete(id);
              reject(new AcpError(`${method} got no answer within ${Math.round(timeoutMs / 1000)} s`, -32001));
            }, timeoutMs)
          : undefined;
      timer?.unref?.();
      this.waiting.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.ended) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Stops the AI's process; waiting requests fail. */
  async close(): Promise<void> {
    if (!this.ended) this.proc.kill("SIGTERM");
    await this.exited;
  }

  private write(msg: unknown): void {
    try {
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.end(new AcpClosed(`the AI's process does not take input (${(err as Error).message})`));
    }
  }

  private end(err: Error): void {
    if (this.ended) return;
    this.ended = err;
    for (const w of this.waiting.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiting.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
    }
    if (this.buffer.length > MAX_LINE) {
      this.opts.log("acp: a line too long from the AI was skipped");
      this.buffer = "";
    }
  }

  private handleLine(line: string): void {
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      this.opts.log("acp: a line that is not JSON was skipped");
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method !== undefined && msg.id !== undefined) return void this.answer(msg.id, msg.method, msg.params);
    if (msg.method !== undefined) {
      const handler = this.notifications.get(msg.method);
      if (handler) handler(msg.params);
      else this.opts.log(`acp: notification ${msg.method.slice(0, 60)} skipped`);
      return;
    }
    if (typeof msg.id !== "number") return;
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (w.timer) clearTimeout(w.timer);
    if (msg.error) w.reject(new AcpError(msg.error.message ?? "the AI refused the request", msg.error.code ?? -32000));
    else w.resolve(msg.result);
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requests.get(method);
    if (!handler) {
      this.opts.log(`acp: request ${method.slice(0, 60)} refused (not handled)`);
      return this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message.slice(0, 300) } });
    }
  }
}

function spawnAcp(launch: AcpLaunch): AcpProcess {
  return spawn(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

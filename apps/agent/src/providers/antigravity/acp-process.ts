// One `agy acp` process for every Antigravity session of the machine and for
// listing agy's sessions. agy signs in once for the whole machine (its
// Keychain item), so one process serves all; it starts on first use and
// again after it ends. When it ends, its open sessions are lost (the core
// opens each again, resumed, with its next message).
import { homedir } from "node:os";
import { AcpClient, type AcpProcess, type AcpLaunch } from "../acp/acp-client.ts";
import { AcpRouter, type AcpSession } from "../acp/acp-session.ts";
import { agyEnv } from "./agy.ts";

/** Set in agy's environment for tunelo's own sessions: tunelo's liveness hook acts only on those. */
export const TUNELO_AGY_ENV = "TUNELO_AGY";

export type AgyProcessOptions = {
  findBinary: () => Promise<string | null>;
  log: (line: string) => void;
  spawnProcess?: (launch: AcpLaunch) => AcpProcess;
};

/** An Antigravity turn runs: agy may not stop now. */
export class AgyBusy extends Error {
  constructor(readonly title: string) {
    super("an Antigravity turn is running; switch once it ends");
  }
}

type Live = { client: AcpClient; router: AcpRouter; sessions: Set<AcpSession> };

export class AgyAcp {
  private live: Promise<Live> | undefined;
  /** Settles when no account switch holds agy stopped; new processes wait for it. */
  private gate: Promise<void> = Promise.resolve();
  /** The process `live` gave, once started. */
  private current: Live | undefined;

  constructor(private readonly opts: AgyProcessOptions) {}

  /** The running process, started (and initialized) when there is none. */
  get(): Promise<Live> {
    const cur = this.live;
    if (cur) return cur;
    const next = this.gate.then(() => this.start());
    this.live = next;
    next.catch(() => {
      if (this.live === next) this.live = undefined;
    });
    return next;
  }

  private async start(): Promise<Live> {
    const bin = await this.opts.findBinary();
    if (!bin) throw new Error("agy is not installed");
    const client = new AcpClient({
      launch: { file: bin, args: ["acp"], env: agyEnv({ [TUNELO_AGY_ENV]: "1" }), cwd: homedir() },
      log: this.opts.log,
      ...(this.opts.spawnProcess ? { spawnProcess: this.opts.spawnProcess } : {}),
    });
    const live: Live = { client, router: new AcpRouter(client, this.opts.log), sessions: new Set() };
    void client.exited.then(() => {
      if (this.current === live) {
        this.current = undefined;
        this.live = undefined;
      }
      for (const s of live.sessions) s.lost("agy stopped; the session opens again with the next message");
      live.sessions.clear();
    });
    try {
      await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 30_000);
    } catch (err) {
      // An agy that never answered is not left running.
      await client.close();
      throw err;
    }
    this.current = live;
    return live;
  }

  /** Stops the process (an account switch, or the service stopping); sessions on it are lost. */
  async stop(): Promise<void> {
    const cur = this.live;
    this.live = undefined;
    this.current = undefined;
    if (!cur) return;
    try {
      await (await cur).client.close();
    } catch {
      // it never started
    }
  }

  /**
   * Runs `fn` with tunelo's agy stopped and no new one starting until it
   * ends (an account switch writes agy's sign-in meanwhile). Refused, with
   * nothing stopped, while `busy()` names a running turn.
   */
  async whileStopped<T>(busy: () => string[], fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const prev = this.gate;
    this.gate = new Promise<void>((r) => (release = r));
    try {
      await prev;
      const running = busy();
      if (running.length > 0) throw new AgyBusy(running[0] ?? "");
      await this.stop();
      return await fn();
    } finally {
      release();
    }
  }

  /** Sessions open on the process now. */
  openSessions(): number {
    return this.current?.sessions.size ?? 0;
  }
}

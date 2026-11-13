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

type Live = { client: AcpClient; router: AcpRouter; sessions: Set<AcpSession> };

export class AgyAcp {
  private live: Promise<Live> | undefined;
  /** The process `live` gave, once started. */
  private current: Live | undefined;

  constructor(private readonly opts: AgyProcessOptions) {}

  /** The running process, started (and initialized) when there is none. */
  get(): Promise<Live> {
    const cur = this.live;
    if (cur) return cur;
    const next = this.start();
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
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 30_000);
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

  /** Sessions open on the process now. */
  openSessions(): number {
    return this.current?.sessions.size ?? 0;
  }
}

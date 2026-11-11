// Terminal permission is chat permission: a link is granted to a device that
// is paired with this machine now, under that device's key, so revoking the
// device closes its terminals too. The device key comes from the end-to-end
// session, never from the request. Nothing here is single-use or replay
// state: the sealed frames already carry a counter that refuses replays.
import { randomInt } from "node:crypto";
import { toBase64Url } from "@achoo254/chat-remote-protocol";
import { ControlError } from "./host-link.ts";

/** A grant's lifetime while no path (direct or relay) is open on it. */
export const GRANT_MS = 60_000;
/** Tries of another connection id when one is still used by a peer from before an agent restart. */
const CONN_ID_TRIES = 4;

/** The device may not open a terminal (not paired, or revoked). */
export class TerminalDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalDenied";
  }
}

export type GrantOptions = {
  isPaired: (deviceKey: Uint8Array) => boolean;
  call: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
  /** A refusal the agent decided (the terminal process audits its own). */
  denied: (deviceKey: Uint8Array, why: string) => void;
};

export class Grants {
  // Connection ids of the terminal process outlive this agent (direct peers
  // stay open across a restart): a new agent starts at a random point.
  private next = randomInt(1, 0x7fff_ffff);
  /** Ids whose grant was sent and not answered yet. */
  private readonly granting = new Set<number>();

  constructor(private readonly opts: GrantOptions) {}

  private take(): number {
    const id = this.next;
    this.next = this.next >= 0xffff_fffe ? 1 : this.next + 1;
    return id;
  }

  /** Grants a new connection to the device; resolves with its id in the terminal process. */
  async grant(deviceKey: Uint8Array): Promise<number> {
    if (!this.opts.isPaired(deviceKey)) {
      this.opts.denied(deviceKey, "not paired");
      throw new TerminalDenied("this device is not paired with the machine");
    }
    for (let i = 0; ; i++) {
      const conn = this.take();
      this.granting.add(conn);
      try {
        await this.opts.call("grant", { conn, deviceKey: toBase64Url(deviceKey), expiresMs: GRANT_MS });
        return conn;
      } catch (err) {
        if (err instanceof ControlError && err.code === "revoked") throw new TerminalDenied("this device was revoked");
        // bad_request: that id is still a live connection of the terminal process.
        if (!(err instanceof ControlError && err.code === "bad_request") || i + 1 >= CONN_ID_TRIES) throw err;
      } finally {
        this.granting.delete(conn);
      }
    }
  }

  /** A grant of `conn` is on its way to the terminal process. */
  isGranting(conn: number): boolean {
    return this.granting.has(conn);
  }
}

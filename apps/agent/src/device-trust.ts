// Which devices may open a link to this machine: the live device keys of the
// owner's account, as the chat server lists them in every heartbeat
// (config.ts keeps the list and when it came, so a restart while Chat is down
// still knows them). A key the list does not have yet makes the machine ask
// Chat again at once (a heartbeat), at most once per key every 30 s, so a
// device registered a moment ago gets in without waiting for the next beat
// and a stranger cannot make the machine call Chat in a loop. A list older
// than 24 hours (Chat unreachable since) refuses every new handshake; links
// already open stay.
import { toBase64Url } from "@achoo254/chat-remote-protocol";
import type { ConfigStore } from "./config.ts";

export type TrustVerdict = "trusted" | "revoked" | "unknown" | "stale";

/** How long a key Chat did not list is not asked about again. */
export const UNKNOWN_KEY_RETRY_MS = 30_000;
/** Keys remembered as unknown at most; older entries go first. */
const MAX_UNKNOWN_KEYS = 1_000;

export type DeviceTrustOptions = {
  config: ConfigStore;
  now?: () => number;
};

export class DeviceTrust {
  private refresher: (() => Promise<void>) | undefined;
  private refreshing: Promise<void> | undefined;
  /** Base64url key → until when it is not asked about again. */
  private readonly unknownUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: DeviceTrustOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** How to ask Chat for the list now (a heartbeat); wired once the machine is registered, unset when it leaves. */
  setRefresh(fn: (() => Promise<void>) | undefined): void {
    this.refresher = fn;
  }

  /** The verdict from what is stored, without asking Chat. */
  verdict(key: Uint8Array): TrustVerdict {
    const status = this.opts.config.deviceStatus(key);
    if (status === "revoked") return "revoked";
    if (this.opts.config.trustStale(this.now())) return "stale";
    return status;
  }

  /**
   * The verdict for a device that is shaking hands. A key that is not trusted
   * yet (or a list too old) asks Chat once, unless that key was asked about
   * in the last 30 s; concurrent handshakes share one call.
   */
  async check(key: Uint8Array): Promise<TrustVerdict> {
    const first = this.verdict(key);
    if (first === "trusted" || first === "revoked" || !this.refresher) return first;
    const k = toBase64Url(key);
    const now = this.now();
    if ((this.unknownUntil.get(k) ?? 0) > now) return first;
    await this.refresh();
    const after = this.verdict(key);
    if (after !== "trusted") this.remember(k, this.now() + UNKNOWN_KEY_RETRY_MS);
    else this.unknownUntil.delete(k);
    return after;
  }

  /** The list changed: a key it now holds is no longer remembered as unknown. */
  listed(keys: readonly string[]): void {
    for (const k of keys) this.unknownUntil.delete(k);
  }

  private refresh(): Promise<void> {
    const fn = this.refresher;
    if (!fn) return Promise.resolve();
    this.refreshing ??= fn()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private remember(key: string, until: number): void {
    this.unknownUntil.delete(key);
    this.unknownUntil.set(key, until);
    const now = this.now();
    for (const [k, t] of this.unknownUntil) {
      if (this.unknownUntil.size <= MAX_UNKNOWN_KEYS && t > now) break;
      this.unknownUntil.delete(k);
    }
  }
}

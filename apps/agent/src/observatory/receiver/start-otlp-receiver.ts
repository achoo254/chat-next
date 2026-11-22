// Starting the agent's OTLP receiver: its token (made once, receiver-token.ts),
// its port (the one in the config; picked from the range and saved there the
// first time, receiver-port.ts), then listening. Never rejects: what went
// wrong is reported and shows in the state. A token file that cannot be read
// is never replaced: the receiver stays off (`token-unreadable`) until the
// next start.
import type { ConfigStore } from "../../config.ts";
import type { FilteredOtelRecord } from "../privacy/filtered-record.ts";
import { OtlpReceiver, type ReceiverState } from "./otlp-receiver.ts";
import { isOtlpPort, pickFreePort } from "./receiver-port.ts";
import { type ReceiverTokens, TokenUnreadable, loadOrCreateTokens } from "./receiver-token.ts";

/** The receiver's state; off: Observatory is off or stopped; no-port: no free port in the range when one had to be picked; token-unreadable: see the module comment. */
export type ReceiverStatusState = ReceiverState | "off" | "no-port" | "token-unreadable";

export type StartReceiverOptions = {
  config: ConfigStore;
  dataDir: string;
  /** The tokens now (the service's, which a rotation replaces); undefined before they are loaded. */
  tokens: () => ReceiverTokens | undefined;
  /** Secret values to hide in the labels kept (read for each request). */
  known: () => Iterable<string>;
  onRecords: (records: FilteredOtelRecord[]) => void;
  problems: (place: string, err: unknown) => void;
  now: () => number;
  /** Tries of an unreadable token file (tests pass none). */
  tokenRetryMs?: readonly number[];
};

export type StartedReceiver = { receiver: OtlpReceiver | undefined; tokens: ReceiverTokens | undefined; state: ReceiverStatusState };

export async function startOtlpReceiver(o: StartReceiverOptions): Promise<StartedReceiver> {
  let tokens: ReceiverTokens | undefined;
  try {
    tokens = await loadOrCreateTokens(o.dataDir, o.tokenRetryMs);
  } catch (err) {
    o.problems("otlp-token", err);
    return { receiver: undefined, tokens: undefined, state: err instanceof TokenUnreadable ? "token-unreadable" : "failed" };
  }
  const loaded = tokens;
  try {
    let port = o.config.get().observatory?.otlpPort;
    if (!isOtlpPort(port)) {
      port = await pickFreePort();
      if (port === undefined) return { receiver: undefined, tokens, state: "no-port" };
      const picked = port;
      o.config.update((c) => (c.observatory = { ...c.observatory, otlpPort: picked }));
    }
    // A request arriving before the service holds the tokens still checks against the ones just loaded.
    const receiver = new OtlpReceiver({ port, tokens: () => o.tokens() ?? loaded, known: o.known, onRecords: o.onRecords, problems: o.problems, now: o.now });
    return { receiver, tokens, state: await receiver.start() };
  } catch (err) {
    o.problems("otlp-start", err);
    return { receiver: undefined, tokens, state: "failed" };
  }
}

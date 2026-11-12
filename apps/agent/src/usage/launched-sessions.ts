// The sessions the agent itself opened (a chat thread started or resumed, a
// thread's CLI opened in the terminal), by the AI's own session id, kept in
// the ledger. "Calls through the app" are the calls of these sessions: what
// started a session, as its transcript says, cannot tell, since the app's
// terminal runs the plain CLI.
import type { Ledger } from "./ledger.ts";

const ID_MAX = 200;

/** An id taken from outside: a short string without control characters. */
function cleanId(s: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return s.length > 0 && s.length <= ID_MAX && !/[\u0000-\u001f\u007f]/.test(s) ? s : undefined;
}

export class LaunchedSessions {
  constructor(
    private readonly ledger: Ledger,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Records a session the agent opened (once; later calls for it change nothing). False when the id is not one to keep. */
  add(provider: string, sessionId: string): boolean {
    const p = cleanId(provider);
    const id = cleanId(sessionId);
    if (!p || !id) return false;
    if (this.has(p, id)) return true;
    void this.ledger
      .update((d) => {
        const byId = (d.launched[p] ??= {});
        byId[id] ??= Date.now();
      })
      .then(() => this.ledger.save())
      .catch((err: unknown) => this.log(`usage: an app session was not recorded (${(err as Error).message})`));
    return true;
  }

  /** Whether the agent opened this session. */
  has(provider: string, sessionId: string): boolean {
    return this.ledger.snapshot().launched[provider]?.[sessionId] !== undefined;
  }
}

// Hints while a session still runs: after each scan, the rules switched on
// are run over the main sessions with a call in the last ACTIVE_WINDOW_MS,
// and what fired and was not sent before goes to the user's devices in one
// delivery. A hint is sent at most once per rule and session: the time it
// was sent is kept in the ledger's index (so it holds across restarts, and
// the G6 measure counts only sessions whose hint arrived while they ran).
// A delivery that reached no device is not recorded and is tried again
// after the next scan, while the session is still running.
//
// A hint holds a rule code, numbers, the session's id and its repository
// key: never a message, a title or a file's path.
import { DAY_MS, type Ledger, monthStart, shiftMonth, localMonth } from "./ledger.ts";
import { repoOf } from "./report.ts";
import { type RuleCode, type RuleSwitches, evaluate } from "./rules.ts";

/** A session with a main call this recent is still running. */
export const ACTIVE_WINDOW_MS = 30 * 60_000;

export type UsageHint = {
  rule: RuleCode;
  provider: string;
  sessionId: string;
  repoKey: string;
  turn: number;
  at: number;
  value: number;
  experimental: boolean;
};

export type UsageNotifierOptions = {
  ledger: Ledger;
  /** The rules switched on now. */
  rules: () => RuleSwitches;
  /** Delivers the hints to the user's devices; true when at least one device got them (or will, through a push). */
  deliver: (hints: UsageHint[], sentAt: number) => Promise<boolean>;
  now?: () => number;
  log?: (line: string) => void;
};

export class UsageNotifier {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Hints were due and not delivered: tried again even after a scan that read nothing. */
  private pending = false;

  constructor(private readonly opts: UsageNotifierOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * Sends the hints due now; resolves with those delivered (and recorded).
   * After a scan that read nothing (`changed` false) nothing new can be due,
   * so the ledger is not read unless an earlier delivery failed.
   */
  async check(changed = true): Promise<UsageHint[]> {
    if (!changed && !this.pending) return [];
    const { ledger } = this.opts;
    await ledger.open();
    if (ledger.blocked) return [];
    const rules = this.opts.rules();
    if (!Object.values(rules).some(Boolean)) return [];
    const now = this.now();
    const recent = await ledger.turns({ from: now - ACTIVE_WINDOW_MS, to: now + 60_000, keep: (t) => !t.subagent, hold: true });
    const running = new Set(recent.map((t) => `${t.provider}\u0000${t.sessionId}`));
    if (running.size === 0) return [];
    // The whole of each running session: from the start of last month, which a running session does not go past.
    const from = Math.min(monthStart(shiftMonth(localMonth(now), -1)), now - DAY_MS);
    const turns = await ledger.turns({ from, to: now + 60_000, keep: (t) => running.has(`${t.provider}\u0000${t.sessionId}`), hold: true });
    const index = ledger.snapshot();
    const due: UsageHint[] = evaluate(turns, rules)
      .filter((s) => ledger.notifiedAt(s.provider, s.sessionId, s.rule) === undefined)
      .map((s) => ({
        rule: s.rule,
        provider: s.provider,
        sessionId: s.sessionId,
        repoKey: repoOf(index, s.cwd),
        turn: s.turn,
        at: s.at,
        value: s.value,
        experimental: s.experimental,
      }));
    this.pending = due.length > 0;
    if (due.length === 0) return [];
    let delivered = false;
    try {
      delivered = await this.opts.deliver(due, now);
    } catch (err) {
      this.log(`usage: hints not delivered (${(err as Error).message})`);
    }
    if (!delivered) return [];
    this.pending = false;
    await ledger.recordNotified(due, now);
    await ledger.save();
    return due;
  }
}

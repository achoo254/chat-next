// Problems of the office view, for the machine's log. The office never lets
// an error reach the core's own work, but a problem must not vanish either:
// each place logs at most one line per interval, with how many times it
// happened since. A line names the place and the error's kind (its name or
// system code), never its message: messages may carry paths or content.

/** Where office problems go: one line each. */
export type OfficeLog = (line: string) => void;

export const PROBLEM_LOG_INTERVAL_MS = 60_000;

/** The error's kind: a system code (`EACCES`), else its class name; never its message. */
export function errorKind(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) return name;
  }
  return typeof err;
}

export class OfficeProblems {
  private readonly places = new Map<string, { lastAt: number; since: number }>();

  constructor(
    private readonly log: OfficeLog,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = PROBLEM_LOG_INTERVAL_MS,
  ) {}

  /** A problem at `place` (a fixed name in the code, never data). */
  report(place: string, err: unknown): void {
    const at = this.now();
    const p = this.places.get(place);
    if (p && at - p.lastAt < this.intervalMs) {
      p.since++;
      return;
    }
    const more = p && p.since > 0 ? ` (+${p.since} since the last line)` : "";
    this.places.set(place, { lastAt: at, since: 0 });
    this.log(`office: ${place} failed: ${errorKind(err)}${more}`);
  }
}

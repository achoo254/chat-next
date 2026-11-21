// The day a rolled-up row is counted on: its calendar day in a given IANA
// time zone, as YYYY-MM-DD text (retention.ts).
import { ObservatoryStoreError } from "./store-errors.ts";

/** The machine's time zone (an IANA name). */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A function giving the YYYY-MM-DD day of a Unix ms time in `timeZone`; throws ObservatoryStoreError for an unknown zone. */
export function dayFormatter(timeZone: string): (ms: number) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    // en-CA formats dates as YYYY-MM-DD.
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw new ObservatoryStoreError(`unknown time zone for the daily totals: ${timeZone}`);
  }
  return (ms) => fmt.format(ms);
}

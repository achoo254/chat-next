// Content as Observatory stores it, in two passes so a secret is never cut
// in two and missed:
//
// 1. window (the hook process, which knows no secret value of the machine):
//    the first REDACT_WINDOW_CHARS, redacted by pattern (mcp/redact.ts shapes
//    and secret-named values), home folder and account name hidden; when the
//    value went on, its last WINDOW_TAIL_GUARD_CHARS dropped too (a secret the
//    window cut is not recognised) and `truncated` set. At most about 8 KB goes
//    to the spool, with the flag beside it (never a mark in the text: a value
//    may end with "…" of its own).
// 2. final (the agent): redacted again with the machine's secret values, then
//    cut to EXCERPT_MAX_CHARS, again leaving out the guard at the end of a
//    value the window cut. A machine secret anywhere in the first 2 KB is
//    therefore whole when the agent looks for it. A stored value that was cut
//    ends with CUT_MARK, for whoever reads it.
//
// An agent-side source (the SDK hook callbacks) runs both passes at once.
import { hideNamedSecrets, redact } from "../../mcp/redact.ts";
import { EXCERPT_MAX_CHARS, REDACT_WINDOW_CHARS, WINDOW_TAIL_GUARD_CHARS, cutChars } from "./privacy-text.ts";

/** Ends a stored value that was cut (display only: nothing reads it back as a flag). */
export const CUT_MARK = "…";

/** What else a pass hides (the home folder, the account name: home-and-account.ts). */
export type Hide = (text: string) => string;
const nothing: Hide = (t) => t;

/** What pass 1 keeps: the redacted window, and whether the value went on past it. */
export type Windowed = { text: string; truncated: boolean };

/** Redaction by pattern and by `known` values: process secrets, JWT, Bearer, credential shapes, secret-named values. */
function scrub(text: string, known: Iterable<string>): string {
  return hideNamedSecrets(redact(text, known));
}

/** Pass 1 (see the module comment): at most about REDACT_WINDOW_CHARS. */
export function windowExcerpt(text: string, known: Iterable<string> = [], hide: Hide = nothing): Windowed {
  const truncated = text.length > REDACT_WINDOW_CHARS;
  const clean = hide(scrub(cutChars(text, REDACT_WINDOW_CHARS), known));
  return { text: truncated ? cutChars(clean, Math.max(0, clean.length - WINDOW_TAIL_GUARD_CHARS)) : clean, truncated };
}

/** Pass 2 (see the module comment) on what pass 1 kept: at most EXCERPT_MAX_CHARS plus CUT_MARK. */
export function finalExcerpt(windowed: Windowed, known: Iterable<string> = [], hide: Hide = nothing): string {
  const clean = hide(scrub(windowed.text, known));
  const limit = windowed.truncated ? Math.min(EXCERPT_MAX_CHARS, Math.max(0, clean.length - WINDOW_TAIL_GUARD_CHARS)) : EXCERPT_MAX_CHARS;
  return clean.length > limit || windowed.truncated ? `${cutChars(clean, limit)}${CUT_MARK}` : clean;
}

/** Both passes at once, for a source inside the agent. */
export function excerpt(text: string, known: Iterable<string> = [], hide: Hide = nothing): string {
  return finalExcerpt(windowExcerpt(text, known, hide), known, hide);
}

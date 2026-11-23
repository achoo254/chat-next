// The context window of the model a Claude Code session runs, for the Live
// Map's "how full is the context" (hub/live-state.ts) and the context rule of
// the bottleneck runner. Read from what Claude Code's own records carry: the
// OpenTelemetry `api_request` record names the model by its API id
// (`claude-sonnet-5-5`, `claude-haiku-4-5-20251001`), and a session asked for
// the 1M-token window (`--model 'sonnet[1m]'`) is named the same: its record
// carries no attribute of the window (checked on Claude Code 2.1.330, both
// runs side by side). So:
//
// - a model named with `[1m]` (as a hook or a device may give it) has the 1M
//   window;
// - a Claude model whose context in the session already went past the
//   standard window has the 1M one (nothing else holds that much);
// - any other Claude model has the standard window, assumed: a 1M session
//   reads five times too full until its context passes 200 000 tokens;
// - a model that is not a Claude model id has no known window: no percent.

/** The window of every Claude model without the long-context option. */
export const STANDARD_WINDOW = 200_000;
/** The window of a session that asked for the long context (`[1m]`). */
export const LONG_WINDOW = 1_000_000;

/** A Claude model's API id: family, version (`5-5`, `4-1`), maybe a date, maybe `[1m]`. */
const CLAUDE_MODEL = /^claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?(\[1m\])?$/i;

export type ContextWindow = {
  tokens: number;
  /** The standard window taken for a model that may have the long one (see the file's head). */
  assumed: boolean;
};

/**
 * The context window of `model`, given the largest context (input, cache
 * read and cache writes of one request) seen in the session so far;
 * undefined for a model that is not a Claude model id.
 */
export function contextWindowOf(model: string | null | undefined, largestContext = 0): ContextWindow | undefined {
  const m = CLAUDE_MODEL.exec((model ?? "").trim());
  if (!m) return undefined;
  if (m[1] !== undefined || largestContext > STANDARD_WINDOW) return { tokens: LONG_WINDOW, assumed: false };
  return { tokens: STANDARD_WINDOW, assumed: true };
}

/** The context one API request carried: its input, cache read and both cache writes. */
export function contextTokensOf(r: { inputTokens: number | null; cacheReadTokens: number | null; cacheWrite5mTokens: number | null; cacheWrite1hTokens: number | null }): number {
  return (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWrite5mTokens ?? 0) + (r.cacheWrite1hTokens ?? 0);
}

// The context window of a Claude Code session's model, the same rule as the
// machine's (apps/agent/src/observatory/live-map/model-window.ts, and
// docs/observatory-wire.md section 6.3), so a replay works out the context's
// fill at a moment as a live view was sent it:
//
// - a model named with `[1m]` has the 1M window;
// - a Claude model whose context in the session already went past the
//   standard window has the 1M one (nothing else holds that much);
// - any other Claude model has the standard window, assumed: Claude Code's
//   records name a 1M session's model the same as a standard one, so such a
//   session reads five times too full until its context passes 200 000 tokens;
// - a model that is not a Claude model id has no known window: no percent.
//
// Keep this file and the machine's in step: a change to one is a change to both.

/** The window of every Claude model without the long-context option. */
export const STANDARD_WINDOW = 200_000;
/** The window of a session that asked for the long context (`[1m]`). */
export const LONG_WINDOW = 1_000_000;

/** A Claude model's API id: family, version (`5-5`, `4-1`), maybe a date, maybe `[1m]`. */
const CLAUDE_MODEL = /^claude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?(\[1m\])?$/i;

export interface ContextWindow {
	readonly tokens: number;
	/** The standard window taken for a model that may have the long one: the percent is approximate. */
	readonly assumed: boolean;
}

/**
 * The context window of `model`, given the largest context (input, cache
 * read and cache writes of one request) seen in the session so far;
 * undefined for a model that is not a Claude model id.
 */
export function contextWindowOf(model: string | null | undefined, largestContext = 0): ContextWindow | undefined {
	const m = CLAUDE_MODEL.exec((model ?? "").trim());
	if (m === null) return undefined;
	if (m[1] !== undefined || largestContext > STANDARD_WINDOW) return { tokens: LONG_WINDOW, assumed: false };
	return { tokens: STANDARD_WINDOW, assumed: true };
}

// The watched machine's clock as the viewer sees it. Event times (`at`) are
// the machine's milliseconds, while the card's runtime, the done hold, the
// pipeline's timers, the roads' p95 colour and the content asks compare them
// with "now": the viewer's Date.now() is off by the two clocks' skew, so a
// machine 5 s ahead shows every running call 5 s short and holds a finished
// one 5 s too long.
//
// The skew is estimated per watched session from the events pushed live (not
// the snapshot's, which can be hours old): an event happened before the
// machine sent it, so its moment (a call's end when it has ended, else its
// `at`) minus the time the viewer received it is a lower bound of the skew,
// close to it for a fresh event. The estimate is the largest such bound seen,
// so later fresh events refine it. A bound further than MAX_SKEW_MS either way
// is not news (a backlog read after a restart, a late row) and is ignored, so
// the estimate stays within that range. CI events carry GitHub's times, and
// bottleneck findings their window's: neither is sampled.
import type { LiveMapEvent } from "./live-map-types.ts";

/** Skews further than this (either way) are not taken. */
export const MAX_SKEW_MS = 5 * 60_000;

/** When `e` happened on the machine, as far as the event tells (null: it does not tell the machine's clock). */
function momentOf(e: LiveMapEvent): number | null {
	switch (e.kind) {
		case "tool":
		case "api":
			return e.at + (e.durationMs ?? 0);
		case "subagent":
			return e.endedAt > 0 ? e.endedAt : e.at;
		case "prompt":
		case "instruction":
		case "git":
			return e.at;
		case "lifecycle":
			return e.name.startsWith("ci_") ? null : e.at;
		default:
			return null;
	}
}

/**
 * The skew (machine minus viewer, ms) after `events` were received at
 * `receivedAt` (viewer ms), refined from `current` (null: no estimate yet).
 */
export function refineSkew(current: number | null, events: readonly LiveMapEvent[], receivedAt: number): number | null {
	let best = current;
	for (const e of events) {
		const moment = momentOf(e);
		if (moment === null) continue;
		const bound = moment - receivedAt;
		if (Math.abs(bound) > MAX_SKEW_MS) continue;
		if (best === null || bound > best) best = bound;
	}
	return best;
}

/** The machine's "now" for a viewer time and a skew. */
export const machineNow = (viewerNow: number, skewMs: number): number => viewerNow + skewMs;

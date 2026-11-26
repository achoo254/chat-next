// What a running session's own turns say about its usage, for the chat's
// status line: the context of its latest turn that reported it, the cost of
// the loaded turns at API prices (as the machine estimates each turn), and
// whether the context is near the threshold of the machine's "Context lớn"
// rule (usage-insights.ts RULE_LIMITS), so the chat can suggest compacting
// before the rule fires rather than after. Pure.
import type { Item } from "@achoo254/chat-proto/remote/remote";
import { RULE_LIMITS } from "./usage-insights.ts";

/** From this share of the context threshold the status line shows the context. */
export const CONTEXT_SHOW_AT = 2 / 3;
/** From this share of the context threshold the chat suggests compacting. */
export const CONTEXT_NEAR_AT = 0.9;

export interface SessionMeter {
	/** Context tokens after the latest turn that reported them; null when none did. */
	readonly context: number | null;
	/** Turns with a cost estimate among the loaded ones. */
	readonly pricedTurns: number;
	/** Sum of the loaded turns' cost estimates, in dollars. */
	readonly costUsd: number;
	/** The context is worth showing (CONTEXT_SHOW_AT of the threshold). */
	readonly show: boolean;
	/** The context is near the threshold (CONTEXT_NEAR_AT). */
	readonly near: boolean;
}

export function sessionMeter(items: readonly Item[]): SessionMeter {
	let context: number | null = null;
	let pricedTurns = 0;
	let costUsd = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		const b = items[i]?.body;
		if (b?.case !== "turn") continue;
		if (context === null && b.value.contextTokens > 0n) context = Number(b.value.contextTokens);
		if (b.value.costUsdEstimate > 0) {
			pricedTurns++;
			costUsd += b.value.costUsdEstimate;
		}
	}
	const limit = RULE_LIMITS.maxContext;
	return { context, pricedTurns, costUsd, show: context !== null && context >= limit * CONTEXT_SHOW_AT, near: context !== null && context >= limit * CONTEXT_NEAR_AT };
}

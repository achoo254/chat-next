// A tool call's description and output line for the activity card and a
// district's board, through the one path content leaves the machine: asked
// by id (observatory-client.ts eventContent, as the event detail does), only
// when the viewer has a session to ask (`source`), "Ẩn chi tiết" is off and
// the call has ended (Claude Code stores the content with the call's end).
// The project's content switch is the machine's: an "off" answer says so.
// And a ticking clock for runtimes that only runs while asked to.
import { useEffect, useState } from "react";
import { parseToolContent, type ToolContent } from "./activity-card-model.ts";
import { eventContent, type ObservatoryLink } from "./observatory-client.ts";

/** Where content can be asked: the watched session on its machine's link. */
export interface ContentSource {
	readonly link: ObservatoryLink;
	readonly sessionId: string;
	readonly online: boolean;
}

export type ToolContentAnswer =
	| { readonly kind: "hidden" | "unavailable" | "pending" | "loading" | "failed" | "off" | "none" | "not_yet" }
	| { readonly kind: "ok"; readonly content: ToolContent };

/** The content of `eventId` (null: none asked), read for the card. `ended`: the call has ended (else "pending"). */
export function useToolContent(source: ContentSource | null, eventId: string | null, ended: boolean, hide: boolean): ToolContentAnswer {
	const key = source === null || eventId === null || hide || !ended || !source.online ? null : `${source.sessionId}\n${eventId}`;
	const [answer, setAnswer] = useState<{ key: string; value: ToolContentAnswer } | null>(null);
	useEffect(() => {
		if (key === null || source === null || eventId === null) return;
		let active = true;
		eventContent(source.link, source.sessionId, eventId).then(
			(c) => {
				if (!active) return;
				const value: ToolContentAnswer = c.state === "stored" ? { kind: "ok", content: parseToolContent(c.text) } : { kind: c.state === "unknown" ? "none" : c.state };
				setAnswer({ key, value });
			},
			(error: unknown) => {
				console.warn("live map: content not answered", error);
				if (active) setAnswer({ key, value: { kind: "failed" } });
			},
		);
		return () => {
			active = false;
		};
	}, [key, source, eventId]);
	if (eventId === null) return { kind: "none" };
	if (hide) return { kind: "hidden" };
	if (!ended) return { kind: "pending" };
	if (source === null) return { kind: "unavailable" };
	if (key === null) return { kind: "failed" };
	return answer !== null && answer.key === key ? answer.value : { kind: "loading" };
}

/**
 * Date.now(): read again whenever `stamp` changes (a new state) and once more
 * `settleMs` later (a hold that ends), and every `ms` while `active`; no
 * timer repeats while idle.
 */
export function useTickingNow(active: boolean, stamp: unknown, settleMs: number, ms = 500): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const read = (): void => setNow(Date.now());
		const first = window.setTimeout(read, 0);
		const settle = window.setTimeout(read, settleMs);
		const timer = active ? window.setInterval(read, ms) : null;
		return () => {
			window.clearTimeout(first);
			window.clearTimeout(settle);
			if (timer !== null) window.clearInterval(timer);
		};
	}, [active, stamp, settleMs, ms]);
	return now;
}

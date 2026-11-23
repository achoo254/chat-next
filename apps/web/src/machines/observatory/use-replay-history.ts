// The history a replay plays: built from the watched session's state, kept
// up to date with the live events that arrive (also while replaying), and
// paged back to the session's start once the viewer asks to replay.
import { useEffect, useRef, useState } from "react";
import type { LiveMapState } from "./live-map-state.ts";
import { earlierEvents, type ObservatoryLink } from "./observatory-client.ts";
import { historyOfState, needsEarlier, withLive, withPage, type ReplayHistory } from "./replay-controller.ts";

export interface ReplayHistoryState {
	/** null until the first snapshot. */
	readonly history: ReplayHistory | null;
	/** Older events are still being asked. */
	readonly loading: boolean;
}

interface Held {
	readonly key: string;
	readonly history: ReplayHistory;
}

const keyOf = (state: LiveMapState): string => `${state.sessionId}\n${state.epoch}`;

/**
 * `wantEarlier`: ask the older events (the viewer is replaying). A session's
 * new snapshot (another epoch) starts the history again.
 */
export function useReplayHistory(link: ObservatoryLink, state: LiveMapState | null, wantEarlier: boolean): ReplayHistoryState {
	const [held, setHeld] = useState<Held | null>(null);
	const [gaveUp, setGaveUp] = useState<string | null>(null);
	const seen = useRef<ReadonlySet<unknown>>(new Set());

	useEffect(() => {
		if (state === null) return;
		const key = keyOf(state);
		const previous = seen.current;
		seen.current = new Set(state.log);
		setHeld((current) => {
			if (current === null || current.key !== key) return { key, history: historyOfState(state) };
			// Events (and newer versions of events) the log did not hold before.
			const fresh = state.log.filter((e) => !previous.has(e));
			return fresh.length === 0 ? current : { key, history: withLive(current.history, fresh) };
		});
	}, [state]);

	const history = held?.history ?? null;
	const earlier = history?.earlier ?? "";
	const asking = wantEarlier && history !== null && needsEarlier(history) && gaveUp !== `${held?.key}\n${earlier}`;
	const key = held?.key ?? "";
	const sessionId = history?.sessionId ?? "";
	useEffect(() => {
		if (!asking) return;
		let active = true;
		earlierEvents(link, sessionId, earlier).then(
			(answer) => {
				if (!active) return;
				const moved = answer.earlier !== earlier;
				setHeld((current) => (current === null || current.key !== key ? current : { key, history: withPage(current.history, answer.events, moved ? answer.earlier : "") }));
			},
			() => {
				if (active) setGaveUp(`${key}\n${earlier}`);
			},
		);
		return () => {
			active = false;
		};
	}, [asking, link, sessionId, earlier, key]);

	return { history, loading: asking };
}

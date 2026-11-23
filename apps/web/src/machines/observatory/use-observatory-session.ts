// A watched Claude Code session for the Live Map: a thread's sessions
// (useThreadSessions), the session's state as the machine sends it
// (useObservatorySession: a snapshot, then events by the device-side rules of
// docs/observatory-wire.md section 2, through live-map-state.ts), and what
// the viewer asks of it: an event's content, a station's numbers. The watch
// lives exactly as long as the component using it: leaving the tab unmounts
// it and stops watching, nothing is kept mounted while hidden.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyEvents, fromSnapshot, type LiveMapState } from "./live-map-state.ts";
import type { LiveMapContent, LiveMapSessionInfo, StationDrill } from "./live-map-types.ts";
import { eventContent, failureOf, stationDrill, threadSessions, watchSession, type ObservatoryFailure, type ObservatoryLink, type ObservatoryWatch, type WatchOptions, type WatchSink } from "./observatory-client.ts";

export interface ObservatorySession {
	/** null until the first snapshot. */
	readonly state: LiveMapState | null;
	/** The machine refused the watch; null otherwise. */
	readonly failure: ObservatoryFailure | null;
	/** The link has been down for OFFLINE_NOTICE_MS. */
	readonly disconnected: boolean;
	/** Ask again after a refusal. */
	readonly retry: () => void;
}

export interface Held {
	readonly state: LiveMapState | null;
	readonly failure: ObservatoryFailure | null;
	readonly disconnected: boolean;
}

const NOTHING: Held = { state: null, failure: null, disconnected: false };

/**
 * Where a watch's frames go: the state follows the snapshot and the events,
 * and every change is handed to `publish`. Events before the first snapshot
 * wait for it (the watch asking for it is in flight).
 */
export function sessionSink(publish: (change: (held: Held) => Held) => void): WatchSink {
	let state: LiveMapState | null = null;
	return {
		snapshot(snapshot) {
			const next = fromSnapshot(snapshot);
			state = next;
			publish((held) => ({ ...held, state: next }));
		},
		events(epoch, events) {
			if (state === null) return "ok";
			const result = applyEvents(state, epoch, events);
			if (result.state !== state) {
				const next = result.state;
				state = next;
				publish((held) => ({ ...held, state: next }));
			}
			return result.needSnapshot ? "need-snapshot" : "ok";
		},
		failure(failure) {
			publish((held) => (held.failure === failure ? held : { ...held, failure }));
		},
		disconnected(down) {
			publish((held) => (held.disconnected === down ? held : { ...held, disconnected: down }));
		},
	};
}

/** Watches `sessionId` while mounted (null: nothing to watch yet). */
export function useObservatorySession(link: ObservatoryLink, sessionId: string | null, options?: WatchOptions): ObservatorySession {
	const [held, setHeld] = useState<{ key: string | null; held: Held }>({ key: sessionId, held: NOTHING });
	const watch = useRef<ObservatoryWatch | null>(null);
	const visibility = options?.visibility;
	useEffect(() => {
		if (sessionId === null) return;
		// The first change for another session starts from nothing.
		const sink = sessionSink((change) => setHeld((current) => ({ key: sessionId, held: change(current.key === sessionId ? current.held : NOTHING) })));
		const w = watchSession(link, sessionId, sink, visibility === undefined ? {} : { visibility });
		watch.current = w;
		return () => {
			w.close();
			if (watch.current === w) watch.current = null;
		};
	}, [link, sessionId, visibility]);
	const retry = useCallback(() => watch.current?.retry(), []);
	// Another session's state never shows, even for the render before the effect resets it.
	const shown = held.key === sessionId ? held.held : NOTHING;
	return { ...shown, retry };
}

/** An answer asked of the machine: loading, the value, or why it failed. */
export type Asked<T> = { readonly kind: "loading" } | { readonly kind: "done"; readonly value: T } | { readonly kind: "failed"; readonly failure: ObservatoryFailure };

const LOADING = { kind: "loading" } as const;

/**
 * Asks once per `key` while online (and again after the link reopens); a null
 * key asks nothing. An answer for an earlier key never shows.
 */
function useAsk<T>(key: string | null, online: boolean, ask: () => Promise<T>): Asked<T> {
	const [answer, setAnswer] = useState<{ key: string; asked: Asked<T> } | null>(null);
	const latest = useRef(ask);
	useEffect(() => {
		latest.current = ask;
	});
	useEffect(() => {
		if (!online || key === null) return;
		let active = true;
		latest.current().then(
			(value) => {
				if (active) setAnswer({ key, asked: { kind: "done", value } });
			},
			(err: unknown) => {
				if (active) setAnswer({ key, asked: { kind: "failed", failure: failureOf(err) } });
			},
		);
		return () => {
			active = false;
		};
	}, [key, online]);
	return answer !== null && answer.key === key ? answer.asked : LOADING;
}

/**
 * A thread's Claude Code sessions, newest first (the first is the one it runs
 * now; earlier ones are the conversations before /clear), asked once the link
 * is open and again after it reopens. null thread: nothing asked.
 */
export function useThreadSessions(link: ObservatoryLink, threadId: string | null, online: boolean): Asked<readonly LiveMapSessionInfo[]> {
	return useAsk(threadId, online, () => threadSessions(link, threadId ?? ""));
}

/** An event's content, asked when the viewer opens it (null: nothing asked). */
export function useEventContent(link: ObservatoryLink, sessionId: string, eventId: string | null, online: boolean): Asked<LiveMapContent> {
	return useAsk(eventId === null ? null : `${sessionId}\n${eventId}`, online, () => eventContent(link, sessionId, eventId ?? ""));
}

/** A station's numbers, asked when its drawer opens (null: nothing asked), up to `at` (0: the whole session). */
export function useStationDrill(link: ObservatoryLink, sessionId: string, station: string | null, at: number, online: boolean): Asked<StationDrill> {
	return useAsk(station === null ? null : `${sessionId}\n${station}\n${at}`, online, () => stationDrill(link, sessionId, station ?? "", at));
}

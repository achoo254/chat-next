// A watched Claude Code session for the Live Map: the session a thread runs
// (useThreadSession), and the session's state as the machine sends it
// (useObservatorySession: a snapshot, then events by the device-side rules of
// docs/observatory-wire.md section 2, through live-map-state.ts). The watch
// lives exactly as long as the component using it: leaving the tab unmounts
// it and stops watching, nothing is kept mounted while hidden.
import { useCallback, useEffect, useRef, useState } from "react";
import { applyEvents, fromSnapshot, type LiveMapState } from "./live-map-state.ts";
import { failureOf, threadSessionId, watchSession, type ObservatoryFailure, type ObservatoryLink, type ObservatoryWatch, type WatchOptions, type WatchSink } from "./observatory-client.ts";

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

export type ThreadSession =
	| { readonly kind: "loading" }
	/** The thread holds no Claude Code session yet (nothing sent in it). */
	| { readonly kind: "none" }
	| { readonly kind: "found"; readonly sessionId: string }
	| { readonly kind: "failed"; readonly failure: ObservatoryFailure };

/**
 * The session `thread` runs, asked once the link is open (and again after it
 * reopens: a /clear may have moved the thread on). null thread: nothing asked.
 */
export function useThreadSession(link: ObservatoryLink, thread: { readonly id: string; readonly provider: string; readonly dir: string } | null, online: boolean): ThreadSession {
	const [found, setFound] = useState<{ key: string; session: ThreadSession } | null>(null);
	const id = thread?.id ?? "";
	const provider = thread?.provider ?? "";
	const dir = thread?.dir ?? "";
	const key = `${id}\n${provider}\n${dir}`;
	useEffect(() => {
		if (!online || id === "") return;
		let active = true;
		threadSessionId(link, { id, provider, dir }).then(
			(sessionId) => {
				if (active) setFound({ key, session: sessionId === null ? { kind: "none" } : { kind: "found", sessionId } });
			},
			(err: unknown) => {
				if (active) setFound({ key, session: { kind: "failed", failure: failureOf(err) } });
			},
		);
		return () => {
			active = false;
		};
	}, [link, online, id, provider, dir, key]);
	return found !== null && found.key === key ? found.session : { kind: "loading" };
}

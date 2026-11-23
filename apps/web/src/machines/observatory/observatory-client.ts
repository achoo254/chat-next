// Observatory's requests on a machine's link (docs/observatory-wire.md): the
// machine's recent Claude Code sessions, a thread's sessions, the thread
// holding each session, a page of older events, an event's content by id, a
// station's numbers (drill-down), and watching one session. Every request has its own deadline;
// a machine whose tunelo does not know a request (UNSUPPORTED_REQUEST) reads
// as "update tunelo".
//
// Watching joins the link to one session: ObservatoryWatch{on} while the tab
// is open (and again after a reconnect, another epoch or a gap in seq: that is
// how a device asks for a fresh snapshot), {off} when it closes. A page hidden
// for HIDDEN_UNWATCH_MS stops watching (the watch holds one of the machine's
// few slots and keeps it reading); shown again, it watches again. A link down
// for OFFLINE_NOTICE_MS says so. At most one watch is in flight, so a burst of
// out-of-order frames asks once; a watch lost to the link (closed, no answer
// in time) is not a refusal: a reconnect watches again, a silent machine is
// asked again shortly.
import { ErrorReason, type Frame } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../copy-vi.ts";
import { OfflineError, RemoteError, type MachineLink } from "../link/machine-link.ts";
import {
	contentFromWire,
	eventFromWire,
	sessionInfoFromWire,
	snapshotFromWire,
	stationDrillFromWire,
	type LiveMapContent,
	type LiveMapEvent,
	type LiveMapSessionInfo,
	type LiveMapSnapshot,
	type StationDrill,
} from "./live-map-types.ts";

/** What Observatory needs of a link (tests pass a fake one). */
export type ObservatoryLink = Pick<MachineLink, "request" | "onFrame" | "subscribe" | "snapshot">;

/** How long any Observatory request waits for the machine. */
export const OBSERVATORY_TIMEOUT_MS = 10_000;
/** A page hidden this long stops watching. */
export const HIDDEN_UNWATCH_MS = 60_000;
/** A link down this long tells the viewer the machine is not connected. */
export const OFFLINE_NOTICE_MS = 30_000;
/** A watch the machine did not answer while the link stayed open is asked again after this long. */
export const WATCH_RETRY_MS = 3_000;
/** The events a snapshot carries. */
export const SNAPSHOT_LIMIT = 500;

/**
 * Why a request failed, as the viewer is told: tunelo too old ("update"),
 * Observatory off on the machine, too many sessions watched, a request the
 * machine found invalid, the link down, or anything else.
 */
export type ObservatoryFailure = "update" | "off" | "limit" | "invalid" | "offline" | "failed";

export function failureOf(err: unknown): ObservatoryFailure {
	if (err instanceof OfflineError) return "offline";
	if (!(err instanceof RemoteError)) return "failed";
	switch (err.reason) {
		case ErrorReason.UNSUPPORTED_REQUEST:
			return "update";
		case ErrorReason.OBSERVATORY_OFF:
			return "off";
		case ErrorReason.OBSERVATORY_WATCH_LIMIT:
			return "limit";
		case ErrorReason.OBSERVATORY_INVALID:
			return "invalid";
		default:
			return "failed";
	}
}

/**
 * The machine's most recent sessions, newest first (at most `limit`, the
 * machine caps it at 200); with `threadId`, only that thread's Claude Code
 * sessions, followed across /clear both ways (empty for another AI's thread).
 */
export async function listMachineSessions(link: Pick<ObservatoryLink, "request">, limit: number, threadId = ""): Promise<LiveMapSessionInfo[]> {
	const frame = await link.request({ case: "observatorySessionList", value: { limit, threadId } }, OBSERVATORY_TIMEOUT_MS);
	if (frame.body.case !== "observatorySessionListResult") throw new Error(`unexpected answer ${String(frame.body.case)}`);
	return frame.body.value.sessions.map(sessionInfoFromWire);
}

/** Events before `earlier` (a snapshot's or a page's), oldest first, and where the next older page starts ("" when none). */
export async function earlierEvents(link: Pick<ObservatoryLink, "request">, sessionId: string, earlier: string, limit = SNAPSHOT_LIMIT): Promise<{ events: LiveMapEvent[]; earlier: string }> {
	const frame = await link.request({ case: "observatoryEarlier", value: { sessionId, earlier, limit } }, OBSERVATORY_TIMEOUT_MS);
	if (frame.body.case !== "observatoryEarlierResult") throw new Error(`unexpected answer ${String(frame.body.case)}`);
	return { events: frame.body.value.events.map(eventFromWire), earlier: frame.body.value.earlier };
}

/** Transcripts looked at when matching sessions to threads (the machine's list of sessions carries no thread). */
const HELD_SESSIONS_LIMIT = 100;

/** The machine's transcripts of `provider` that a thread holds, most recently changed first, as its session list (SessionList) says. */
async function heldSessions(link: Pick<ObservatoryLink, "request">, provider: string): Promise<{ sessionId: string; threadId: string }[]> {
	const frame = await link.request({ case: "sessionList", value: { provider, dir: "", limit: HELD_SESSIONS_LIMIT } }, OBSERVATORY_TIMEOUT_MS);
	if (frame.body.case !== "sessionListResult") throw new Error(`unexpected answer ${String(frame.body.case)}`);
	return frame.body.value.sessions
		.filter((s) => s.threadId !== "")
		.sort((a, b) => Number(b.updatedAt - a.updatedAt))
		.map((s) => ({ sessionId: s.sessionId, threadId: s.threadId }));
}

/** A thread's sessions asked at most: its segments and the sessions /clear chained to them. */
export const THREAD_SESSIONS_LIMIT = 50;

/** A thread's Claude Code sessions, newest first (the first is the one it runs now); empty when it has none yet. */
export function threadSessions(link: Pick<ObservatoryLink, "request">, threadId: string): Promise<LiveMapSessionInfo[]> {
	return listMachineSessions(link, THREAD_SESSIONS_LIMIT, threadId);
}

/** An event's content as stored (section 6.5): the only way content leaves the machine, read when the viewer asks. */
export async function eventContent(link: Pick<ObservatoryLink, "request">, sessionId: string, eventId: string): Promise<LiveMapContent> {
	const frame = await link.request({ case: "observatoryContent", value: { sessionId, eventId } }, OBSERVATORY_TIMEOUT_MS);
	if (frame.body.case !== "observatoryContentResult") throw new Error(`unexpected answer ${String(frame.body.case)}`);
	return contentFromWire(frame.body.value);
}

/** A station's numbers for the session (section 6.6), up to `at` (0: the whole session). */
export async function stationDrill(link: Pick<ObservatoryLink, "request">, sessionId: string, station: string, at = 0): Promise<StationDrill> {
	const frame = await link.request({ case: "observatoryStation", value: { sessionId, station, at: BigInt(at) } }, OBSERVATORY_TIMEOUT_MS);
	if (frame.body.case !== "observatoryStationResult") throw new Error(`unexpected answer ${String(frame.body.case)}`);
	return stationDrillFromWire(frame.body.value);
}

/** The thread holding each of the machine's sessions of `provider` that one holds (by session id). */
export async function threadsBySession(link: Pick<ObservatoryLink, "request">, provider: string): Promise<ReadonlyMap<string, string>> {
	const held = await heldSessions(link, provider);
	return new Map(held.map((s) => [s.sessionId, s.threadId]));
}

/** What to tell the viewer about a failed request (`copy` is `observe` of the AI Agent copy). */
export function failureText(copy: Pick<MachinesCopy["observe"], "needsUpdate" | "off" | "limit" | "offline" | "failed">, failure: ObservatoryFailure): string {
	switch (failure) {
		case "update":
			return copy.needsUpdate;
		case "off":
			return copy.off;
		case "limit":
			return copy.limit;
		case "offline":
			return copy.offline;
		case "invalid":
		case "failed":
			return copy.failed;
	}
}

/** Whether the page is shown, and its changes (the document by default; tests pass their own). */
export interface PageVisibility {
	hidden(): boolean;
	subscribe(listener: () => void): () => void;
}

export const documentVisibility: PageVisibility = {
	hidden: () => document.visibilityState === "hidden",
	subscribe: (listener) => {
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
};

/** Where a watch hands what the machine sends (use-observatory-session.ts keeps it). */
export interface WatchSink {
	snapshot(snapshot: LiveMapSnapshot): void;
	/** "need-snapshot" when the events are of another epoch or skip a seq. */
	events(epoch: bigint, events: readonly LiveMapEvent[]): "ok" | "need-snapshot";
	/** The machine refused the watch; null once a snapshot came after all. */
	failure(failure: ObservatoryFailure | null): void;
	/** The link has been down for OFFLINE_NOTICE_MS (true), or is back (false). */
	disconnected(down: boolean): void;
}

export interface ObservatoryWatch {
	/** Stop watching (the tab closed). */
	close(): void;
	/** Ask again after a refusal ("Thử lại"). */
	retry(): void;
}

export interface WatchOptions {
	readonly visibility?: PageVisibility;
}

export function watchSession(link: ObservatoryLink, sessionId: string, sink: WatchSink, options: WatchOptions = {}): ObservatoryWatch {
	const page = options.visibility ?? documentVisibility;
	let stopped = false;
	/** A watch request is in flight. */
	let asking = false;
	/** The machine holds this connection's watch (asked, and not stopped since). */
	let watched = false;
	let wasOpen = link.snapshot().status.kind === "open";
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
	let offlineTimer: ReturnType<typeof setTimeout> | null = null;

	const isOpen = (): boolean => link.snapshot().status.kind === "open";
	const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
		if (timer !== null) clearTimeout(timer);
		return null;
	};

	const watch = (): void => {
		if (stopped || asking || !isOpen()) return;
		asking = true;
		watched = true;
		link.request({ case: "observatoryWatch", value: { sessionId, on: true, limit: SNAPSHOT_LIMIT } }, OBSERVATORY_TIMEOUT_MS).then(
			() => {
				asking = false;
			},
			(err: unknown) => {
				asking = false;
				if (stopped) return;
				if (err instanceof OfflineError) {
					// Closed meanwhile: the reconnect watches again. Open but silent: ask again shortly.
					if (isOpen() && retryTimer === null) {
						retryTimer = setTimeout(() => {
							retryTimer = null;
							watch();
						}, WATCH_RETRY_MS);
					}
					return;
				}
				watched = false;
				sink.failure(failureOf(err));
			},
		);
	};

	const unwatch = (): void => {
		retryTimer = clear(retryTimer);
		if (!watched) return;
		watched = false;
		asking = false;
		if (isOpen()) link.request({ case: "observatoryWatch", value: { sessionId, on: false } }, OBSERVATORY_TIMEOUT_MS).catch(() => undefined);
	};

	const onFrame = (body: Frame["body"]): void => {
		if (!watched) return;
		if (body.case === "observatorySnapshot" && body.value.sessionId === sessionId) {
			asking = false;
			sink.failure(null);
			sink.snapshot(snapshotFromWire(body.value));
		} else if (body.case === "observatoryEvents" && body.value.sessionId === sessionId) {
			if (sink.events(body.value.epoch, body.value.events.map(eventFromWire)) === "need-snapshot") watch();
		}
	};

	const onLink = (): void => {
		const open = isOpen();
		if (open === wasOpen) return;
		wasOpen = open;
		if (open) {
			offlineTimer = clear(offlineTimer);
			sink.disconnected(false);
			// A new connection: the machine forgot this watch, and events may have been missed.
			asking = false;
			if (watched || hiddenTimer !== null || !page.hidden()) {
				watched = false;
				watch();
			}
			return;
		}
		offlineTimer ??= setTimeout(() => {
			offlineTimer = null;
			sink.disconnected(true);
		}, OFFLINE_NOTICE_MS);
	};

	const onVisibility = (): void => {
		if (page.hidden()) {
			hiddenTimer ??= setTimeout(() => {
				hiddenTimer = null;
				unwatch();
			}, HIDDEN_UNWATCH_MS);
			return;
		}
		hiddenTimer = clear(hiddenTimer);
		if (!watched) watch();
	};

	const offFrame = link.onFrame(onFrame);
	const offLink = link.subscribe(onLink);
	const offPage = page.subscribe(onVisibility);
	if (!wasOpen) {
		offlineTimer = setTimeout(() => {
			offlineTimer = null;
			sink.disconnected(true);
		}, OFFLINE_NOTICE_MS);
	}
	watch();

	return {
		close() {
			stopped = true;
			hiddenTimer = clear(hiddenTimer);
			offlineTimer = clear(offlineTimer);
			offFrame();
			offLink();
			offPage();
			unwatch();
		},
		retry() {
			asking = false;
			watch();
		},
	};
}

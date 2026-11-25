// The "Quan sát" view of a Claude Code session: finds the session (the one a
// thread runs, or one named by its own id), watches it while mounted
// (use-observatory-session.ts) and shows where the watch stands: loading, a
// machine to update, Observatory off, a refusal to try again, a machine that
// went quiet. The scene is the Live Map stage (render/live-map-stage.tsx: the
// plate, the PixiJS canvas in its own chunk, the DOM tags); the user desk is
// named with the signed-in chat account's email. A click on a station opens
// its drawer, a click on a moving piece or on an event of the drawer opens the
// event's detail (beside the map, not over it); under the map the replay bar
// plays the session back: the scene is then rebuilt at the replayed moment by
// the same reducer as live (replay-controller.ts) and the drawer asks its
// numbers up to that moment. A link goes to the repository's "Hiệu quả" page.
// The first map opened after the update says the Office tab became Observe
// (office-replaced-notice.tsx). A thread with no recorded session gets its
// empty view (observe-empty-state.tsx), which may offer to reopen the session
// so it is recorded from then on; the thread's sessions are then asked again
// for a while, so the map opens once the machine records the session.
// Loaded on demand; unmounted (the watch stopped, the renderer destroyed) as
// soon as the tab is left.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useContext, useEffect, useMemo, useState } from "react";
import { ServicesContext } from "../../messaging/data/services.tsx";
import { Link } from "../../router.tsx";
import { AGENT_LIVE_MAP, versionAtLeast } from "../agent-version.ts";
import { SessionLoading } from "../session-scene.tsx";
import { usagePath } from "../usage/usage-paths.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { ObserveFocus } from "../ai-paths.ts";
import { EventDetail } from "./event-detail.tsx";
import { coreOf, type LiveMapState } from "./live-map-state.ts";
import type { LiveMapEvent } from "./live-map-types.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { ObserveEmptyState, type ObserveThread, type RelaunchAction } from "./observe-empty-state.tsx";
import { OfficeReplacedNotice } from "./office-replaced-notice.tsx";
import type { RelaunchKind } from "./relaunch-session.ts";
import { LiveMapStage, readHideDetails } from "./render/live-map-stage.tsx";
import type { PlaceId } from "./render/scene-table.ts";
import { stationAtPlace } from "./place-names.ts";
import { ReplayBar } from "./replay-bar.tsx";
import { cursorAt, detailsExpired, focusedAt, LIVE_CURSOR, marksOf, stateAt, timelineOf, type ReplayCursor } from "./replay-controller.ts";
import { StationDrawer } from "./station-drawer.tsx";
import { useObservatorySession, useThreadSessions } from "./use-observatory-session.ts";
import { useReplayHistory } from "./use-replay-history.ts";
import "./live-map-drawer.css";
import "./station-palette.css";

/** After a reopen, the thread's sessions are asked again this often, this many times (and anew after the thread changes). */
export const REOPEN_ASK_MS = 5_000;
export const REOPEN_ASKS = 12;

/**
 * While `waiting` (the session was reopened and no recorded one has shown),
 * bumps the refresh every REOPEN_ASK_MS, REOPEN_ASKS times: the machine
 * records the session at its first hook, up to a minute later. A change of
 * the thread (`mark`: a message sent, a turn started or ended) starts the
 * round again.
 */
function useRecordedSessionWait(waiting: boolean, mark: string, bump: (change: (n: number) => number) => void): void {
	useEffect(() => {
		if (!waiting) return;
		let asks = 0;
		const timer = window.setInterval(() => {
			asks += 1;
			bump((n) => n + 1);
			if (asks >= REOPEN_ASKS) window.clearInterval(timer);
		}, REOPEN_ASK_MS);
		return () => window.clearInterval(timer);
	}, [waiting, mark, bump]);
}

/** Marks the bar draws across the timeline. */
const BAR_MARKS = 120;

/** The session to show: the one a thread runs now (its newest), or one by its own id. */
export type LiveMapTarget =
	| { readonly kind: "thread"; readonly threadId: string }
	| { readonly kind: "session"; readonly sessionId: string };

export interface LiveMapViewProps {
	readonly link: ObservatoryLink;
	readonly machine: string;
	readonly info: MachineInfo | null;
	readonly online: boolean;
	readonly target: LiveMapTarget;
	/** A link's `?at=&event=`: open the session at that moment and event. */
	readonly focus?: ObserveFocus;
	/** The thread shown (target `thread`), for its empty view; absent: the view reads it as one with no session yet. */
	readonly thread?: ObserveThread | undefined;
	/** Reopening the thread's session so it is recorded, when the page offers it. */
	readonly relaunch?: RelaunchAction | undefined;
}

function Note({ text, retry }: { text: string; retry?: (() => void) | undefined }) {
	const t = useMachinesCopy().observe;
	return (
		<div className="mx-body" data-id="observe-note">
			<p className="note mx-group-note" role="status">
				{text}
			</p>
			{retry !== undefined && (
				<div className="acts">
					<button type="button" className="btn btn-sm" onClick={retry} data-id="observe-retry">
						{t.retry}
					</button>
				</div>
			)}
		</div>
	);
}

interface MapBodyProps {
	readonly link: ObservatoryLink;
	readonly machine: string;
	readonly online: boolean;
	readonly state: LiveMapState;
	readonly disconnected: boolean;
	readonly focus: ObserveFocus | undefined;
}

/** What the viewer is going to: a moment, an event, or both (a link, a finding's evidence). */
type Goal = { readonly at?: number; readonly event?: string };

/** One watched session's map with its drawer, detail and replay bar; the view keys it by session, so another session starts clean. */
function MapBody({ link, machine, online, state, disconnected, focus }: MapBodyProps) {
	const t = useMachinesCopy().observe;
	// The signed-in account; absent outside the signed-in app (tests of this view alone).
	const accountEmail = useContext(ServicesContext)?.self.email ?? "";
	const [selected, setSelected] = useState<{ place: PlaceId | null; eventId: string | null }>({ place: null, eventId: null });
	const [detail, setDetail] = useState<LiveMapEvent | null>(null);
	const [cursor, setCursor] = useState<ReplayCursor>(LIVE_CURSOR);
	const [liveEdge, setLiveEdge] = useState(0);
	const [hideDetails, setHideDetails] = useState(readHideDetails);
	const [openedAt] = useState(Date.now);
	const [goal, setGoal] = useState<Goal | null>(() => (focus === undefined || (focus.at === undefined && focus.event === undefined) ? null : focus));
	const replaying = cursor.mode === "replay";
	const { history, loading } = useReplayHistory(link, state, replaying);
	const timeline = useMemo(() => (history === null ? null : timelineOf(history)), [history]);
	const marks = useMemo(() => (history === null || timeline === null ? [] : marksOf(history, timeline, BAR_MARKS)), [history, timeline]);
	const shown = useMemo(() => (replaying && history !== null ? stateAt(history, cursor.at) : state), [replaying, history, cursor, state]);
	const held = replaying && history !== null ? history.events.filter((e) => e.at > liveEdge).length : 0;
	const station = stationAtPlace(selected.place);

	const move = (next: ReplayCursor): void => {
		if (next.mode === "replay" && cursor.mode === "live") setLiveEdge(timeline?.end ?? 0);
		setCursor(next);
	};
	const replayTo = (at: number): void => {
		if (timeline !== null) move(cursorAt(cursor, timeline, at));
	};
	const findEvent = (id: string): LiveMapEvent | undefined => history?.byId.get(id) ?? state.log.find((e) => e.id === id);

	// Going to a moment or an event: once the history holds it, replay there and open it. One not held yet
	// (older than what is loaded) is asked for by replaying, which pages the older events back; none left: give up.
	if (goal !== null && history !== null && timeline !== null) {
		const at = focusedAt(history, goal);
		if (at !== null) {
			replayTo(at);
			const event = goal.event === undefined ? undefined : history.byId.get(goal.event);
			if (event !== undefined) setDetail(event);
			setGoal(null);
		} else if (!replaying) {
			move(cursorAt(cursor, timeline, timeline.end));
		} else if (!loading) {
			setGoal(null);
		}
	}

	const panelOpen = detail !== null || station !== null;
	const contentSource = useMemo(() => ({ link, sessionId: state.sessionId, online }), [link, state.sessionId, online]);
	const projectKey = state.info?.projectKey ?? "";
	return (
		<div
			className="mx-body"
			data-id="observe-map"
			data-core={shown.live?.core ?? coreOf(shown)}
			data-selected-place={selected.place ?? undefined}
			data-selected-event={selected.eventId ?? undefined}
		>
			<OfficeReplacedNotice />
			{disconnected && (
				<p className="note mx-group-note" role="status" data-id="observe-disconnected">
					{t.disconnected}
				</p>
			)}
			{projectKey !== "" && (
				<div className="acts">
					<Link to={usagePath(machine, projectKey)} className="btn btn-sm mx-btn-ghost" data-id="observe-usage">
						{t.usage}
					</Link>
				</div>
			)}
			<div className="lmd-wrap">
				<div className="lmd-host" data-open={panelOpen || undefined}>
					<LiveMapStage
						state={shown}
						accountEmail={accountEmail}
						selectedPlace={selected.place}
						onStation={(place) => {
							setSelected({ place, eventId: null });
							setDetail(null);
						}}
						onEvent={(eventId) => {
							setSelected({ place: null, eventId });
							setDetail(findEvent(eventId) ?? null);
						}}
						onDeselect={() => setSelected({ place: null, eventId: null })}
						onHideDetails={setHideDetails}
						replayAt={replaying ? cursor.at : undefined}
						contentSource={contentSource}
					/>
					{detail !== null ? (
						<EventDetail link={link} sessionId={state.sessionId} online={online} event={detail} hideDetails={hideDetails} onReplayTo={replayTo} onClose={() => setDetail(null)} />
					) : (
						station !== null && (
							<StationDrawer
								link={link}
								sessionId={state.sessionId}
								online={online}
								station={station}
								at={replaying ? cursor.at : 0}
								startedAt={state.info?.startedAt ?? 0}
								hideDetails={hideDetails}
								onOpenEvent={setDetail}
								onEvidence={(event) => setGoal({ event })}
								onClose={() => setSelected({ place: null, eventId: null })}
							/>
						)
					)}
				</div>
			</div>
			{history !== null && timeline !== null && (
				<ReplayBar
					timeline={timeline}
					marks={marks}
					cursor={cursor}
					onCursor={move}
					loading={loading}
					expired={detailsExpired(history.info, openedAt)}
					partial={history.partial}
					held={held}
				/>
			)}
		</div>
	);
}

export default function LiveMapView({ link, machine, info, online, target, focus, thread, relaunch }: LiveMapViewProps) {
	const t = useMachinesCopy().observe;
	const served = info !== null && versionAtLeast(info.agentVersion, AGENT_LIVE_MAP);
	// The thread's session reopened from its empty view (null: not), and the asks of its sessions since.
	const [reopened, setReopened] = useState<RelaunchKind | null>(null);
	const [refresh, setRefresh] = useState(0);
	const threadSessions = useThreadSessions(link, served && target.kind === "thread" ? target.threadId : null, online, refresh);
	const newest = threadSessions.kind === "done" ? (threadSessions.value[0]?.sessionId ?? null) : null;
	useRecordedSessionWait(reopened !== null && newest === null, `${thread?.preview ?? ""}\n${String(thread?.running ?? false)}`, setRefresh);
	const sessionId = !served ? null : target.kind === "session" ? target.sessionId : newest;
	const watched = useObservatorySession(link, sessionId);

	if (info === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	if (!served) return <Note text={t.needsUpdate} />;
	if (target.kind === "thread") {
		if (threadSessions.kind === "done" && newest === null) {
			const onReopened = (kind: RelaunchKind): void => {
				setReopened(kind);
				setRefresh((n) => n + 1);
			};
			return <ObserveEmptyState thread={thread} relaunch={relaunch} reopened={reopened} onReopened={onReopened} />;
		}
		if (threadSessions.kind === "failed") return <Note text={failureText(t, threadSessions.failure)} />;
	}
	if (watched.failure !== null) {
		const again = watched.failure === "limit" || watched.failure === "failed" || watched.failure === "offline";
		return <Note text={failureText(t, watched.failure)} retry={again ? watched.retry : undefined} />;
	}
	if (watched.state === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	return <MapBody key={watched.state.sessionId} link={link} machine={machine} online={online} state={watched.state} disconnected={watched.disconnected} focus={focus} />;
}

// The "Quan sát" view of a Claude Code session: finds the session (the one a
// thread runs, or one named by its own id), watches it while mounted
// (use-observatory-session.ts) and shows where the watch stands: loading, a
// machine to update, Observatory off, a refusal to try again, a machine that
// went quiet. The map itself is the Live Map stage (render/live-map-stage.tsx:
// the activity card, the scene of the machine's interior, the session's
// gauges, the detail and the event list); a link's `?event=` opens with that
// event's detail. A link goes to the repository's "Hiệu quả" page. The first
// map opened after the update says the Office tab became Observe
// (office-replaced-notice.tsx). A thread with no recorded session gets its
// empty view (observe-empty-state.tsx), which may offer to reopen the session
// so it is recorded from then on; the thread's sessions are then asked again
// for a while, so the map opens once the machine records the session.
// Loaded on demand; unmounted (the watch stopped, the scene dropped) as soon
// as the tab is left.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useEffect, useMemo, useState } from "react";
import { Link } from "../../router.tsx";
import { AGENT_LIVE_MAP, versionAtLeast } from "../agent-version.ts";
import { SessionLoading } from "../session-scene.tsx";
import { usagePath } from "../usage/usage-paths.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { ObserveFocus } from "../ai-paths.ts";
import { coreOf, type LiveMapState } from "./live-map-state.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { ObserveEmptyState, type ObserveThread, type RelaunchAction } from "./observe-empty-state.tsx";
import { OfficeReplacedNotice } from "./office-replaced-notice.tsx";
import type { RelaunchKind } from "./relaunch-session.ts";
import type { SidePick } from "./live-map-side.tsx";
import { LiveMapStage } from "./render/live-map-stage.tsx";
import { useObservatorySession, useThreadSessions } from "./use-observatory-session.ts";

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
	/** The machine's clock minus the viewer's (ms). */
	readonly skewMs: number;
}

/** One watched session's map; the view keys it by session, so another session starts clean. */
function MapBody({ link, machine, online, state, disconnected, focus, skewMs }: MapBodyProps) {
	const t = useMachinesCopy().observe;
	const [pick, setPick] = useState<SidePick>(focus?.event === undefined ? null : { kind: "event", eventId: focus.event });
	const contentSource = useMemo(() => ({ link, sessionId: state.sessionId, online }), [link, state.sessionId, online]);
	const projectKey = state.info?.projectKey ?? "";
	return (
		<div
			className="mx-body"
			data-id="observe-map"
			data-core={state.live?.core ?? coreOf(state)}
			data-selected-place={pick?.kind === "place" ? pick.place : undefined}
			data-selected-event={pick?.kind === "event" ? pick.eventId : undefined}
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
			<LiveMapStage state={state} initialEvent={focus?.event} onPick={setPick} clockSkewMs={skewMs} contentSource={contentSource} />
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
	return <MapBody key={watched.state.sessionId} link={link} machine={machine} online={online} state={watched.state} disconnected={watched.disconnected} focus={focus} skewMs={watched.skewMs} />;
}

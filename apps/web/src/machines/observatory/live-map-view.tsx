// The "Quan sát" view of a Claude Code session: finds the session (the one a
// thread runs, or one named by its own id), watches it while mounted
// (use-observatory-session.ts) and shows where the watch stands: loading, a
// machine to update, Observatory off, a refusal to try again, a machine that
// went quiet. The scene is the Live Map stage (render/live-map-stage.tsx: the
// plate, the PixiJS canvas in its own chunk, the DOM tags); the user desk is
// named with the signed-in chat account's email. A click on a station or on
// a moving piece selects it (the drawer opening it comes with the drill-down).
// A link goes to the repository's "Hiệu quả" page. Loaded on demand;
// unmounted (the watch stopped, the renderer destroyed) as soon as the tab is
// left.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useContext, useState } from "react";
import { ServicesContext } from "../../messaging/data/services.tsx";
import { Link } from "../../router.tsx";
import { AGENT_LIVE_MAP, versionAtLeast } from "../agent-version.ts";
import { SessionLoading } from "../session-scene.tsx";
import { usagePath } from "../usage/usage-paths.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { coreOf } from "./live-map-state.ts";
import { LiveMapStage } from "./render/live-map-stage.tsx";
import type { PlaceId } from "./render/scene-table.ts";
import { useObservatorySession, useThreadSessions } from "./use-observatory-session.ts";

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

export default function LiveMapView({ link, machine, info, online, target }: LiveMapViewProps) {
	const t = useMachinesCopy().observe;
	const served = info !== null && versionAtLeast(info.agentVersion, AGENT_LIVE_MAP);
	const threadSessions = useThreadSessions(link, served && target.kind === "thread" ? target.threadId : null, online);
	const newest = threadSessions.kind === "done" ? (threadSessions.value[0]?.sessionId ?? null) : null;
	const sessionId = !served ? null : target.kind === "session" ? target.sessionId : newest;
	const watched = useObservatorySession(link, sessionId);
	// The signed-in account; absent outside the signed-in app (tests of this view alone).
	const accountEmail = useContext(ServicesContext)?.self.email ?? "";
	const [selected, setSelected] = useState<{ place: PlaceId | null; eventId: string | null }>({ place: null, eventId: null });

	if (info === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	if (!served) return <Note text={t.needsUpdate} />;
	if (target.kind === "thread") {
		if (threadSessions.kind === "done" && newest === null) return <Note text={t.noSession} />;
		if (threadSessions.kind === "failed") return <Note text={failureText(t, threadSessions.failure)} />;
	}
	if (watched.failure !== null) {
		const again = watched.failure === "limit" || watched.failure === "failed" || watched.failure === "offline";
		return <Note text={failureText(t, watched.failure)} retry={again ? watched.retry : undefined} />;
	}
	if (watched.state === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	const projectKey = watched.state.info?.projectKey ?? "";
	return (
		<div
			className="mx-body"
			data-id="observe-map"
			data-core={watched.state.live?.core ?? coreOf(watched.state)}
			data-selected-place={selected.place ?? undefined}
			data-selected-event={selected.eventId ?? undefined}
		>
			{watched.disconnected && (
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
			<LiveMapStage
				state={watched.state}
				accountEmail={accountEmail}
				selectedPlace={selected.place}
				onStation={(place) => setSelected({ place, eventId: null })}
				onEvent={(eventId) => setSelected({ place: null, eventId })}
			/>
		</div>
	);
}

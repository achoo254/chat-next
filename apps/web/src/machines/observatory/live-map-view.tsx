// The "Quan sát" view of a Claude Code session: finds the session (the one a
// thread runs, or one named by its own id), watches it while mounted
// (use-observatory-session.ts) and shows where the watch stands: loading, a
// machine to update, Observatory off, a refusal to try again, a machine that
// went quiet. The scene itself is an empty frame until the renderer draws the
// Live Map in it. A link goes to the repository's "Hiệu quả" page. Loaded on
// demand; unmounted (and the watch stopped) as soon as the tab is left.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Link } from "../../router.tsx";
import { AGENT_OBSERVATORY, versionAtLeast } from "../agent-version.ts";
import { SessionLoading } from "../session-scene.tsx";
import { usagePath } from "../usage/usage-paths.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { failureText, type ObservatoryLink } from "./observatory-client.ts";
import { useObservatorySession, useThreadSession } from "./use-observatory-session.ts";

/** The session to show: the one a thread runs (null while the thread is not known yet), or one by its own id. */
export type LiveMapTarget =
	| { readonly kind: "thread"; readonly thread: { readonly id: string; readonly provider: string; readonly dir: string } | null }
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
	const served = info !== null && versionAtLeast(info.agentVersion, AGENT_OBSERVATORY);
	const threadSession = useThreadSession(link, served && target.kind === "thread" ? target.thread : null, online);
	const sessionId = !served ? null : target.kind === "session" ? target.sessionId : threadSession.kind === "found" ? threadSession.sessionId : null;
	const watched = useObservatorySession(link, sessionId);

	if (info === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	if (!served) return <Note text={t.needsUpdate} />;
	if (target.kind === "thread") {
		if (threadSession.kind === "none") return <Note text={t.noSession} />;
		if (threadSession.kind === "failed") return <Note text={failureText(t, threadSession.failure)} />;
	}
	if (watched.failure !== null) {
		const again = watched.failure === "limit" || watched.failure === "failed" || watched.failure === "offline";
		return <Note text={failureText(t, watched.failure)} retry={again ? watched.retry : undefined} />;
	}
	if (watched.state === null) return online ? <SessionLoading label={t.loading} /> : <Note text={t.offline} />;
	const projectKey = watched.state.info?.projectKey ?? "";
	return (
		<div className="mx-body" data-id="observe-map" data-core={watched.state.scene.core}>
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
		</div>
	);
}

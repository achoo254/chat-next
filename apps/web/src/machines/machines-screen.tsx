// "AI Agent" (ADR 0013): chatting with the AI on the user's own machines.
// The column on the left is always the sessions of every machine
// (session-sidebar.tsx); beside it the "Cần bạn" board, a machine's board, a
// session, or the machine pages (list and devices, adding, details) reached
// from "Máy" at the top of the column. Phones show one column at a time:
// the sessions at /ai, the page itself elsewhere. Old /machines links open
// the same page under /ai. A machine's terminals (xterm and the dock) load
// only when opened, and only on a machine that offers them. Loaded on demand
// with its styles.
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { ListResizer } from "../messaging/ui/list-resizer.tsx";
import { navigate, paths, usePathname, useSearch, type MachinesView } from "../router.tsx";
import { AddMachine } from "./add-machine.tsx";
import { terminalGate } from "./agent-version.ts";
import { canonicalAiPath } from "./ai-paths.ts";
import { LocalMachine } from "./local-machine.tsx";
import { MachineDetail } from "./machine-detail.tsx";
import { LinkBanner } from "./link-banner.tsx";
import { PageHead } from "./page-head.tsx";
import { MachinesPage } from "./machines-page.tsx";
import { TerminalScreen } from "./terminal-screen.ts";
import { HomeBoard, MachineBoard } from "./session-board.tsx";
import { SessionChat } from "./session-chat.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { useEntry, useHub, useHubPresence, useLink } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { SessionLoading } from "./session-scene.tsx";
import "./machines.css";

/** "Hiệu quả": loaded, with its styles, the first time it opens. */
const UsageScreen = lazy(() => import("./usage/usage-screen.tsx"));
const AiAccountsScreen = lazy(() => import("./ai-accounts/ai-accounts-screen.tsx"));
/** "Quan sát" of a session by its own id: loaded, with the Live Map, the first time it opens. */
const LiveMapView = lazy(() => import("./observatory/live-map-view.tsx"));

/** The column of sessions: wide enough for a session's name and its machine chip, never more than half a laptop screen; kept on this device. */
const SESSIONS_WIDTH = { min: 260, max: 640 } as const;
const SESSIONS_WIDTH_KEY = "ai:list-width";

export default function MachinesScreen({ view }: { view: MachinesView }) {
	const t = useMachinesCopy();
	const grid = useRef<HTMLDivElement>(null);
	const hub = useHub();
	useHubPresence(hub);
	const pathname = usePathname();
	const search = useSearch();
	useEffect(() => {
		const canonical = canonicalAiPath(pathname, search);
		if (canonical !== null) navigate(canonical, { replace: true });
	}, [pathname, search]);
	let main: ReactNode;
	// Phones show the sessions on /ai and the page itself elsewhere.
	let pane: "list" | "main" = "main";
	switch (view.page) {
		case "list":
			main = <HomeBoard back={false} />;
			pane = "list";
			break;
		case "need":
			main = <HomeBoard back />;
			break;
		case "machines":
			main = <MachinesPage />;
			break;
		case "add":
			main = <AddMachine />;
			break;
		case "local":
			// Development builds only: the route does not exist in production, and the branch folds away.
			main = import.meta.env.DEV ? <LocalMachine /> : null;
			break;
		case "info":
			main = <MachineDetail key={view.machine} machine={view.machine} />;
			break;
		case "accounts":
			main = (
				<Suspense fallback={null}>
					<AiAccountsScreen key={view.machine} machine={view.machine} />
				</Suspense>
			);
			break;
		case "machine":
			main = <MachineBoard key={view.machine} machine={view.machine} />;
			break;
		case "session":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} mode="chat" />;
			break;
		case "session-terminal":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} mode="terminal" />;
			break;
		case "session-observe":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} mode="observe" />;
			break;
		case "observe-session":
			main = <ObserveSessionPage key={`${view.machine}\n${view.sessionId}`} machine={view.machine} sessionId={view.sessionId} />;
			break;
		case "terminal":
			main = <TerminalPage key={view.machine} machine={view.machine} openShellIn={new URLSearchParams(search).get("new") ?? undefined} showSession={sessionParam(search)} />;
			break;
		case "usage":
			main = (
				<Suspense fallback={null}>
					<UsageScreen key={`${view.machine}\n${view.key}`} machine={view.machine} repoKey={view.key} />
				</Suspense>
			);
			break;
	}
	return (
		<div className="mx" data-pane={pane} ref={grid}>
			<SessionSidebar view={view} />
			<ListResizer app={grid} list=":scope > .mx-list" storageKey={SESSIONS_WIDTH_KEY} min={SESSIONS_WIDTH.min} max={SESSIONS_WIDTH.max} label={t.agent.listResize} className="mx-list-resize" />
			<section className="mx-main">{main}</section>
		</div>
	);
}

/** One of the machine's Claude Code sessions on the Live Map, opened from the machine's list by its own id. */
function ObserveSessionPage({ machine, sessionId }: { machine: string; sessionId: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machineInfo(machine)} backLabel={t.back} backToOrigin title={t.observe.title} />
			<LinkBanner machine={machine} name={entry?.name ?? ""} status={state.status} />
			<Suspense fallback={<SessionLoading label={t.observe.loading} />}>
				<LiveMapView link={link} machine={machine} info={state.info} online={state.status.kind === "open"} target={{ kind: "session", sessionId }} />
			</Suspense>
		</div>
	);
}

/** The machine's plain shells when it offers them; otherwise what to do on the machine first. */
/** `?open=<session>`: one of the machine's terminal sessions to show (from the machine's page). */
function sessionParam(search: string): number | undefined {
	const n = Number(new URLSearchParams(search).get("open") ?? "");
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function TerminalPage({ machine, openShellIn, showSession }: { machine: string; openShellIn: string | undefined; showSession: number | undefined }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const [, state] = useLink(hub, machine);
	const gate = terminalGate(state.info);
	if (gate === "available") {
		return (
			<Suspense fallback={<SessionLoading label={t.terminal.loading} />}>
				<TerminalScreen machine={machine} openShellIn={openShellIn} showSession={showSession} />
			</Suspense>
		);
	}
	const text = gate === "unknown" ? (state.status.kind === "open" ? t.terminal.loading : t.terminal.offline) : t.terminal.hint[gate];
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machine(machine)} backLabel={t.back} backToOrigin title={t.terminal.title} />
			<div className="mx-body">
				<p className="note" role="status">
					{text}
				</p>
			</div>
		</div>
	);
}

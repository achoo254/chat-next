// "AI Agent" (ADR 0013): chatting with the AI on the user's own machines.
// The column on the left is always the sessions of every machine
// (session-sidebar.tsx); beside it the "Cần bạn" board, a machine's board, a
// session, or the machine pages (list and devices, adding, details) reached
// from "Máy" at the top of the column. Phones show one column at a time:
// the sessions at /ai, the page itself elsewhere. Old /machines links open
// the same page under /ai. A machine's terminals (xterm and the dock) load
// only when opened, and only on a machine that offers them. Loaded on demand
// with its styles.
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { navigate, paths, usePathname, useSearch, type MachinesView } from "../router.tsx";
import { AddMachine } from "./add-machine.tsx";
import { terminalGate } from "./agent-version.ts";
import { canonicalAiPath } from "./ai-paths.ts";
import { LocalMachine } from "./local-machine.tsx";
import { MachineDetail } from "./machine-detail.tsx";
import { PageHead } from "./page-head.tsx";
import { MachinesPage } from "./machines-page.tsx";
import { TerminalScreen } from "./terminal-screen.ts";
import { HomeBoard, MachineBoard } from "./session-board.tsx";
import { SessionChat } from "./session-chat.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";
import { useHub, useHubPresence, useLink } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import "./machines.css";

/** "Hiệu quả": loaded, with its styles, the first time it opens. */
const UsageScreen = lazy(() => import("./usage/usage-screen.tsx"));

export default function MachinesScreen({ view }: { view: MachinesView }) {
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
		case "machine":
			main = <MachineBoard key={view.machine} machine={view.machine} />;
			break;
		case "session":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} mode="chat" />;
			break;
		case "session-terminal":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} mode="terminal" />;
			break;
		case "terminal":
			main = <TerminalPage key={view.machine} machine={view.machine} openShellIn={new URLSearchParams(search).get("new") ?? undefined} />;
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
		<div className="mx" data-pane={pane}>
			<SessionSidebar view={view} />
			<section className="mx-main">{main}</section>
		</div>
	);
}

/** The machine's plain shells when it offers them; otherwise what to do on the machine first. */
function TerminalPage({ machine, openShellIn }: { machine: string; openShellIn: string | undefined }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const [, state] = useLink(hub, machine);
	const gate = terminalGate(state.info);
	if (gate === "available") {
		return (
			<Suspense fallback={<p className="mx-group-note muted">{t.terminal.loading}</p>}>
				<TerminalScreen machine={machine} openShellIn={openShellIn} />
			</Suspense>
		);
	}
	const text = gate === "unknown" ? (state.status.kind === "open" ? t.terminal.loading : t.terminal.offline) : t.terminal.hint[gate];
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machine(machine)} backLabel={t.back} title={t.terminal.title} />
			<div className="mx-body">
				<p className="note" role="status">
					{text}
				</p>
			</div>
		</div>
	);
}

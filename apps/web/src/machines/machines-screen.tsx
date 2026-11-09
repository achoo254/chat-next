// "AI Agent" (ADR 0013): chatting with the AI on the user's own machines.
// The column on the left is always the sessions of every machine
// (session-sidebar.tsx); beside it the "Cần bạn" board, a machine's board, a
// session, or the machine pages (list, adding, pairing, details) reached
// from "Máy" at the top of the column. Phones show one column at a time:
// the sessions at /ai, the page itself elsewhere. Old /machines links open
// the same page under /ai. Loaded on demand with its styles.
import { useEffect, type ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link, navigate, paths, usePathname, useSearch, type MachinesView } from "../router.tsx";
import { AddMachine } from "./add-machine.tsx";
import { canonicalAiPath } from "./ai-paths.ts";
import { LocalMachine } from "./local-machine.tsx";
import { MachineDetail } from "./machine-detail.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { FirstMachine } from "./first-machine.tsx";
import { PageHead } from "./page-head.tsx";
import { PairDevice } from "./pair-device.tsx";
import { HomeBoard, MachineBoard } from "./session-board.tsx";
import { SessionChat } from "./session-chat.tsx";
import { connDot, connText, SessionSidebar } from "./session-sidebar.tsx";
import { useHub, useHubPresence, useMachineViews, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import "./machines.css";

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
		case "pair":
			main = <PairDevice key={view.machine} machine={view.machine} />;
			break;
		case "machine":
			main = <MachineBoard key={view.machine} machine={view.machine} />;
			break;
		case "session":
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} />;
			break;
	}
	return (
		<div className="mx" data-pane={pane}>
			<SessionSidebar view={view} />
			<section className="mx-main">{main}</section>
		</div>
	);
}

/** "Máy": the user's machines with their state, each opening its details; adding one. */
function MachinesPage() {
	const t = useMachinesCopy();
	const hub = useHub();
	const now = useNow();
	const machines = useMachineViews(hub, now);
	const directory = hub.directory();
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.agent.machinesTitle} subtitle={t.agent.machinesIntro}>
				<Link to={paths.machinesAdd()} className="btn btn-primary btn-sm">
					<Icon name="plus" small />
					{t.agent.addMachine}
				</Link>
			</PageHead>
			{directory.status === "error" && (
				<div className="mx-strip error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{t.errors.generic}</span>
					<button type="button" className="btn btn-sm" onClick={() => hub.refresh().catch(() => undefined)}>
						{t.link.retry}
					</button>
				</div>
			)}
			<div className="mx-body">
				{directory.status === "ready" && machines.length === 0 && <FirstMachine />}
				<ul className="mx-machines">
					{machines.map(({ entry, conn }) => (
						<li key={entry.ref}>
							<Link to={paths.machineInfo(entry.ref)} className="mx-row">
								<span className="mx-ico">
									<MachineIcon name="monitor" />
									<span className={`dot ${connDot(conn)}`} />
								</span>
								<span className="tx">
									<span className="name">{entry.name}</span>
									<span className="sub">{connText(t, conn, now)}</span>
									{!entry.claimed && (
										<span className="chip mx-chip warn" title={t.status.needsLoginHint}>
											{t.status.needsLogin}
										</span>
									)}
								</span>
								{entry.os !== "" && <span className="meta">{t.os(entry.os, entry.arch)}</span>}
							</Link>
						</li>
					))}
				</ul>
				{import.meta.env.DEV && (
					<Link to={paths.machinesLocal()} className="link">
						{t.local.entry}
					</Link>
				)}
			</div>
		</div>
	);
}

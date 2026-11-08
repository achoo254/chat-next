// "Máy của tôi" (ADR 0013; plans …/mock-ui.html): the user's machines, adding
// this computer, pairing this device, a machine's sessions with their board,
// and the remote chat. Desktop shows the list column beside the page like the
// chats; phones show one column at a time. Loaded on demand with its styles.
import type { ReactNode } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { useCopy } from "../messaging/copy/use-copy.ts";
import { Link, paths, type MachinesView } from "../router.tsx";
import { AddMachine } from "./add-machine.tsx";
import { LocalMachine } from "./local-machine.tsx";
import { LOCAL_REF, localPort } from "./link/link-hub.ts";
import { MachineDetail } from "./machine-detail.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { isOnline, type MachineEntry } from "./machines-client.ts";
import { SessionList } from "./machine-sessions.tsx";
import { PairDevice } from "./pair-device.tsx";
import { SessionBoard } from "./session-board.tsx";
import { SessionChat } from "./session-chat.tsx";
import { timeAgo, useDirectory, useHub, useHubPresence, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import "./machines.css";

export default function MachinesScreen({ view }: { view: MachinesView }) {
	const hub = useHub();
	useHubPresence(hub);
	let list: ReactNode;
	let main: ReactNode;
	// Phones show the list on the list pages and the page itself elsewhere.
	let pane: "list" | "main" = "main";
	switch (view.page) {
		case "list":
			list = <MachineList current={null} />;
			main = <MachinesHome />;
			pane = "list";
			break;
		case "add":
			list = <MachineList current={null} />;
			main = <AddMachine />;
			break;
		case "local":
			list = <MachineList current={LOCAL_REF} />;
			// Development builds only: the route does not exist in production, and the branch folds away.
			main = import.meta.env.DEV ? <LocalMachine /> : null;
			break;
		case "info":
			list = <MachineList current={view.machine} />;
			main = <MachineDetail key={view.machine} machine={view.machine} />;
			break;
		case "pair":
			list = <MachineList current={view.machine} />;
			main = <PairDevice key={view.machine} machine={view.machine} />;
			break;
		case "machine":
			list = <SessionList machine={view.machine} current={null} />;
			main = <SessionBoard key={view.machine} machine={view.machine} />;
			pane = "list";
			break;
		case "session":
			list = <SessionList machine={view.machine} current={view.threadId} />;
			main = <SessionChat key={`${view.machine}/${view.threadId}`} machine={view.machine} threadId={view.threadId} />;
			break;
	}
	return (
		<div className="mx" data-pane={pane}>
			{list}
			<section className="mx-main">{main}</section>
		</div>
	);
}

function MachineList({ current }: { current: string | null }) {
	const t = useMachinesCopy();
	const copy = useCopy();
	const hub = useHub();
	const directory = useDirectory(hub);
	const now = useNow();
	const local = localPort() !== null ? hub.entry(LOCAL_REF) : null;
	const machines = local === null ? directory.machines : [...directory.machines, local];
	return (
		<section className="mx-list" aria-label={t.title}>
			<header className="mx-list-head">
				<h2>{t.title}</h2>
				<Link to={paths.machinesAdd()} className="btn btn-primary btn-sm" aria-label={t.add}>
					<Icon name="plus" small />
					<span className="hide-narrow">{t.add}</span>
				</Link>
			</header>
			{directory.status === "error" && (
				<div className="banner error mx-banner" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.common.loadFailed}</span>
					<button type="button" className="btn btn-sm" onClick={() => hub.refresh().catch(() => undefined)}>
						{copy.common.retry}
					</button>
				</div>
			)}
			<ul className="mx-rows" aria-busy={directory.status === "loading"}>
				{machines.map((m) => (
					<li key={m.ref}>
						<MachineRow machine={m} current={m.ref === current} now={now} />
					</li>
				))}
			</ul>
			{directory.status === "ready" && machines.length === 0 && (
				<div className="empty">
					<MachineIcon name="monitor" />
					<h2>{t.emptyTitle}</h2>
					<p>{t.emptyBody}</p>
				</div>
			)}
			{import.meta.env.DEV && (
				<div className="mx-list-foot">
					<Link to={paths.machinesLocal()} className="link">
						{t.local.entry}
					</Link>
				</div>
			)}
		</section>
	);
}

function MachineRow({ machine, current, now }: { machine: MachineEntry; current: boolean; now: number }) {
	const t = useMachinesCopy();
	const online = isOnline(machine, now) && machine.tunnelUrl !== "";
	const sub =
		machine.ref === LOCAL_REF
			? machine.tunnelUrl
			: online
				? t.status.online
				: machine.lastSeenAt === 0
					? t.status.never
					: isOnline(machine, now)
						? t.status.noTunnel
						: t.status.offline(timeAgo(t, machine.lastSeenAt * 1000, now));
	return (
		<Link to={paths.machine(machine.ref)} className="mx-row" current={current}>
			<span className="mx-ico">
				<MachineIcon name="monitor" />
				<span className={online ? "dot on" : "dot off"} />
			</span>
			<span className="tx">
				<span className="name">{machine.name}</span>
				<span className="sub">{sub}</span>
				{!machine.claimed && <span className="chip mx-chip warn">{t.status.needsLogin}</span>}
			</span>
			{machine.os !== "" && <span className="meta">{t.os(machine.os, machine.arch)}</span>}
		</Link>
	);
}

function MachinesHome() {
	const t = useMachinesCopy();
	return (
		<div className="mx-page">
			<div className="empty">
				<MachineIcon name="cpu" />
				<h1>{t.title}</h1>
				<p>{t.about}</p>
				<Link to={paths.machinesAdd()} className="btn btn-primary">
					<Icon name="plus" />
					{t.add}
				</Link>
			</div>
		</div>
	);
}

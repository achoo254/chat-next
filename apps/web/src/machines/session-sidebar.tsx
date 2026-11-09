// The AI Agent column, the same on every AI Agent page: the "Cần bạn" board,
// the filters (all, needs you, running) shared by every machine, then each
// machine as a group header (status in words, a menu with a new session,
// its board, its details, pairing) over its sessions grouped by folder, laid
// out like the chat list. A machine this device cannot use yet says why and
// offers the fix (pair) in place.
import { useState } from "react";
import { ThreadState, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { countLabel } from "../messaging/data/format.ts";
import { Link, paths, type MachinesView } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { sortForList } from "./link/machine-link.ts";
import { LOCAL_REF } from "./link/link-hub.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { needsPairing, type Conn } from "./machine-status.ts";
import { NewSession } from "./new-session.tsx";
import { aiName, folderName, modelName, stateKey, timeAgo, useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

export type Filter = "all" | "need" | "running";

const FILTER_KEY = "ai:filter";

function savedFilter(): Filter {
	try {
		const value = window.sessionStorage.getItem(FILTER_KEY);
		return value === "need" || value === "running" ? value : "all";
	} catch {
		return "all";
	}
}

/** The session matches the filter. */
export function matches(filter: Filter, thread: Pick<ThreadSummary, "state">): boolean {
	if (filter === "need") return thread.state === ThreadState.WAITING;
	if (filter === "running") return thread.state === ThreadState.RUNNING || thread.state === ThreadState.QUEUED;
	return true;
}

/** Sessions by folder, folders in the order of their first (most urgent, newest) session. */
export function byFolder(threads: readonly ThreadSummary[]): { dir: string; threads: ThreadSummary[] }[] {
	const groups = new Map<string, ThreadSummary[]>();
	for (const thread of sortForList(threads)) {
		const list = groups.get(thread.dir);
		if (list === undefined) groups.set(thread.dir, [thread]);
		else list.push(thread);
	}
	return [...groups].map(([dir, list]) => ({ dir, threads: list }));
}

/** The machine's state in words, the same everywhere. */
export function connText(t: MachinesCopy, conn: Conn, now: number): string {
	switch (conn.kind) {
		case "offline":
			return conn.lastSeenMs === 0 ? t.agent.conn.never : t.agent.conn.offline(timeAgo(t, conn.lastSeenMs, now));
		case "retrying":
			return t.agent.conn.retrying(conn.attempt);
		default:
			return t.agent.conn[conn.kind];
	}
}

/** The dot beside a machine: on, waiting, off or a problem to fix. */
export function connDot(conn: Conn): "on" | "wait" | "off" | "warn" {
	switch (conn.kind) {
		case "on":
			return "on";
		case "connecting":
		case "retrying":
		case "checking":
			return "wait";
		case "offline":
			return "off";
		default:
			return "warn";
	}
}

export function SessionSidebar({ view }: { view: MachinesView }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const now = useNow();
	const machines = useMachineViews(hub, now);
	const [filter, setFilterState] = useState<Filter>(savedFilter);
	const setFilter = (next: Filter) => {
		setFilterState(next);
		try {
			window.sessionStorage.setItem(FILTER_KEY, next);
		} catch {
			// Private mode: the filter still applies on this page.
		}
	};
	const need = machines.reduce((n, m) => n + m.state.threads.filter((x) => x.state === ThreadState.WAITING).length, 0);
	const directory = hub.directory();
	const currentThread = view.page === "session" ? view.threadId : null;
	const currentMachine = "machine" in view ? view.machine : null;
	return (
		<section className="mx-list" aria-label={t.agent.sessionsLabel}>
			<header className="mx-list-head">
				<h2>{t.agent.title}</h2>
				<Link to={aiPaths.manage} className="btn btn-sm" current={view.page === "machines" || view.page === "add"}>
					<MachineIcon name="monitor" small />
					{t.agent.machines}
				</Link>
			</header>
			<div className="mx-nav-top">
				<Link to={aiPaths.need} className="mx-inbox" current={view.page === "need"}>
					<Icon name="inbox" />
					<span className="grow">{t.agent.inbox}</span>
					{need > 0 && <span className="badge">{countLabel(need)}</span>}
				</Link>
				<div className="tabs mx-filters" role="tablist" aria-label={t.sessions.filters}>
					{(["all", "need", "running"] as const).map((f) => (
						<button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
							{f === "all" ? t.sessions.all : f === "need" ? t.sessions.need(need) : t.sessions.running}
						</button>
					))}
				</div>
			</div>
			<div className="mx-groups" aria-busy={directory.status === "loading"}>
				{machines.map((m) => (
					<MachineGroup key={m.entry.ref} machine={m} filter={filter} now={now} currentThread={m.entry.ref === currentMachine ? currentThread : null} current={m.entry.ref === currentMachine && currentThread === null} />
				))}
				{directory.status === "ready" && machines.length === 0 && (
					<div className="empty">
						<MachineIcon name="monitor" />
						<h2>{t.agent.noMachinesTitle}</h2>
						<p>{t.agent.noMachinesBody}</p>
						<Link to={paths.machinesAdd()} className="btn btn-primary">
							<Icon name="plus" />
							{t.add}
						</Link>
					</div>
				)}
			</div>
		</section>
	);
}

interface GroupProps {
	machine: MachineView;
	filter: Filter;
	now: number;
	/** The open session, when it is one of this machine's. */
	currentThread: string | null;
	/** This machine's board or details are open. */
	current: boolean;
}

function MachineGroup({ machine, filter, now, currentThread, current }: GroupProps) {
	const t = useMachinesCopy();
	const { entry, link, state, conn } = machine;
	const [creating, setCreating] = useState(false);
	const ref = entry.ref;
	const shown = state.threads.filter((x) => matches(filter, x));
	const folders = byFolder(shown);
	const pairPath = ref === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(ref);
	const loading = conn.kind === "on" ? !state.listed : conn.kind === "connecting" || conn.kind === "checking";
	return (
		<section className="mx-group" aria-label={entry.name}>
			<div className="mx-group-head">
				<Link to={paths.machine(ref)} className="mx-group-name" current={current}>
					<span className={`dot ${connDot(conn)}`} aria-hidden="true" />
					<b>{entry.name}</b>
					<small>{connText(t, conn, now)}</small>
				</Link>
				<GroupMenu name={entry.name} machine={ref} conn={conn} onNew={() => setCreating(true)} />
			</div>
			{needsPairing(conn) && (
				<div className="mx-group-note">
					<p>{conn.kind === "unpaired" ? t.agent.hint.unpaired : t.agent.hint.repair}</p>
					<Link to={pairPath} className="btn btn-sm">
						{t.agent.pair}
					</Link>
				</div>
			)}
			{conn.kind === "update" && <p className="mx-group-note muted">{t.agent.hint.update}</p>}
			{conn.kind === "offline" && state.threads.length === 0 && <p className="mx-group-note muted">{t.agent.hint.offline}</p>}
			{loading && (
				<ul className="mx-rows skeleton" aria-hidden="true">
					<li />
					<li />
				</ul>
			)}
			{folders.map((folder) => (
				<div key={folder.dir} className="mx-folder">
					<p className="mx-folder-name" title={folder.dir}>
						<MachineIcon name="folder" small />
						{folderName(folder.dir)}
					</p>
					<ul className="mx-rows">
						{folder.threads.map((thread) => (
							<li key={thread.id}>
								<SessionRow machine={machine} thread={thread} now={now} current={thread.id === currentThread} />
							</li>
						))}
					</ul>
				</div>
			))}
			{conn.kind === "on" && state.listed && shown.length === 0 && (
				<p className="mx-group-note muted">{state.threads.length === 0 ? t.agent.noSessions : t.agent.emptyFilter}</p>
			)}
			{creating && <NewSession machine={ref} name={entry.name} link={link} state={state} onClose={() => setCreating(false)} />}
		</section>
	);
}

function GroupMenu({ name, machine, conn, onNew }: { name: string; machine: string; conn: Conn; onNew: () => void }) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const pairPath = machine === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(machine);
	return (
		<div className="mx-model" ref={ref}>
			<button type="button" className="icon-btn" aria-label={t.agent.machineMenu(name)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<Icon name="dots" />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={t.agent.machineMenu(name)}>
					<button
						type="button"
						role="menuitem"
						disabled={conn.kind !== "on"}
						onClick={() => {
							setOpen(false);
							onNew();
						}}
					>
						<Icon name="plus" small />
						<span>
							{t.agent.newSession}
							{conn.kind !== "on" && <small>{connTextShort(t, conn)}</small>}
						</span>
					</button>
					<Link to={paths.machine(machine)} className="mx-menu-link">
						<Icon name="inbox" small />
						<span>{t.agent.machineBoard}</span>
					</Link>
					<Link to={paths.machineInfo(machine)} className="mx-menu-link">
						<Icon name="info" small />
						<span>{t.agent.info}</span>
					</Link>
					{needsPairing(conn) && (
						<Link to={pairPath} className="mx-menu-link">
							<Icon name="link" small />
							<span>{t.agent.pair}</span>
						</Link>
					)}
				</div>
			)}
		</div>
	);
}

/** Why a machine cannot take a new session right now. */
function connTextShort(t: MachinesCopy, conn: Conn): string {
	if (conn.kind === "offline") return t.agent.hint.offline;
	if (conn.kind === "unpaired" || conn.kind === "repair" || conn.kind === "update") return t.agent.conn[conn.kind];
	return t.agent.hint.connecting;
}

function SessionRow({ machine, thread, now, current }: { machine: MachineView; thread: ThreadSummary; now: number; current: boolean }) {
	const t = useMachinesCopy();
	const key = stateKey(thread);
	const info = machine.state.info;
	const many = (info?.providers.length ?? 0) > 1;
	const model = thread.model === "" ? aiName(info, thread.provider) : modelName(info, thread.provider, thread.model);
	const sub =
		key === "waiting"
			? t.agent.sub.waiting
			: key === "running"
				? t.agent.sub.running
				: key === "queued"
					? t.agent.sub.queued
					: key === "error"
						? t.agent.sub.error
						: !thread.open
							? t.agent.sub.parked
							: many
								? `${aiName(info, thread.provider)} · ${model}`
								: model;
	return (
		<Link to={paths.machineSession(machine.entry.ref, thread.id)} className={`mx-srow ${key}`} current={current}>
			<span className={`mx-st ${key}`} aria-hidden="true">
				{key === "running" ? <span className="spin" /> : <MachineIcon name={key === "waiting" ? "help" : "terminal"} small />}
			</span>
			<span className="tx">
				<span className="line">
					<span className="name">{thread.title}</span>
					<time>{timeAgo(t, Number(thread.updatedAt), now)}</time>
				</span>
				<span className="line">
					<span className="sub">{sub}</span>
					{thread.pending > 0 && (
						<span className="badge" aria-label={t.sessions.waiting(thread.pending)}>
							{thread.pending}
						</span>
					)}
				</span>
			</span>
		</Link>
	);
}

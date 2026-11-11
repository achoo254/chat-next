// The AI Agent column, the same on every AI Agent page: the "Cần bạn" board,
// the filters (all, needs you, running) shared by every machine, then each
// machine as a group header (status in words, a menu with a new session,
// its board, its details, pairing) over its sessions grouped by folder, laid
// out like the chat list. A machine this device cannot use yet says why and
// offers the fix (pair) in place. Archived sessions show only under their own
// filter; a row's menu (hover, or a long press on a phone) archives or
// deletes it on machines that can (tunelo 2.0.6+).
import { useEffect, useState, type MouseEvent } from "react";
import { ThreadState, type MachineInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { countLabel } from "../messaging/data/format.ts";
import { Link, navigate, paths, type MachinesView } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { terminalGate, type TerminalGate } from "./agent-version.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { sortForList } from "./link/machine-link.ts";
import { LOCAL_REF } from "./link/link-hub.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { useCollapsed } from "./use-collapsed.ts";
import { FirstMachine } from "./first-machine.tsx";
import { needsPairing, type Conn } from "./machine-status.ts";
import { NewSession } from "./new-session.tsx";
import { aiName, folderName, modelName, stateKey, timeAgo, useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "./thread-actions.tsx";
import { AddProject, ProjectSection, ProjectSuggestions } from "./project-section.tsx";
import { byProject, projectsSupported } from "./projects-view.ts";

export type Filter = "all" | "need" | "running" | "archived";

const FILTER_KEY = "ai:filter";

function savedFilter(): Filter {
	try {
		const value = window.sessionStorage.getItem(FILTER_KEY);
		return value === "need" || value === "running" || value === "archived" ? value : "all";
	} catch {
		return "all";
	}
}

/** The session matches the filter: "all" leaves archived ones out, "archived" shows only them; what needs the user or runs shows either way. */
export function matches(filter: Filter, thread: Pick<ThreadSummary, "state" | "archived">): boolean {
	if (filter === "need") return thread.state === ThreadState.WAITING;
	if (filter === "running") return thread.state === ThreadState.RUNNING || thread.state === ThreadState.QUEUED;
	if (filter === "archived") return thread.archived;
	return !thread.archived;
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
		case "unpaired":
			return conn.online ? t.agent.conn.unpaired : t.agent.conn.unpairedOffline;
		default:
			return t.agent.conn[conn.kind];
	}
}

/** The dot beside a machine: on, waiting, off, ready to pair, or a problem to fix. */
export function connDot(conn: Conn): "on" | "wait" | "off" | "pair" | "warn" {
	switch (conn.kind) {
		case "unpaired":
			// Online and only waiting for this device to pair, or not reachable at all.
			return conn.online ? "pair" : "off";
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
	const archived = machines.some((m) => m.state.threads.some((x) => x.archived));
	const need = machines.reduce((n, m) => n + m.state.threads.filter((x) => x.state === ThreadState.WAITING).length, 0);
	const directory = hub.directory();
	const currentThread = view.page === "session" ? view.threadId : null;
	const terminalOpen = view.page === "terminal" ? view.machine : null;
	const currentMachine = "machine" in view ? view.machine : null;
	return (
		<section className="mx-list" aria-label={t.agent.sessionsLabel}>
			<header className="mx-list-head">
				<h2>{t.agent.title}</h2>
				<Link to={aiPaths.manage} className="btn btn-sm mx-manage" title={t.agent.machines} current={view.page === "machines" || view.page === "add"}>
					<MachineIcon name="monitor" small />
					<span>{t.agent.machines}</span>
				</Link>
			</header>
			<div className="mx-nav-top">
				<Link to={aiPaths.need} className="mx-inbox" current={view.page === "need"}>
					<Icon name="inbox" />
					<span className="grow">{t.agent.inbox}</span>
					{need > 0 && <span className="badge">{countLabel(need)}</span>}
				</Link>
				<div className="tabs mx-filters" role="tablist" aria-label={t.sessions.filters}>
					{(["all", "need", "running", "archived"] as const)
						.filter((f) => f !== "archived" || archived || filter === "archived")
						.map((f) => (
							<button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
								{f === "all" ? t.sessions.all : f === "need" ? t.sessions.need(need) : f === "running" ? t.sessions.running : t.agent.thread.archived}
							</button>
						))}
				</div>
			</div>
			<div className="mx-groups" aria-busy={directory.status === "loading"}>
				{machines.map((m) => (
					<MachineGroup
						key={m.entry.ref}
						machine={m}
						filter={filter}
						now={now}
						currentThread={m.entry.ref === currentMachine ? currentThread : null}
						current={m.entry.ref === currentMachine && currentThread === null && terminalOpen === null}
						terminalOpen={m.entry.ref === terminalOpen}
					/>
				))}
				{directory.status === "ready" && machines.length === 0 && <FirstMachine compact />}
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
	/** This machine's terminal is open. */
	terminalOpen: boolean;
}

function MachineGroup({ machine, filter, now, currentThread, current, terminalOpen }: GroupProps) {
	const t = useMachinesCopy();
	const { entry, link, state, conn } = machine;
	const [creating, setCreating] = useState(false);
	const ref = entry.ref;
	const [collapsed, toggleCollapsed] = useCollapsed(`machine:${ref}`);
	const shown = state.threads.filter((x) => matches(filter, x));
	// tunelo 2.0.7+: sessions by project, the rest under "Khác".
	const withProjects = projectsSupported(state.info?.agentVersion);
	const online = conn.kind === "on";
	useEffect(() => {
		if (withProjects && online && state.projects === null) link.request({ case: "projectList", value: {} }).catch(() => undefined);
	}, [withProjects, online, state.projects, link]);
	const projectList = withProjects ? (state.projects?.projects ?? []) : [];
	const grouped = byProject(shown, projectList);
	const folders = byFolder(withProjects ? grouped.other : shown);
	const order = projectList.map((x) => x.id);
	const pairPath = ref === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(ref);
	const loading = conn.kind === "on" ? !state.listed : conn.kind === "connecting" || conn.kind === "checking";
	// The machine's Claude account, as it announces it (tunelo 2.0.2+): it changes for every session at once.
	const terminal = terminalGate(state.info);
	const picked = state.machineProfile?.profiles;
	const account = picked?.profiles.find((p) => p.id === picked.selectedId)?.email ?? "";
	return (
		<section className="mx-group" aria-label={entry.name}>
			<div className="mx-group-head">
				<button
					type="button"
					className="icon-btn mx-fold"
					aria-expanded={!collapsed}
					aria-label={collapsed ? t.agent.expand(entry.name) : t.agent.collapse(entry.name)}
					onClick={toggleCollapsed}
				>
					<MachineIcon name={collapsed ? "chevron-right" : "chevron-down"} small />
				</button>
				<Link to={paths.machine(ref)} className="mx-group-name" current={current}>
					<span className={`dot ${connDot(conn)}`} aria-hidden="true" />
					<b>{entry.name}</b>
					<small>
						{connText(t, conn, now)}
						{conn.kind === "on" && account !== "" && ` · ${account}`}
					</small>
				</Link>
				<GroupMenu name={entry.name} machine={ref} conn={conn} terminal={terminal} onNew={() => setCreating(true)} />
			</div>
			{!collapsed && (
				<>
				{needsPairing(conn) && (
					<div className="mx-group-note">
						<p>{conn.kind === "unpaired" ? t.agent.hint.unpaired : t.agent.hint.repair}</p>
						<Link to={pairPath} className="btn btn-sm">
							{t.agent.pair}
						</Link>
					</div>
				)}
				{conn.kind === "update" && <p className="mx-group-note muted">{t.agent.hint.update}</p>}
				{terminal === "available" && online && (
					<ul className="mx-rows">
						<li>
							<Link to={paths.machineTerminal(ref)} className="mx-srow" current={terminalOpen}>
								<span className="mx-st idle" aria-hidden="true">
									<MachineIcon name="terminal" small />
								</span>
								<span className="tx">
									<span className="line">
										<span className="name">{t.terminal.entry}</span>
									</span>
								</span>
							</Link>
						</li>
					</ul>
				)}
				{conn.kind === "offline" && state.threads.length === 0 && <p className="mx-group-note muted">{t.agent.hint.offline}</p>}
				{loading && (
					<ul className="mx-rows skeleton" aria-hidden="true">
						<li />
						<li />
					</ul>
				)}
				{grouped.groups
					.filter((g) => filter === "all" || g.threads.length > 0)
					.map((g) => (
						<ProjectSection key={g.project.id} machine={ref} machineName={entry.name} link={link} state={state} project={g.project} order={order} online={online}>
							{g.threads.length > 0 && (
								<ul className="mx-rows">
									{g.threads.map((thread) => (
										<li key={thread.id}>
											<SessionRow machine={machine} thread={thread} now={now} current={thread.id === currentThread} />
										</li>
									))}
								</ul>
							)}
						</ProjectSection>
					))}
				{withProjects && projectList.length > 0 && folders.length > 0 && <p className="mx-other-head">{t.agent.projects.other}</p>}
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
				{withProjects && online && filter === "all" && state.projects !== null && (
					<>
						<ProjectSuggestions machine={ref} link={link} suggestions={state.projects.suggestions} />
						<div className="mx-group-note">
							<AddProject link={link} state={state} />
						</div>
					</>
				)}
				{conn.kind === "on" && state.listed && shown.length === 0 && projectList.length === 0 && (
					<p className="mx-group-note muted">{state.threads.length === 0 ? t.agent.noSessions : filter === "archived" ? t.agent.thread.noArchived : t.agent.emptyFilter}</p>
				)}
				</>
			)}
			{creating && <NewSession machine={ref} name={entry.name} link={link} state={state} onClose={() => setCreating(false)} />}
		</section>
	);
}

function GroupMenu({ name, machine, conn, terminal, onNew }: { name: string; machine: string; conn: Conn; terminal: TerminalGate; onNew: () => void }) {
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
					{terminal === "available" ? (
						<Link to={paths.machineTerminal(machine)} className="mx-menu-link">
							<MachineIcon name="terminal" small />
							<span>{t.terminal.entry}</span>
						</Link>
					) : (
						terminal !== "unknown" && (
							<button type="button" role="menuitem" disabled>
								<MachineIcon name="terminal" small />
								<span>
									{t.terminal.entry}
									<small>{t.terminal.hint[terminal]}</small>
								</span>
							</button>
						)
					)}
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

/**
 * A session row's second line: what waits for the user first, then the tool
 * running now, the last message (tunelo 2.0.2+), else the state or model.
 * A session opened with no message (it has no name yet) says so.
 */
export function rowLine(t: MachinesCopy, thread: ThreadSummary, info: MachineInfo | null): string {
	const key = stateKey(thread);
	if (key === "waiting") return t.agent.sub.waiting;
	if (thread.previewTool !== "") return t.agent.sub.tool(thread.previewTool);
	if (thread.preview !== "") return thread.preview;
	if (key === "running" || key === "queued" || key === "error") return t.agent.sub[key];
	if (thread.title === "") return t.agent.sub.empty;
	if (!thread.open) return t.agent.sub.parked;
	const model = thread.model === "" ? aiName(info, thread.provider) : modelName(info, thread.provider, thread.model);
	return (info?.providers.length ?? 0) > 1 ? `${aiName(info, thread.provider)} · ${model}` : model;
}

function SessionRow({ machine, thread, now, current }: { machine: MachineView; thread: ThreadSummary; now: number; current: boolean }) {
	const t = useMachinesCopy();
	const key = stateKey(thread);
	const sub = rowLine(t, thread, machine.state.info);
	const manage = threadActionsSupported(machine.state.info) && machine.state.status.kind === "open";
	const { open, setOpen, ref } = usePopover();
	const [deleting, setDeleting] = useState(false);
	const online = machine.conn.kind === "on" || current;
	const content = (
		<>
				<span className={`mx-st ${key}`} aria-hidden="true">
					{key === "running" ? <span className="spin" /> : <MachineIcon name={key === "waiting" ? "help" : "terminal"} small />}
				</span>
				<span className="tx">
					<span className="line">
						<span className="name">{thread.title || t.agent.newSession}</span>
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
		</>
	);
	const row = online ? (
		<Link
			to={paths.machineSession(machine.entry.ref, thread.id)}
			className={`mx-srow ${key}`}
			current={current}
			// A long press on a phone (or a right click) opens the row's menu.
			{...(manage
				? {
						onContextMenu: (event: MouseEvent) => {
							event.preventDefault();
							setOpen(true);
						},
					}
				: {})}
		>
			{content}
		</Link>
	) : (
		<div className={`mx-srow ${key} disabled`} aria-disabled="true" title={t.agent.openDisabled(connText(t, machine.conn, now))}>
			{content}
		</div>
	);
	if (!manage) return row;
	return (
		<div className="mx-srow-wrap" ref={ref} data-open={open ? "" : undefined}>
			{row}
			<button type="button" className="icon-btn mx-srow-menu" aria-label={t.agent.thread.rowMenu(thread.title)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<Icon name="dots" small />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={t.agent.thread.rowMenu(thread.title)}>
					<ThreadMenuItems link={machine.link} thread={thread} onDelete={() => setDeleting(true)} onDone={() => setOpen(false)} />
				</div>
			)}
			{deleting && (
				<DeleteThreadDialog
					link={machine.link}
					thread={thread}
					machine={machine.entry.name}
					ai={aiName(machine.state.info, thread.provider)}
					onClose={() => setDeleting(false)}
					onDeleted={() => {
						if (current) navigate(paths.machines());
					}}
				/>
			)}
		</div>
	);
}

// The AI Agent column, the same on every AI Agent page, kept as plain as
// Orca's: every session lives in a project (a folder on one of the user's
// machines), and the column is one list of projects, each with its sessions.
// A folder that holds sessions but was never added as a project shows the
// same way, offering "Thêm làm dự án", so nothing a user had disappears.
// With several machines each project shows its machine's name; the machine
// is picked only when adding a project. On top: "Quản lý máy" (machines,
// their state, pairing, overview, settings and plain shells; a dot when one
// needs the user), then one row with the switch that keeps only what needs
// the user or runs, and "+" for "Thêm dự án". Projects and sessions show a
// badge when they need the user or run. Projects of an offline machine stay,
// dimmed; a machine with nothing to list stays under "Quản lý máy" only. Archived sessions show only behind their own link;
// a row's menu (hover, or a long press on a phone) opens it in the terminal,
// archives or deletes it on machines that can (tunelo 2.0.6+). A machine
// older than projects (tunelo before 2.0.7) still lists its sessions by folder.
import { useEffect, useState, type MouseEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, ThreadState, type MachineInfo, type Project, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Link, navigate, paths, type MachinesView } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { sortForList } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { FirstMachine } from "./first-machine.tsx";
import { needsPairing, type Conn } from "./machine-status.ts";
import type { ProjectHost } from "./project-dialogs.tsx";
import { aiName, folderName, isRunning, modelName, stateKey, timeAgo, useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "./thread-actions.tsx";
import { AddProject, ProjectSection } from "./project-section.tsx";
import { byProject, projectsSupported } from "./projects-view.ts";
import { rememberMode, sessionPath, terminalOffered } from "./session-mode.tsx";

/** "attention": only what needs the user or runs. */
export type Filter = "all" | "need" | "running" | "attention" | "archived";

const FILTER_KEY = "ai:filter";

function savedFilter(): Filter {
	try {
		const value = window.sessionStorage.getItem(FILTER_KEY);
		return value === "attention" || value === "archived" ? value : "all";
	} catch {
		return "all";
	}
}

type Matched = Pick<ThreadSummary, "state" | "archived"> & Partial<Pick<ThreadSummary, "busyElsewhere">>;

/** The session matches the filter: "all" leaves archived ones out, "archived" shows only them; what needs the user or runs shows either way. */
export function matches(filter: Filter, thread: Matched): boolean {
	if (filter === "need") return thread.state === ThreadState.WAITING;
	if (filter === "running") return isRunning(thread);
	if (filter === "attention") return thread.state === ThreadState.WAITING || isRunning(thread);
	if (filter === "archived") return thread.archived;
	return !thread.archived;
}

/** Sessions the "running" filter shows (archived ones too, as the filter does). */
export function runningCount(threads: readonly Matched[]): number {
	return threads.filter((x) => matches("running", x)).length;
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

/** A machine's rows: its projects, then folders that hold sessions but are no project (as projects of their own). */
export function hostRows(machine: MachineView, filter: Filter): { projects: { project: Project; threads: ThreadSummary[]; folder: boolean }[]; withProjects: boolean } {
	const { state } = machine;
	const withProjects = projectsSupported(state.info?.agentVersion);
	const list = withProjects ? (state.projects?.projects ?? []) : [];
	const grouped = byProject(state.threads.filter((x) => matches(filter, x)), list);
	const added = grouped.groups.filter((g) => filter === "all" || g.threads.length > 0).map((g) => ({ ...g, folder: false }));
	const folders = byFolder(grouped.other).map((f) => ({ project: create(ProjectSchema, { id: `folder:${f.dir}`, name: folderName(f.dir), dir: f.dir }), threads: f.threads, folder: true }));
	return { projects: [...added, ...folders], withProjects };
}

/** Machines a project can be added on now: online, and keeping projects. */
export function projectHosts(machines: readonly MachineView[]): ProjectHost[] {
	return machines
		.filter((m) => m.conn.kind === "on" && projectsSupported(m.state.info?.agentVersion))
		.map((m) => ({ ref: m.entry.ref, name: m.entry.name, link: m.link, state: m.state }));
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
	const threads = machines.flatMap((m) => m.state.threads);
	const archived = threads.filter((x) => x.archived).length;
	const attention = threads.filter((x) => matches("attention", x)).length;
	const directory = hub.directory();
	const currentThread = view.page === "session" || view.page === "session-terminal" ? view.threadId : null;
	const currentMachine = "machine" in view ? view.machine : null;
	const many = machines.length > 1;
	const hosts = projectHosts(machines);
	const rows = machines.map((m) => hostRows(m, filter));
	// Nothing listed on any machine yet (and every machine that can answer did): one empty state for the whole list.
	const settled = machines.every((m) => m.conn.kind !== "on" || (m.state.listed && (m.state.projects !== null || !projectsSupported(m.state.info?.agentVersion))));
	const empty = filter === "all" && machines.length > 0 && settled && rows.every((r) => r.projects.length === 0);
	// A machine that needs pairing or an update: "Quản lý máy" says so with a dot.
	const attentionHost = machines.some((m) => needsPairing(m.conn) || m.conn.kind === "update");
	return (
		<section className="mx-list" aria-label={t.agent.sessionsLabel}>
			<header className="mx-list-head">
				<h2>{t.agent.title}</h2>
				<Link to={aiPaths.manage} className="btn btn-sm mx-manage" title={t.agent.machines} current={view.page === "machines" || view.page === "add"}>
					<MachineIcon name="monitor" small />
					<span>{t.agent.machines}</span>
					{attentionHost && <span className="dot warn" role="img" aria-label={t.agent.hint.machinesNeedYou} />}
				</Link>
			</header>
			<div className="mx-nav-top">
				<button
					type="button"
					role="switch"
					className="mx-attn"
					aria-checked={filter === "attention"}
					onClick={() => setFilter(filter === "attention" ? "all" : "attention")}
					data-id="sidebar-attention"
				>
					<span className="track" aria-hidden="true" />
					<span className="grow">{t.sessions.attentionOnly}</span>
					{attention > 0 && <span className="badge">{attention}</span>}
				</button>
				<AddProject hosts={hosts} compact />
			</div>
			<div className="mx-groups" aria-busy={directory.status === "loading"}>
				{machines.map((m, i) => (
					<MachineProjects
						key={m.entry.ref}
						machine={m}
						rows={rows[i] ?? { projects: [], withProjects: false }}
						now={now}
						many={many}
						currentThread={m.entry.ref === currentMachine ? currentThread : null}
					/>
				))}
				{empty && (
					<div className="mx-empty-list" data-id="sidebar-empty">
						<p>{t.agent.projects.none}</p>
						<AddProject hosts={hosts} primary />
					</div>
				)}
				{directory.status === "ready" && machines.length === 0 && <FirstMachine compact />}
				{(archived > 0 || filter === "archived") && (
					<button type="button" className="mx-archived-link" onClick={() => setFilter(filter === "archived" ? "all" : "archived")} aria-pressed={filter === "archived"}>
						{filter === "archived" ? t.sessions.hideArchived : t.sessions.showArchived(archived)}
					</button>
				)}
			</div>
		</section>
	);
}

interface ProjectsProps {
	machine: MachineView;
	rows: ReturnType<typeof hostRows>;
	now: number;
	/** The user has more than one machine: each project names its own. */
	many: boolean;
	/** The open session, when it is one of this machine's. */
	currentThread: string | null;
}

/** One machine's projects, without a header of its own (its state lives under "Quản lý máy"). */
function MachineProjects({ machine, rows, now, many, currentThread }: ProjectsProps) {
	const t = useMachinesCopy();
	const { entry, link, state, conn } = machine;
	const ref = entry.ref;
	const withProjects = rows.withProjects;
	const online = conn.kind === "on";
	useEffect(() => {
		if (withProjects && online && state.projects === null) link.request({ case: "projectList", value: {} }).catch(() => undefined);
	}, [withProjects, online, state.projects, link]);
	const order = (state.projects?.projects ?? []).map((x) => x.id);
	const loading = online ? !state.listed : conn.kind === "connecting" || conn.kind === "checking";
	const row = (thread: ThreadSummary) => (
		<li key={thread.id}>
			<SessionRow machine={machine} thread={thread} now={now} current={thread.id === currentThread} />
		</li>
	);
	if (!loading && rows.projects.length === 0) return null;
	return (
		<section className="mx-group" aria-label={entry.name}>
			{loading && (
				<ul className="mx-rows skeleton" aria-hidden="true">
					<li />
					<li />
				</ul>
			)}
			{rows.projects.map((g) => (
						<ProjectSection
							key={g.project.id}
							machine={ref}
							machineName={entry.name}
							link={link}
							state={state}
							project={g.project}
							order={order}
							online={online}
							host={many ? entry.name : undefined}
							offline={online ? "" : t.agent.projects.hostOffline}
							need={g.threads.filter((x) => x.state === ThreadState.WAITING).length}
							running={g.threads.some((x) => isRunning(x))}
							{...(g.folder ? { folder: { canAdd: withProjects } } : {})}
						>
							{g.threads.length > 0 && <ul className="mx-rows">{g.threads.map(row)}</ul>}
						</ProjectSection>
				))}
		</section>
	);
}

/**
 * A session row's second line: what waits for the user first, then the tool
 * running now, the last message (tunelo 2.0.2+), else the state or model.
 * A session opened with no message (it has no name yet) says so.
 */
export function rowLine(t: MachinesCopy, thread: ThreadSummary, info: MachineInfo | null): string {
	const key = stateKey(thread);
	if (key === "waiting") return t.agent.sub.waiting;
	if (thread.terminalSession > 0) return t.agent.sub.inTerminal;
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
	const ref_ = machine.entry.ref;
	const inTerminal = terminalOffered(machine.state.info, thread.provider);
	// A dot only when the session needs the user (amber) or runs (accent).
	const dot = key === "waiting" ? "need" : isRunning(thread) || thread.terminalSession > 0 ? "run" : "";
	const content = (
		<>
			<span className={`mx-sdot ${dot}`} aria-hidden="true" />
			<span className="tx">
				<span className="line">
					<span className="name">{thread.title || t.agent.newSession}</span>
					{thread.pending > 0 && (
						<span className="badge" aria-label={t.sessions.waiting(thread.pending)}>
							{thread.pending}
						</span>
					)}
				</span>
				<span className="line">
					<span className="sub">
						{sub} · <time>{timeAgo(t, Number(thread.updatedAt), now)}</time>
					</span>
				</span>
			</span>
		</>
	);
	const row = online ? (
		<Link
			to={sessionPath(ref_, thread.id, inTerminal)}
			className={`mx-srow slim ${key}`}
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
		<div className={`mx-srow slim ${key} disabled`} aria-disabled="true" title={t.agent.openDisabled(connText(t, machine.conn, now))}>
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
					{inTerminal && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								rememberMode(ref_, "terminal");
								navigate(aiPaths.sessionTerminal(ref_, thread.id));
							}}
						>
							<MachineIcon name="terminal" small />
							<span>{t.terminal.openInTerminal}</span>
						</button>
					)}
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

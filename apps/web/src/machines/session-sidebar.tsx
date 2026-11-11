// The AI Agent column, the same on every AI Agent page. It speaks of
// projects, never of machines: Project (kept by the server, empty or linked
// to a git repository) > Workspace (a folder on one machine, with its own
// state) > sessions (project-tree.ts, project-tree-view.tsx). On top:
// "Quản lý máy" (machines, their state, pairing, overview, settings and
// plain shells; a dot when one needs the user), then one row with the switch
// that keeps only what needs the user or runs and "+" for "Thêm dự án".
// Folders whose sessions no workspace holds wait, folded, in "Chưa phân
// loại" at the bottom; archived sessions show only behind their own link.
// While it shows, the folders every machine keeps become workspaces
// (project-actions.ts), and each session this device opens counts as seen.
import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link, type MachinesView } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { useAgentProjects } from "./agent-projects-store.ts";
import { FirstMachine } from "./first-machine.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { needsPairing, type Conn } from "./machine-status.ts";
import { useProjectSync, type SyncHost } from "./project-actions.ts";
import { buildTree, locate, matches, type Filter } from "./project-tree.ts";
import { LooseGroup, ProjectItem, type TreeContext } from "./project-tree-view.tsx";
import { projectsSupported } from "./projects-view.ts";
import { useSeen } from "./seen-sessions.ts";
import { useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export { connText, rowLine } from "./session-row.tsx";
export { matches, type Filter } from "./project-tree.ts";

const AddAgentProjectDialog = lazy(() => import("./agent-project-dialogs.tsx").then((m) => ({ default: m.AddAgentProjectDialog })));

const FILTER_KEY = "ai:filter";
const OPEN_KEY = "ai:open-projects";

function readSession<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
	try {
		const raw = window.sessionStorage.getItem(key);
		return raw === null ? fallback : parse(JSON.parse(raw));
	} catch {
		return fallback;
	}
}

function writeSession(key: string, value: unknown): void {
	try {
		window.sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode: the choice still applies on this page.
	}
}

/** Links asked for their projects and not answered yet. */
const asked = new WeakSet<MachineView["link"]>();

const asFilter = (raw: unknown): Filter => (raw === "attention" || raw === "archived" ? raw : "all");

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
	const [store, snapshot] = useAgentProjects();
	const [filter, setFilterState] = useState<Filter>(() => readSession(FILTER_KEY, asFilter, "all"));
	const setFilter = (next: Filter) => {
		setFilterState(next);
		writeSession(FILTER_KEY, next);
	};
	const [opened, setOpened] = useState<Record<string, boolean>>(() => readSession(OPEN_KEY, (raw) => (typeof raw === "object" && raw !== null ? (raw as Record<string, boolean>) : {}), {}));
	const [looseOpen, setLooseOpen] = useState(false);
	const current = view.page === "session" || view.page === "session-terminal" ? { machine: view.machine, thread: view.threadId } : null;
	const seen = useSeen(machines.flatMap((m) => m.state.threads.map((x) => ({ id: x.id, at: Number(x.updatedAt), open: m.entry.ref === current?.machine && x.id === current.thread }))));

	// Machines keeping projects list them (once per link until it answers); their folders become workspaces.
	const unlisted = machines.filter((m) => m.conn.kind === "on" && projectsSupported(m.state.info?.agentVersion) && m.state.projects === null);
	const unlistedKey = unlisted.map((m) => m.entry.ref).join(",");
	useEffect(() => {
		// Listed now: asked again should the list ever go (a link that starts over).
		for (const m of machines) if (!unlisted.includes(m)) asked.delete(m.link);
		for (const m of unlisted) {
			if (asked.has(m.link)) continue;
			asked.add(m.link);
			m.link.request({ case: "projectList", value: {} }).catch(() => asked.delete(m.link));
		}
		// `unlistedKey` stands for `unlisted`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [unlistedKey]);
	const hosts: SyncHost[] = machines.map((m) => ({
		id: m.entry.id,
		link: m.link,
		state: m.state,
		ready: m.conn.kind === "on" && projectsSupported(m.state.info?.agentVersion) && m.state.projects !== null,
	}));
	useProjectSync(store, snapshot, hosts);

	const threads = machines.flatMap((m) => m.state.threads);
	const archived = threads.filter((x) => x.archived).length;
	const attention = threads.filter((x) => matches("attention", x)).length;
	const tree = buildTree(snapshot.projects, machines, filter, seen);
	// The open session's project stays open.
	const currentMachine = current === null ? undefined : machines.find((m) => m.entry.ref === current.machine);
	const currentDir = currentMachine?.state.threads.find((x) => x.id === current?.thread)?.dir;
	const selected = currentMachine === undefined || currentDir === undefined ? null : locate(snapshot.projects, currentMachine.entry.id, currentDir)?.project.id;
	// Open: the selected project, one needing the user or running, and an empty one (its "Thêm workspace" is the next step).
	const isOpen = (id: number, need: number, status: string, empty: boolean) => opened[id] ?? (id === selected || need > 0 || status === "running" || empty);
	const toggle = (id: number, wasOpen: boolean) => {
		const next = { ...opened, [id]: !wasOpen };
		setOpened(next);
		writeSession(OPEN_KEY, next);
	};
	const ctx: TreeContext = { store, projects: snapshot.projects, machines, now, seen, current };
	const directory = hub.directory();
	// Nothing to list yet (and every machine that can answer did): one empty state for the whole list.
	const settled = snapshot.status !== "loading" && machines.every((m) => m.conn.kind !== "on" || m.state.listed);
	const empty = filter === "all" && machines.length > 0 && settled && tree.projects.length === 0 && tree.loose.length === 0;
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
				<AddProject machines={machines} compact />
			</div>
			<div className="mx-groups" aria-busy={directory.status === "loading" || snapshot.status === "loading"}>
				{snapshot.status === "loading" && machines.length > 0 && (
					<ul className="mx-rows skeleton" aria-hidden="true">
						<li />
						<li />
					</ul>
				)}
				{tree.projects.map((node) => {
					const open = isOpen(node.project.id, node.need, node.status, node.project.workspaces.length === 0);
					return <ProjectItem key={node.project.id} node={node} open={open} onToggle={() => toggle(node.project.id, open)} ctx={ctx} />;
				})}
				{empty && (
					<div className="mx-empty-list" data-id="sidebar-empty">
						<p>{t.agent.projects.none}</p>
						<AddProject machines={machines} primary />
					</div>
				)}
				{directory.status === "ready" && machines.length === 0 && <FirstMachine compact />}
				<LooseGroup folders={tree.loose} ctx={ctx} open={looseOpen || tree.loose.some((f) => f.machine.entry.ref === current?.machine && f.threads.some((x) => x.id === current.thread))} onToggle={() => setLooseOpen((v) => !v)} />
				{(archived > 0 || filter === "archived") && (
					<button type="button" className="mx-archived-link" onClick={() => setFilter(filter === "archived" ? "all" : "archived")} aria-pressed={filter === "archived"}>
						{filter === "archived" ? t.sessions.hideArchived : t.sessions.showArchived(archived)}
					</button>
				)}
			</div>
		</section>
	);
}

/** "Thêm dự án"; the dialog loads when opened. `compact`: an icon button. */
function AddProject({ machines, compact = false, primary = false }: { machines: readonly MachineView[]; compact?: boolean; primary?: boolean }) {
	const t = useMachinesCopy();
	const [store] = useAgentProjects();
	const [open, setOpen] = useState(false);
	const label = t.agent.projects.add;
	return (
		<>
			<button type="button" className={compact ? "icon-btn" : primary ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-label={label} title={label} onClick={() => setOpen(true)} data-id="add-project">
				<Icon name="plus" small />
				{!compact && label}
			</button>
			{open && (
				<Suspense fallback={null}>
					<AddAgentProjectDialog store={store} machines={machines} onClose={() => setOpen(false)} />
				</Suspense>
			)}
		</>
	);
}

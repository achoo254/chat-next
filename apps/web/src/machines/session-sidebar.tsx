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
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link, type MachinesView } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { useAgentProjects } from "./agent-projects-store.ts";
import { FirstMachine } from "./first-machine.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { isBlocked, type Conn } from "./machine-status.ts";
import { useProjectSync, type SyncHost } from "./project-actions.ts";
import { buildTree, locate, matches, type Filter } from "./project-tree.ts";
import { movedTo, useProjectDrag } from "./project-drag.ts";
import { LooseGroup, ProjectItem, type ProjectPlace, type TreeContext } from "./project-tree-view.tsx";
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

/** The dot beside a machine: on, waiting, off, or a problem to fix. */
export function connDot(conn: Conn): "on" | "wait" | "off" | "warn" {
	switch (conn.kind) {
		case "on":
			return "on";
		case "connecting":
		case "retrying":
			return "wait";
		case "offline":
			return "off";
		default:
			return "warn";
	}
}

const rowsIn = (root: HTMLElement | null): HTMLElement[] => (root === null ? [] : [...root.querySelectorAll<HTMLElement>("[data-row]")]);

/**
 * The column's rows as one list for the keyboard (roving tabindex): one row
 * is in the tab order (the last one focused, else the open session, else the
 * first); Up/Down move, Home/End jump, Enter opens (links and buttons do it
 * themselves), Right opens a folded project, Left folds it or goes up to it.
 */
function useRowKeys() {
	const ref = useRef<HTMLDivElement>(null);
	const last = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const rows = rowsIn(ref.current);
		const keep = last.current !== null && rows.includes(last.current) ? last.current : (rows.find((r) => r.getAttribute("aria-current") === "page") ?? rows[0]);
		for (const row of rows) row.tabIndex = row === keep ? 0 : -1;
	});
	const focus = (row: HTMLElement | undefined) => {
		if (row === undefined) return;
		for (const r of rowsIn(ref.current)) r.tabIndex = r === row ? 0 : -1;
		last.current = row;
		row.focus();
	};
	// Listened on the column itself: the rows stay plain links and buttons.
	useEffect(() => {
		const root = ref.current;
		if (root === null) return;
		const onFocus = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement && event.target.hasAttribute("data-row")) last.current = event.target;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			const row = event.target;
			if (!(row instanceof HTMLElement) || !row.hasAttribute("data-row")) return;
			const rows = rowsIn(root);
			const at = rows.indexOf(row);
			const toggle = row.classList.contains("mx-project-toggle") ? row : null;
			switch (event.key) {
				case "ArrowDown":
					focus(rows[at + 1]);
					break;
				case "ArrowUp":
					focus(rows[at - 1]);
					break;
				case "Home":
					focus(rows[0]);
					break;
				case "End":
					focus(rows.at(-1));
					break;
				case "ArrowRight":
					if (toggle?.getAttribute("aria-expanded") !== "false") return;
					toggle.click();
					break;
				case "ArrowLeft":
					if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
					else if (toggle === null) focus(row.closest(".mx-project")?.querySelector<HTMLElement>(".mx-project-toggle") ?? undefined);
					else return;
					break;
				default:
					return;
			}
			event.preventDefault();
		};
		root.addEventListener("keydown", onKeyDown);
		root.addEventListener("focusin", onFocus);
		return () => {
			root.removeEventListener("keydown", onKeyDown);
			root.removeEventListener("focusin", onFocus);
		};
	}, []);
	return ref;
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
	const groups = useRowKeys();
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
	// The user's order of the projects: dragged, or one place from a project's menu; only with every project shown.
	const order = tree.projects.map((n) => n.project.id);
	const reorderable = filter === "all" && snapshot.status === "ready";
	const reorder = (ids: number[]) => {
		store.reorder(ids).catch((err: unknown) => console.warn("ai: could not reorder the projects", err));
	};
	const { drag, onPointerDown } = useProjectDrag(groups, order, reorderable, reorder);
	const placeOf = (id: number): ProjectPlace | undefined => {
		if (!reorderable) return undefined;
		const i = order.indexOf(id);
		const from = drag === null ? -1 : order.indexOf(drag.id);
		// No line where the dragged project would stay where it is.
		const still = drag === null || drag.index === from || drag.index === from + 1;
		let mark: ProjectPlace["drag"] = null;
		if (drag?.id === id) mark = "dragging";
		else if (!still && drag?.index === i) mark = "before";
		else if (!still && drag?.index === order.length && i === order.length - 1) mark = "after";
		return {
			up: i > 0 ? () => reorder(movedTo(order, id, i - 1)) : null,
			down: i < order.length - 1 ? () => reorder(movedTo(order, id, i + 2)) : null,
			drag: mark,
		};
	};
	const directory = hub.directory();
	// Nothing to list yet (and every machine that can answer did): one empty state for the whole list.
	const settled = snapshot.status !== "loading" && machines.every((m) => m.conn.kind !== "on" || m.state.listed);
	const empty = filter === "all" && machines.length > 0 && settled && tree.projects.length === 0 && tree.loose.length === 0;
	// Machines that need the user ("Quản lý máy" counts them): blocked on this device, or a tunelo too old to talk to.
	const blocked = machines.filter((m) => isBlocked(m.conn)).length;
	const outdated = machines.filter((m) => m.conn.kind === "update").length;
	const hostNote = [blocked > 0 ? t.agent.hint.machinesBlocked(blocked) : "", outdated > 0 ? t.agent.hint.machinesOutdated(outdated) : ""].filter((x) => x !== "").join(" · ");
	return (
		<section className="mx-list" aria-label={t.agent.sessionsLabel}>
			<header className="mx-list-head">
				<h2>{t.agent.title}</h2>
				<Link to={aiPaths.manage} className="btn btn-sm mx-manage" title={hostNote === "" ? t.agent.machines : `${t.agent.machines}: ${hostNote}`} current={view.page === "machines" || view.page === "add"}>
					<MachineIcon name="monitor" small />
					<span>{t.agent.machines}</span>
					{hostNote !== "" && (
						<span className="mx-manage-count" role="img" aria-label={hostNote} data-id="machines-need-you">
							{blocked + outdated}
						</span>
					)}
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
				</button>
				{attention > 0 && (
					// The count turns the filter on (never off): it names what it shows.
					<button type="button" className="badge mx-attn-count" aria-label={t.agent.projects.showAttention(attention)} title={t.agent.projects.showAttention(attention)} onClick={() => setFilter("attention")}>
						{attention}
					</button>
				)}
				<AddProject machines={machines} compact />
			</div>
			<div className="mx-groups" ref={groups} onPointerDown={onPointerDown} data-dragging={drag !== null ? "" : undefined} aria-busy={directory.status === "loading" || snapshot.status === "loading"}>
				{snapshot.status === "loading" && machines.length > 0 && (
					<ul className="mx-rows skeleton" aria-hidden="true">
						<li />
						<li />
					</ul>
				)}
				{tree.projects.map((node) => {
					const open = isOpen(node.project.id, node.need, node.status, node.project.workspaces.length === 0);
					return <ProjectItem key={node.project.id} node={node} open={open} onToggle={() => toggle(node.project.id, open)} ctx={ctx} place={placeOf(node.project.id)} />;
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

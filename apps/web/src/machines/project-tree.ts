// The AI Agent column as data: projects (the server's), each with its
// workspaces (a folder on one machine) and the sessions the machine reports
// inside that folder (the workspace with the longest path prefix of a
// session's folder holds it); sessions in no workspace go to "Chưa phân
// loại", by folder. Machines appear only as a small label on a workspace,
// and only in a project spanning two machines or more.
//
// A workspace's state comes from its sessions: needs you > failed > running >
// done (finished since the user last opened it) > idle; "offline" (its
// machine is offline or removed) lies over the last state known, it does not
// replace it. Projects: in the user's order (a new one last), never moved by
// what their sessions do.
import { ThreadState, type Project, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { AgentWorkspaceKind, type AgentProject, type AgentWorkspace } from "./agent-projects-client.ts";
import { sortForList } from "./link/machine-link.ts";
import { inFolder, samePath } from "./projects-view.ts";
import { isRunning, type MachineView } from "./use-machines.ts";

/** "attention": only what needs the user or runs. */
export type Filter = "all" | "attention" | "archived";

/**
 * A session's (or a set's) state, most urgent first: needs the user, failed,
 * running (the AI works right now: a turn here, or busy elsewhere), done and
 * not seen, open (its AI waits at its prompt in a terminal: held, not
 * working), idle.
 */
export type WorkStatus = "need" | "failed" | "running" | "done" | "open" | "idle";

/** When the user last saw each session (its updatedAt then), by thread id. */
export type SeenMap = ReadonlyMap<string, number>;

type Matched = Pick<ThreadSummary, "state" | "archived"> & Partial<Pick<ThreadSummary, "busyElsewhere" | "terminalSession">>;

/** The session matches the filter: "all" leaves archived ones out, "archived" shows only them. */
/**
 * A machine's name short enough for a chip: no trailing ".local", no domain
 * ("Hoans-Mac-mini.local" → "Hoans-Mac-mini", "build.lab.example.com" →
 * "build"); an IP address or a name without dots stays as it is.
 */
export function shortHost(name: string): string {
	const trimmed = name.trim().replace(/\.local\.?$/i, "");
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed) || trimmed.includes(" ")) return trimmed;
	const first = trimmed.split(".")[0] ?? trimmed;
	return first === "" ? trimmed : first;
}

export function matches(filter: Filter, thread: Matched): boolean {
	if (filter === "attention") return thread.state === ThreadState.WAITING || isRunning(thread);
	if (filter === "archived") return thread.archived;
	return !thread.archived;
}

const updated = (thread: Pick<ThreadSummary, "updatedAt">): number => Number(thread.updatedAt);

/** Finished since the user last saw it (never true for a session this device has not seen yet). */
export function unseenDone(thread: ThreadSummary, seen: SeenMap): boolean {
	const at = seen.get(thread.id);
	return at !== undefined && updated(thread) > at && thread.state === ThreadState.IDLE && !thread.busyElsewhere && thread.terminalSession === 0;
}

const RANK: Record<WorkStatus, number> = { need: 0, failed: 1, running: 2, done: 3, open: 4, idle: 5 };

/** One session's state; `done`: it finished since the user last saw it (unseenDone). */
export function threadStatus(thread: ThreadSummary, done: boolean): WorkStatus {
	if (thread.state === ThreadState.WAITING) return "need";
	if (thread.state === ThreadState.ERROR) return "failed";
	// Working means a turn runs; a terminal holding the session at its prompt is not work.
	if (isRunning(thread)) return "running";
	if (done) return "done";
	return thread.terminalSession > 0 ? "open" : "idle";
}

/** The state of a set of sessions (archived ones never count). */
export function statusOf(threads: readonly ThreadSummary[], seen: SeenMap): WorkStatus {
	return worstStatus(threads.filter((x) => !x.archived).map((x) => threadStatus(x, unseenDone(x, seen))));
}

export function worstStatus(list: readonly WorkStatus[]): WorkStatus {
	return list.reduce<WorkStatus>((best, s) => (RANK[s] < RANK[best] ? s : best), "idle");
}

export interface WorkspaceNode {
	readonly workspace: AgentWorkspace;
	/** null: the machine was removed (machine_id 0) or is not in the directory. */
	readonly machine: MachineView | null;
	/** The machine's own entry for the folder (git branch, defaults), when it keeps it. */
	readonly local: Project | undefined;
	readonly branch: string;
	/** Sessions shown under the filter, most urgent and newest first. */
	readonly threads: ThreadSummary[];
	readonly status: WorkStatus;
	readonly offline: boolean;
	/** Unix ms of its newest session; 0 without one. */
	readonly activity: number;
}

export interface ProjectNode {
	readonly project: AgentProject;
	readonly workspaces: WorkspaceNode[];
	readonly status: WorkStatus;
	/** Sessions waiting for the user. */
	readonly need: number;
}

/** A folder holding sessions that no workspace records ("Chưa phân loại"). */
export interface LooseFolder {
	readonly machine: MachineView;
	readonly dir: string;
	readonly threads: ThreadSummary[];
	readonly status: WorkStatus;
}

export interface Tree {
	readonly projects: ProjectNode[];
	readonly loose: LooseFolder[];
}

/** The deepest workspace of `machineId` holding `dir`. */
function holder(workspaces: readonly AgentWorkspace[], machineId: number, dir: string): AgentWorkspace | undefined {
	let best: AgentWorkspace | undefined;
	for (const w of workspaces) {
		if (w.machineId === machineId && inFolder(dir, w.dir) && (best === undefined || w.dir.length > best.dir.length)) best = w;
	}
	return best;
}

export function buildTree(projects: readonly AgentProject[], machines: readonly MachineView[], filter: Filter, seen: SeenMap): Tree {
	const all = projects.flatMap((p) => p.workspaces);
	const byMachine = new Map(machines.map((m) => [m.entry.id, m]));
	// Every session of every machine, to its workspace or to its loose folder.
	const held = new Map<number, ThreadSummary[]>();
	const loose = new Map<string, { machine: MachineView; dir: string; threads: ThreadSummary[] }>();
	for (const machine of machines) {
		for (const thread of machine.state.threads) {
			const w = machine.entry.id > 0 ? holder(all, machine.entry.id, thread.dir) : undefined;
			if (w !== undefined) {
				const list = held.get(w.id);
				if (list === undefined) held.set(w.id, [thread]);
				else list.push(thread);
				continue;
			}
			const key = `${machine.entry.ref}\n${thread.dir}`;
			const group = loose.get(key);
			if (group === undefined) loose.set(key, { machine, dir: thread.dir, threads: [thread] });
			else group.threads.push(thread);
		}
	}
	const newest = (threads: readonly ThreadSummary[]) => threads.reduce((max, t) => Math.max(max, updated(t)), 0);
	const nodes = projects.map((project): ProjectNode => {
		const workspaces = project.workspaces
			.map((workspace): WorkspaceNode => {
				const machine = workspace.machineId > 0 ? (byMachine.get(workspace.machineId) ?? null) : null;
				const threads = held.get(workspace.id) ?? [];
				const local = machine?.state.projects?.projects.find((x) => samePath(x.dir, workspace.dir));
				const branch = local?.git?.git === true ? local.git.branch : workspace.branch;
				return {
					workspace,
					machine,
					local,
					branch,
					threads: sortForList(threads.filter((t) => matches(filter, t))),
					status: statusOf(threads, seen),
					offline: machine === null || machine.conn.kind !== "on",
					activity: newest(threads),
				};
			})
			.filter((w) => filter === "all" || w.threads.length > 0)
			.sort((a, b) => b.activity - a.activity || a.workspace.createdAt - b.workspace.createdAt);
		const everyThread = project.workspaces.flatMap((w) => held.get(w.id) ?? []);
		return {
			project,
			workspaces,
			status: worstStatus(workspaces.map((w) => w.status)),
			need: everyThread.filter((t) => !t.archived && t.state === ThreadState.WAITING).length,
		};
	});
	// In the user's order (dragged, or "Lên trên"/"Xuống dưới"): a project never jumps on its own.
	const shown = nodes.filter((n) => filter === "all" || n.workspaces.length > 0).sort((a, b) => a.project.order - b.project.order || a.project.id - b.project.id);
	const folders = [...loose.values()]
		.map((g) => ({ machine: g.machine, dir: g.dir, threads: sortForList(g.threads.filter((t) => matches(filter, t))), status: statusOf(g.threads, seen) }))
		.filter((g) => g.threads.length > 0)
		.sort((a, b) => newest(b.threads) - newest(a.threads));
	return { projects: shown, loose: folders };
}

/** The project and workspace holding a machine's session folder, if any. */
export function locate(projects: readonly AgentProject[], machineId: number, dir: string): { project: AgentProject; workspace: AgentWorkspace } | null {
	const w = holder(
		projects.flatMap((p) => p.workspaces),
		machineId,
		dir,
	);
	const project = w === undefined ? undefined : projects.find((p) => p.id === w.projectId);
	return w === undefined || project === undefined ? null : { project, workspace: w };
}

/** How a workspace row names itself. */
export interface WorkspaceLabel {
	/** The branch, else the folder (two workspaces on one branch, no branch); never just the project's name. */
	readonly title: string;
	readonly byBranch: boolean;
	/** The line under it: the folder when the title is the branch; "" otherwise. */
	readonly sub: string;
	/** The main checkout (not a git worktree), marked when the project has several workspaces. */
	readonly primary: boolean;
}

/** The last two parts of a path ("/Users/me/code/app" → "code/app"). */
function pathTail(dir: string): string {
	return dir.split(/[\\/]+/).filter((x) => x !== "").slice(-2).join("/") || dir;
}

const lastPart = (dir: string): string => dir.split(/[\\/]+/).filter((x) => x !== "").at(-1) ?? dir;

/**
 * A workspace's folder as its row says it: the path from the nearest other
 * workspace of the project on the same machine holding it ("backend/src"
 * under the clone's workspace), else the folder's own name.
 */
function shownFolder(w: AgentWorkspace, nodes: readonly Pick<WorkspaceNode, "workspace">[]): string {
	let outer: AgentWorkspace | undefined;
	for (const { workspace: o } of nodes) {
		if (o.id === w.id || o.machineId !== w.machineId || samePath(o.dir, w.dir) || !inFolder(w.dir, o.dir)) continue;
		if (outer === undefined || o.dir.length > outer.dir.length) outer = o;
	}
	if (outer === undefined) return lastPart(w.dir);
	const inner = w.dir.slice(outer.dir.replace(/[\\/]+$/, "").length).split(/[\\/]+/).filter((x) => x !== "");
	return inner.join("/") || lastPart(w.dir);
}

/**
 * Names for a project's workspace rows, as Orca does: the branch, with the
 * folder under it (unless it is the project's name); the folder when there is no branch or two workspaces
 * share it. A title equal to the project's name says more (the folder, or
 * the folder with its parent), since the project row above already says it.
 * The primary badge marks the main checkout: the oldest workspace that is
 * not a git worktree, only when the project has more than one.
 */
export function workspaceLabels(projectName: string, nodes: readonly Pick<WorkspaceNode, "workspace" | "branch">[]): Map<number, WorkspaceLabel> {
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const main = nodes
		.filter((n) => n.workspace.kind !== AgentWorkspaceKind.WORKTREE)
		.sort((a, b) => a.workspace.createdAt - b.workspace.createdAt || a.workspace.id - b.workspace.id)[0];
	const out = new Map<number, WorkspaceLabel>();
	for (const n of nodes) {
		const folder = shownFolder(n.workspace, nodes);
		const shared = n.branch !== "" && nodes.some((o) => o !== n && o.branch === n.branch);
		const byBranch = n.branch !== "" && !shared && !same(n.branch, projectName);
		const title = byBranch ? n.branch : same(folder, projectName) ? pathTail(n.workspace.dir) : folder;
		// The folder under the branch, unless it only says the project's name again.
		const sub = byBranch && !same(folder, projectName) ? folder : "";
		out.set(n.workspace.id, { title, byBranch, sub, primary: nodes.length > 1 && main === n });
	}
	return out;
}

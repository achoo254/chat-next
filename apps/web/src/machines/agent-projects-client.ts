// The AI Agent's projects on the chat server (AgentProjectsService): each
// user's projects, kept by the server and shared by all of the user's
// devices, with their workspaces (a folder on one of the user's machines).
// The server never sees a machine's folders (they go end to end to the
// machine), so this device adds what the machine reports; see project-sync.ts.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { AgentProjectsService, AgentWorkspaceKind, type AgentProject as WireProject, type AgentWorkspace as WireWorkspace } from "@achoo254/chat-proto/agent_projects";

export { AgentWorkspaceKind };

/** A workspace as the screens use it (ADR 0001: int64 arrive as bigint below 2^53, kept as number). */
export interface AgentWorkspace {
	readonly id: number;
	readonly projectId: number;
	/** 0 while the machine is removed. */
	readonly machineId: number;
	readonly dir: string;
	/** As recorded when attached; the machine reports the live branch. */
	readonly branch: string;
	readonly kind: AgentWorkspaceKind;
	/** Unix seconds. */
	readonly createdAt: number;
}

export interface AgentProject {
	readonly id: number;
	readonly name: string;
	/** The linked repository's key ("github.com/owner/repo"); "" for none. */
	readonly gitRemote: string;
	readonly order: number;
	/** Unix seconds. */
	readonly createdAt: number;
	readonly workspaces: AgentWorkspace[];
}

export function toWorkspace(w: WireWorkspace): AgentWorkspace {
	return { id: Number(w.id), projectId: Number(w.projectId), machineId: Number(w.machineId), dir: w.dir, branch: w.branch, kind: w.kind, createdAt: Number(w.createdAt) };
}

export function toProject(p: WireProject): AgentProject {
	return { id: Number(p.id), name: p.name, gitRemote: p.gitRemote, order: p.order, createdAt: Number(p.createdAt), workspaces: p.workspaces.map(toWorkspace) };
}

/** A folder to record as a workspace. */
export interface WorkspaceInput {
	readonly machineId: number;
	readonly dir: string;
	readonly branch: string;
	readonly kind: AgentWorkspaceKind;
}

/** A folder the user dropped while its machine could not be told (kept by the server). */
export interface DetachedFolder {
	readonly machineId: number;
	readonly dir: string;
}

export interface AgentProjectsApi {
	list(): Promise<AgentProject[]>;
	/** The projects and, in the same call, the folders marked as dropped. */
	listAll(): Promise<{ projects: AgentProject[]; detached: DetachedFolder[] }>;
	/** Marks (or unmarks) a folder of a machine as dropped while the machine could not be told. */
	setFolderDetached(machineId: number, dir: string, detached: boolean): Promise<void>;
	/** `gitRemote`: a URL (the server keeps its key), or "" for none. */
	create(name: string, gitRemote: string): Promise<AgentProject>;
	rename(projectId: number, name: string): Promise<AgentProject>;
	/** Links the repository of `gitRemote` (a URL; the server keeps its key) from now on; "" unlinks. */
	link(projectId: number, gitRemote: string): Promise<AgentProject>;
	remove(projectId: number): Promise<void>;
	/** Puts the projects in this order (those left out follow, in their order before). */
	reorder(projectIds: readonly number[]): Promise<void>;
	attach(projectId: number, workspace: WorkspaceInput): Promise<AgentWorkspace>;
	detach(workspaceId: number): Promise<void>;
	move(workspaceId: number, projectId: number): Promise<AgentWorkspace>;
}

/**
 * Why the server refused, as it names it at the start of its message
 * ("workspace_exists: …"); "" for anything else.
 */
export type ProjectsRefusal = "workspace_exists" | "project_remote_exists" | "too_many_projects" | "too_many_workspaces" | "not_found" | "invalid" | "";

export function refusalOf(err: unknown): ProjectsRefusal {
	const e = ConnectError.from(err);
	const reason = e.rawMessage.split(":")[0]?.trim() ?? "";
	if (e.code === Code.AlreadyExists) return reason === "project_remote_exists" ? "project_remote_exists" : "workspace_exists";
	if (e.code === Code.ResourceExhausted) return reason === "too_many_workspaces" ? "too_many_workspaces" : "too_many_projects";
	if (e.code === Code.NotFound) return "not_found";
	if (e.code === Code.InvalidArgument) return "invalid";
	return "";
}

function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`${what} returned nothing`);
	return value;
}

export function createAgentProjectsApi(transport: Transport): AgentProjectsApi {
	const client = createClient(AgentProjectsService, transport);
	return {
		list: async () => (await client.listAgentProjects({})).projects.map(toProject),
		listAll: async () => {
			const reply = await client.listAgentProjects({});
			return { projects: reply.projects.map(toProject), detached: reply.detachedFolders.map((f) => ({ machineId: Number(f.machineId), dir: f.dir })) };
		},
		setFolderDetached: async (machineId, dir, detached) => {
			await client.setAgentFolderDetached({ machineId: BigInt(machineId), dir, detached });
		},
		create: async (name, gitRemote) => toProject(must((await client.createAgentProject({ name, gitRemote })).project, "create")),
		rename: async (projectId, name) => toProject(must((await client.renameAgentProject({ projectId: BigInt(projectId), name })).project, "rename")),
		link: async (projectId, gitRemote) => toProject(must((await client.updateAgentProject({ projectId: BigInt(projectId), gitRemote })).project, "link")),
		remove: async (projectId) => {
			await client.deleteAgentProject({ projectId: BigInt(projectId) });
		},
		reorder: async (projectIds) => {
			await client.reorderAgentProjects({ projectIds: projectIds.map((id) => BigInt(id)) });
		},
		attach: async (projectId, w) =>
			toWorkspace(must((await client.attachAgentWorkspace({ projectId: BigInt(projectId), machineId: BigInt(w.machineId), dir: w.dir, branch: w.branch, kind: w.kind })).workspace, "attach")),
		detach: async (workspaceId) => {
			await client.detachAgentWorkspace({ workspaceId: BigInt(workspaceId) });
		},
		move: async (workspaceId, projectId) => toWorkspace(must((await client.moveAgentWorkspace({ workspaceId: BigInt(workspaceId), projectId: BigInt(projectId) })).workspace, "move")),
	};
}

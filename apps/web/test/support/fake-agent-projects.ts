// In-memory AgentProjectsService for tests and the visual harness, with the
// server's rules that matter to the devices: one workspace per (machine,
// folder) ("workspace_exists"), one project per repository key
// ("project_remote_exists"), the key never the URL as typed, a removed
// machine's workspaces listed with machine 0. Every call yields once before
// it decides, so concurrent callers interleave as two devices would. Never
// imported by production code.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { AgentProjectSchema, AgentProjectsService, AgentWorkspaceSchema, type AgentProject as WireProject } from "@achoo254/chat-proto/agent_projects";
import { toProject, toWorkspace, type AgentProject, type AgentProjectsApi, type WorkspaceInput } from "../../src/machines/agent-projects-client.ts";
import { canonicalRemote } from "../../src/machines/git-remote.ts";

interface Row {
	id: number;
	name: string;
	gitRemote: string;
	order: number;
	createdAt: number;
}

interface WsRow extends WorkspaceInput {
	id: number;
	projectId: number;
	createdAt: number;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FakeAgentProjects {
	projects: Row[] = [];
	workspaces: WsRow[] = [];
	/** Every change, in order ("create:app", "attach:1:/w/app", …). */
	readonly log: string[] = [];
	private next = 1;

	/** `liveMachine(id)`: the machine is in the directory (else its workspaces list as machine 0). */
	constructor(private readonly liveMachine: (id: number) => boolean = () => true) {}

	private wire(p: Row): WireProject {
		return create(AgentProjectSchema, {
			id: BigInt(p.id),
			name: p.name,
			gitRemote: p.gitRemote,
			order: p.order,
			createdAt: BigInt(p.createdAt),
			workspaces: this.workspaces
				.filter((w) => w.projectId === p.id)
				.map((w) => create(AgentWorkspaceSchema, { id: BigInt(w.id), projectId: BigInt(w.projectId), machineId: BigInt(this.liveMachine(w.machineId) ? w.machineId : 0), dir: w.dir, branch: w.branch, kind: w.kind, createdAt: BigInt(w.createdAt) })),
		});
	}

	private project(id: number): Row {
		const p = this.projects.find((x) => x.id === id);
		if (p === undefined) throw new ConnectError("project_not_found: no such project", Code.NotFound);
		return p;
	}

	/** Adds a project directly (test setup). */
	seed(name: string, gitRemote = "", workspaces: readonly WorkspaceInput[] = []): AgentProject {
		const p: Row = { id: this.next++, name, gitRemote: canonicalRemote(gitRemote) ?? "", order: this.projects.length, createdAt: 1_700_000_000 };
		this.projects.push(p);
		for (const w of workspaces) this.workspaces.push({ ...w, id: this.next++, projectId: p.id, createdAt: p.createdAt });
		return toProject(this.wire(p));
	}

	list(): WireProject[] {
		return [...this.projects].sort((a, b) => a.order - b.order || a.id - b.id).map((p) => this.wire(p));
	}

	async createProject(name: string, gitRemote: string): Promise<WireProject> {
		await tick();
		const trimmed = name.trim();
		if (trimmed === "" || [...trimmed].length > 64) throw new ConnectError("invalid name", Code.InvalidArgument);
		const key = gitRemote === "" ? "" : canonicalRemote(gitRemote);
		if (key === null) throw new ConnectError("invalid git_remote", Code.InvalidArgument);
		if (key !== "" && this.projects.some((p) => p.gitRemote === key)) throw new ConnectError("project_remote_exists: a project links this repository already", Code.AlreadyExists);
		const p: Row = { id: this.next++, name: trimmed, gitRemote: key, order: this.projects.length, createdAt: Math.floor(Date.now() / 1000) };
		this.projects.push(p);
		this.log.push(`create:${trimmed}`);
		return this.wire(p);
	}

	async attach(projectId: number, w: WorkspaceInput): Promise<WsRow> {
		await tick();
		this.project(projectId);
		if (!this.liveMachine(w.machineId)) throw new ConnectError("machine_not_found: no such machine", Code.NotFound);
		if (this.workspaces.some((x) => x.machineId === w.machineId && x.dir === w.dir)) throw new ConnectError("workspace_exists: the folder of this machine is a workspace already", Code.AlreadyExists);
		const row: WsRow = { ...w, id: this.next++, projectId, createdAt: Math.floor(Date.now() / 1000) };
		this.workspaces.push(row);
		this.log.push(`attach:${projectId}:${w.dir}`);
		return row;
	}

	private ws(id: number): WsRow {
		const w = this.workspaces.find((x) => x.id === id);
		if (w === undefined) throw new ConnectError("workspace_not_found: no such workspace", Code.NotFound);
		return w;
	}

	private wireWs(w: WsRow) {
		return create(AgentWorkspaceSchema, { id: BigInt(w.id), projectId: BigInt(w.projectId), machineId: BigInt(w.machineId), dir: w.dir, branch: w.branch, kind: w.kind, createdAt: BigInt(w.createdAt) });
	}

	async rename(projectId: number, name: string): Promise<WireProject> {
		await tick();
		const p = this.project(projectId);
		p.name = name.trim();
		this.log.push(`rename:${projectId}:${p.name}`);
		return this.wire(p);
	}

	async remove(projectId: number): Promise<void> {
		await tick();
		this.project(projectId);
		this.projects = this.projects.filter((p) => p.id !== projectId);
		this.workspaces = this.workspaces.filter((w) => w.projectId !== projectId);
		this.log.push(`delete:${projectId}`);
	}

	async detach(workspaceId: number): Promise<void> {
		await tick();
		this.ws(workspaceId);
		this.workspaces = this.workspaces.filter((w) => w.id !== workspaceId);
		this.log.push(`detach:${workspaceId}`);
	}

	async move(workspaceId: number, projectId: number): Promise<WsRow> {
		await tick();
		const w = this.ws(workspaceId);
		this.project(projectId);
		w.projectId = projectId;
		this.log.push(`move:${workspaceId}:${projectId}`);
		return w;
	}

	/** The API a device uses, straight to this fake (no transport). */
	api(): AgentProjectsApi {
		return {
			list: async () => {
				await tick();
				return this.list().map(toProject);
			},
			create: async (name, remote) => toProject(await this.createProject(name, remote)),
			rename: async (id, name) => toProject(await this.rename(id, name)),
			remove: (id) => this.remove(id),
			attach: async (id, w) => toWorkspace(this.wireWs(await this.attach(id, w))),
			detach: (id) => this.detach(id),
			move: async (id, projectId) => toWorkspace(this.wireWs(await this.move(id, projectId))),
		};
	}

	routes(router: ConnectRouter): void {
		router.service(AgentProjectsService, {
			listAgentProjects: () => ({ projects: this.list() }),
			createAgentProject: async (req) => ({ project: await this.createProject(req.name, req.gitRemote) }),
			renameAgentProject: async (req) => ({ project: await this.rename(Number(req.projectId), req.name) }),
			deleteAgentProject: async (req) => {
				await this.remove(Number(req.projectId));
				return {};
			},
			attachAgentWorkspace: async (req) => ({
				workspace: this.wireWs(await this.attach(Number(req.projectId), { machineId: Number(req.machineId), dir: req.dir, branch: req.branch, kind: req.kind })),
			}),
			detachAgentWorkspace: async (req) => {
				await this.detach(Number(req.workspaceId));
				return {};
			},
			moveAgentWorkspace: async (req) => ({ workspace: this.wireWs(await this.move(Number(req.workspaceId), Number(req.projectId))) }),
		});
	}
}

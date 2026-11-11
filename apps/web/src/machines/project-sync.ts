// Folders of the user's machines into the server's projects. The server
// cannot see a machine's folders (they travel end to end to the machine), so
// a signed-in device does it: the folders a machine keeps as projects become
// workspaces the first time a device sees them (merged by git repository,
// else a project of their own, named after the repository or the folder);
// so does the folder of a session started from the app. Sessions found
// running outside the app create nothing: they wait under "Chưa phân loại".
//
// Every step is idempotent and safe with several devices at once: the
// server's unique keys decide. A folder another device recorded first
// ("workspace_exists") or a repository another device linked first
// ("project_remote_exists") is success, and a project this device made for
// nothing in such a race is deleted again while it is still empty.
import { AgentWorkspaceKind, refusalOf, type AgentProject, type AgentProjectsApi, type AgentWorkspace } from "./agent-projects-client.ts";
import { canonicalRemote, remoteUrlFor, repoName } from "./git-remote.ts";
import { samePath } from "./projects-view.ts";
import { folderName } from "./new-session-hints.ts";

/** A folder of one machine, as the machine reported it. */
export interface FolderInfo {
	readonly machineId: number;
	readonly dir: string;
	/** remote.origin.url as the machine reports it; "" outside git or when not reported. */
	readonly remote: string;
	readonly branch: string;
	/** In a git work tree (the machine said so), whether or not it has a remote. */
	readonly git: boolean;
	/** The name a new project takes: "" for the repository's (else the folder's). */
	readonly name: string;
}

export interface Placement {
	readonly projectId: number;
	readonly workspaceId: number;
}

const MAX_NAME = 64;

/** The name of a project made for `folder`: as given, else its repository's, else the folder's; at most 64 characters. */
export function projectNameFor(folder: Pick<FolderInfo, "name" | "remote" | "dir">): string {
	const key = canonicalRemote(folder.remote);
	const name = folder.name.trim() || (key !== null ? repoName(key) : folderName(folder.dir));
	return [...name].slice(0, MAX_NAME).join("") || "Project";
}

export function workspaceKind(folder: Pick<FolderInfo, "git" | "remote">): AgentWorkspaceKind {
	return folder.git || folder.remote !== "" ? AgentWorkspaceKind.CLONE : AgentWorkspaceKind.FOLDER;
}

/** The workspace recording `dir` of machine `machineId`, if any. */
export function findWorkspace(projects: readonly AgentProject[], machineId: number, dir: string): AgentWorkspace | undefined {
	for (const project of projects) {
		const found = project.workspaces.find((w) => w.machineId === machineId && samePath(w.dir, dir));
		if (found !== undefined) return found;
	}
	return undefined;
}


/**
 * Records `folder` as a workspace: of `target` when given (moving it there
 * if it is a workspace of another project already), else of the project
 * linking its repository, else of a new project. `known`: the server's list
 * as this device last read it; it is updated in place.
 */
export async function placeFolder(api: AgentProjectsApi, known: AgentProject[], folder: FolderInfo, target?: number): Promise<Placement> {
	const existing = findWorkspace(known, folder.machineId, folder.dir);
	if (existing !== undefined) return settle(api, existing, target);
	let projectId = target;
	let created = false;
	if (projectId === undefined) {
		const key = canonicalRemote(folder.remote);
		const linked = key === null ? undefined : known.find((p) => p.gitRemote === key);
		if (linked !== undefined) projectId = linked.id;
		else {
			try {
				const project = await api.create(projectNameFor(folder), key === null ? "" : remoteUrlFor(key, folder.remote));
				known.push(project);
				projectId = project.id;
				created = true;
			} catch (err) {
				// Another device linked the repository a moment ago: join its project.
				if (refusalOf(err) !== "project_remote_exists") throw err;
				const fresh = await relist(api, known);
				const found = fresh.find((p) => p.gitRemote === key);
				if (found === undefined) throw err;
				projectId = found.id;
			}
		}
	}
	try {
		const workspace = await api.attach(projectId, { machineId: folder.machineId, dir: folder.dir, branch: folder.branch, kind: workspaceKind(folder) });
		known.find((p) => p.id === projectId)?.workspaces.push(workspace);
		return { projectId, workspaceId: workspace.id };
	} catch (err) {
		// Another device recorded the folder a moment ago: that counts.
		if (refusalOf(err) !== "workspace_exists") throw err;
		const fresh = await relist(api, known);
		const recorded = findWorkspace(fresh, folder.machineId, folder.dir);
		if (recorded === undefined) throw err;
		if (created && recorded.projectId !== projectId && (fresh.find((p) => p.id === projectId)?.workspaces.length ?? 0) === 0) {
			await api.remove(projectId).catch(() => undefined);
			await relist(api, known);
		}
		return settle(api, recorded, target);
	}
}

/** `workspace` exists: moved to `target` when that is another project. */
async function settle(api: AgentProjectsApi, workspace: AgentWorkspace, target: number | undefined): Promise<Placement> {
	if (target === undefined || workspace.projectId === target) return { projectId: workspace.projectId, workspaceId: workspace.id };
	const moved = await api.move(workspace.id, target);
	return { projectId: moved.projectId, workspaceId: moved.id };
}

/** The server's list again, into `known`. */
async function relist(api: AgentProjectsApi, known: AgentProject[]): Promise<AgentProject[]> {
	const fresh = await api.list();
	known.splice(0, known.length, ...fresh);
	return known;
}

export interface SyncResult {
	/** Folders recorded by this pass. */
	readonly placed: number;
	/** Folders that failed, with the error (tried again on the next pass). */
	readonly failed: readonly { dir: string; error: unknown }[];
}

/**
 * One pass for one machine: every folder it keeps that no workspace records
 * yet becomes one (skipping those `skip` names: ones the user is placing by
 * hand right now, or detached on this device). `known` is updated in place.
 */
export async function syncFolders(api: AgentProjectsApi, known: AgentProject[], folders: readonly FolderInfo[], skip: (folder: FolderInfo) => boolean): Promise<SyncResult> {
	let placed = 0;
	const failed: { dir: string; error: unknown }[] = [];
	for (const folder of folders) {
		if (skip(folder) || findWorkspace(known, folder.machineId, folder.dir) !== undefined) continue;
		try {
			await placeFolder(api, known, folder);
			placed += 1;
		} catch (error) {
			failed.push({ dir: folder.dir, error });
		}
	}
	return { placed, failed };
}

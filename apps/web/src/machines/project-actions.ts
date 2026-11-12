// What the AI Agent column does with projects, between the server's list
// (agent-projects-store.ts) and the machines: placing a folder (asking the
// machine for its git remote first, so a repository merges into its
// project), detaching a workspace or deleting a project (the machine drops
// the folder from its list too; files and sessions stay), adopting the folder
// of a session started from the app, and the background sync of the folders
// every machine keeps (project-sync.ts).
import { useEffect, useRef } from "react";
import { ErrorCode, ErrorReason, type Project } from "@achoo254/chat-proto/remote/remote";
import type { AgentProject, AgentWorkspace } from "./agent-projects-client.ts";
import type { AgentProjectsStore, ProjectsSnapshot } from "./agent-projects-store.ts";
import { canonicalRemote, remoteMismatch, remoteUrlFor } from "./git-remote.ts";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { findWorkspace, placeFolder, projectForRemote, projectNameFor, remoteKey, repairWorkspaces, syncFolders, type FolderInfo, type KnownRemote, type Placement } from "./project-sync.ts";
import { locate } from "./project-tree.ts";
import { projectsSupported, samePath } from "./projects-view.ts";

/** A machine as these actions need it. */
export interface Host {
	readonly id: number;
	readonly link: Pick<MachineLink, "request">;
	readonly state: Pick<LinkState, "projects" | "info">;
}

/** Waits after the last change before a sync pass, so one burst of updates makes one pass. */
export const SYNC_DELAY_MS = 400;

function folderOf(host: Host, project: Project, name = ""): FolderInfo {
	return { machineId: host.id, dir: project.dir, remote: project.gitRemote, branch: project.git?.git === true ? project.git.branch : "", git: project.git?.git === true, name };
}

/** What the machine already reports about `dir`: its own project there, else a session folder suggestion. */
export function knownFolder(host: Host, dir: string, name = ""): FolderInfo {
	const own = host.state.projects?.projects.find((p) => samePath(p.dir, dir));
	if (own !== undefined) return folderOf(host, own, name);
	const hint = host.state.projects?.suggestions.find((s) => samePath(s.dir, dir));
	return { machineId: host.id, dir, remote: hint?.gitRemote ?? "", branch: hint?.branch ?? "", git: (hint?.branch ?? "") !== "" || (hint?.gitRemote ?? "") !== "", name };
}

/**
 * `dir` as the machine's own project (added now when it is not one yet,
 * which needs `sensitive` for a sensitive folder: the machine refuses with
 * NEEDS_CONSENT otherwise), with the git remote it reports. Machines before
 * tunelo 2.0.7 keep no projects: what is known about the folder then.
 */
export async function machineFolder(host: Host, dir: string, sensitive: boolean, name = ""): Promise<{ folder: FolderInfo; added: boolean }> {
	if (!projectsSupported(host.state.info?.agentVersion)) return { folder: knownFolder(host, dir, name), added: false };
	const own = host.state.projects?.projects.find((p) => samePath(p.dir, dir));
	if (own !== undefined) return { folder: folderOf(host, own, name), added: false };
	let result;
	try {
		const frame = await host.link.request({ case: "projectAdd", value: { dir, name: "", consent: { sensitive, projectSettings: false } } });
		result = frame.body.case === "projectListResult" ? frame.body.value : undefined;
	} catch (err) {
		if (!(err instanceof RemoteError && err.reason === ErrorReason.PROJECT_EXISTS)) throw err;
		const frame = await host.link.request({ case: "projectList", value: {} });
		result = frame.body.case === "projectListResult" ? frame.body.value : undefined;
	}
	// The machine may name the folder in its own form (a resolved path): match it loosely, else keep ours.
	const added = result?.projects.find((p) => samePath(p.dir, dir));
	return { folder: added === undefined ? knownFolder(host, dir, name) : folderOf(host, added, name), added: added !== undefined };
}

/** The folder's repository differs from the one `project` links. */
export class RemoteMismatchError extends Error {
	constructor() {
		super("the folder belongs to another repository");
	}
}

export function isNeedsConsent(err: unknown): boolean {
	return err instanceof RemoteError && err.code === ErrorCode.NEEDS_CONSENT;
}

/**
 * Places `dir` of `host` by hand: into `target` (refused with
 * RemoteMismatchError when the folder's repository is another one), else
 * into the project linking its repository or a new one named `name` (else
 * after the repository or folder). The sync leaves the folder alone meanwhile.
 */
export function placeByHand(store: AgentProjectsStore, host: Host, dir: string, options: { target?: AgentProject; name?: string; sensitive?: boolean }): Promise<Placement> {
	return store.claim({ machineId: host.id, dir }, async () => {
		const known = store.snapshot().projects;
		const remote = options.target?.gitRemote ?? "";
		// What the machine reported already: a mismatch is refused before the machine is asked anything.
		if (remoteMismatch(remote, knownFolder(host, dir).remote)) throw new RemoteMismatchError();
		const { folder, added } = await machineFolder(host, dir, options.sensitive ?? false, options.name ?? "");
		if (options.target !== undefined && remoteMismatch(remote, folder.remote)) {
			if (added) await forget(host, folder.dir).catch(() => undefined);
			throw new RemoteMismatchError();
		}
		store.setDetached({ machineId: host.id, dir: folder.dir }, false);
		return store.change((api) => placeFolder(api, [...known], folder, options.target?.id));
	});
}

/** The machine drops `dir` from its own list (the folder and its sessions stay). */
async function forget(host: Host, dir: string): Promise<void> {
	const own = host.state.projects?.projects.find((p) => samePath(p.dir, dir));
	if (own !== undefined) await host.link.request({ case: "projectRemove", value: { id: own.id } });
}

/**
 * After a workspace left the app: its machine drops the folder too, now when
 * it is online, else when it is back (remembered on this device), so the
 * sync does not record it again. `host` null: the machine is offline or gone.
 */
async function release(store: AgentProjectsStore, workspace: AgentWorkspace, host: Host | null): Promise<void> {
	const key = { machineId: workspace.machineId, dir: workspace.dir };
	if (workspace.machineId === 0) return;
	if (host === null) return store.setDetached(key, true);
	try {
		await forget(host, workspace.dir);
	} catch {
		store.setDetached(key, true);
	}
}

export async function detachWorkspace(store: AgentProjectsStore, workspace: AgentWorkspace, host: Host | null): Promise<void> {
	await store.change((api) => api.detach(workspace.id));
	await release(store, workspace, host);
}

/** Deletes the project's record and its workspaces' (never a file or a session). */
export async function deleteProject(store: AgentProjectsStore, project: AgentProject, hostOf: (machineId: number) => Host | null): Promise<void> {
	await store.change((api) => api.remove(project.id));
	await Promise.all(project.workspaces.map((w) => release(store, w, hostOf(w.machineId))));
}

/**
 * A session started from the app in a folder no workspace holds: the folder
 * becomes a workspace of the project linking its repository, else of a new
 * project named after the repository or the folder. A sensitive folder (the
 * home folder, …) is left alone: its sessions wait under "Chưa phân loại".
 */
export async function adoptStarted(store: AgentProjectsStore, host: Host, dir: string): Promise<void> {
	if (host.id <= 0 || store.snapshot().status !== "ready") return;
	if (locate(store.snapshot().projects, host.id, dir) !== null) return;
	try {
		await placeByHand(store, host, dir, {});
	} catch (err) {
		if (!isNeedsConsent(err)) console.warn("ai: could not make a project of the session's folder", err);
	}
}

/** One machine for the sync: online, in the directory, keeping projects, its list known. */
export interface SyncHost extends Host {
	readonly ready: boolean;
}

/** One pass over `hosts`: folders they keep that no workspace records become workspaces. */
export async function syncHosts(store: AgentProjectsStore, hosts: readonly SyncHost[]): Promise<number> {
	const snapshot = store.snapshot();
	if (snapshot.status !== "ready") return 0;
	const known = [...snapshot.projects];
	let placed = 0;
	for (const host of hosts) {
		if (!host.ready || host.id <= 0) continue;
		const own = (host.state.projects?.projects ?? []).filter((p) => !p.missing);
		const dropped = new Set<string>();
		// Detached here while the machine was offline: it drops the folder now.
		for (const p of own) {
			const key = { machineId: host.id, dir: p.dir };
			if (!store.isDetached(key)) continue;
			// Placed again since (on another device): it stays.
			if (findWorkspace(known, host.id, p.dir) !== undefined) {
				store.setDetached(key, false);
				continue;
			}
			dropped.add(p.id);
			await host.link.request({ case: "projectRemove", value: { id: p.id } }).then(
				() => store.setDetached(key, false),
				(err: unknown) => console.warn("ai: the machine did not drop a detached folder", err),
			);
		}
		const result = await syncFolders(
			store.api,
			known,
			own.filter((p) => !dropped.has(p.id)).map((p) => folderOf(host, p)),
			(f) => store.claimed(f) || store.isDetached(f),
		);
		placed += result.placed;
		for (const f of result.failed) console.warn(`ai: could not record ${f.dir} as a workspace`, f.error);
	}
	// A workspace in a project that links another repository goes to its own repository's project (projects linking none are left alone).
	const moved = await repairWorkspaces(store.api, known, knownRemotes(known, hosts)).catch((err: unknown) => {
		console.warn("ai: could not move a workspace to its repository's project", err);
		return 0;
	});
	if (placed + moved > 0) await store.refresh();
	return placed + moved;
}

/** The repository each workspace's machine (online, keeping projects) reports for its folder now; unknown ones are left out. */
export function knownRemotes(projects: readonly AgentProject[], hosts: readonly SyncHost[]): KnownRemote[] {
	const out: KnownRemote[] = [];
	for (const workspace of projects.flatMap((p) => p.workspaces)) {
		const host = hosts.find((h) => h.ready && h.id > 0 && h.id === workspace.machineId);
		const own = host?.state.projects?.projects.find((p) => samePath(p.dir, workspace.dir));
		const key = own === undefined ? null : remoteKey(own.gitRemote);
		if (key !== null) out.push({ workspace, key });
	}
	return out;
}

/** The remote the machine reports for a workspace's folder (or "" when it reports none). */
export function workspaceRemote(host: Host | null, dir: string): string {
	return host?.state.projects?.projects.find((p) => samePath(p.dir, dir))?.gitRemote ?? "";
}

/**
 * "Tách thành dự án riêng": the workspace into a project of its own, the
 * one linking its repository when its machine reports one (made if none),
 * else a new project named after its folder. Only a move: nothing is removed.
 */
export async function splitWorkspace(store: AgentProjectsStore, workspace: AgentWorkspace, remote: string): Promise<void> {
	await store.change(async (api) => {
		const known = [...store.snapshot().projects];
		const key = remoteKey(remote);
		const home = known.find((p) => p.id === workspace.projectId);
		// The project already links that repository (one project per repository): a project of its own without the link.
		const target =
			key !== null && home?.gitRemote !== key
				? (await projectForRemote(api, known, key, remote, projectNameFor({ name: "", remote, dir: workspace.dir }))).id
				: (await api.create(projectNameFor({ name: "", remote: "", dir: workspace.dir }), "")).id;
		if (target !== workspace.projectId) await api.move(workspace.id, target);
	});
}

/** Links `project` to the repository of `url` ("" unlinks); the next sync pass moves the workspaces of that repository into it. */
export async function linkRepository(store: AgentProjectsStore, project: AgentProject, url: string): Promise<void> {
	const key = url.trim() === "" ? "" : canonicalRemote(url);
	if (key === null) throw new InvalidRemoteError();
	await store.change((api) => api.link(project.id, key === "" ? "" : remoteUrlFor(key, url)));
}

export class InvalidRemoteError extends Error {
	constructor() {
		super("the address names no git repository");
	}
}

const running = new WeakSet<AgentProjectsStore>();
const again = new WeakSet<AgentProjectsStore>();

/** A pass now, or right after the one running (with the machines as they are then). */
function pass(store: AgentProjectsStore, hosts: () => readonly SyncHost[]): void {
	if (running.has(store)) {
		again.add(store);
		return;
	}
	running.add(store);
	syncHosts(store, hosts())
		.catch((err: unknown) => console.warn("ai: project sync failed", err))
		.finally(() => {
			running.delete(store);
			if (again.delete(store)) pass(store, hosts);
		});
}

/**
 * Keeps the server's projects in step with the folders of the machines
 * online (see project-sync.ts): a pass after the lists settle, one at a time.
 */
export function useProjectSync(store: AgentProjectsStore, snapshot: ProjectsSnapshot, hosts: readonly SyncHost[]): void {
	const latest = useRef(hosts);
	useEffect(() => {
		latest.current = hosts;
	});
	const signature = hosts
		.filter((h) => h.ready && h.id > 0)
		.map((h) => `${h.id}:${(h.state.projects?.projects ?? []).map((p) => `${p.dir}=${p.gitRemote}`).join("|")}`)
		.join(",");
	useEffect(() => {
		if (snapshot.status !== "ready" || signature === "") return;
		const timer = window.setTimeout(() => pass(store, () => latest.current), SYNC_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [store, snapshot, signature]);
}

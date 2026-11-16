// What the AI Agent column does with projects, between the server's list
// (agent-projects-store.ts) and the machines: placing a folder (asking the
// machine for its git remote first, so a repository merges into its
// project), detaching a workspace or deleting a project (the machine drops
// the folder from its list too; files and sessions stay), adopting the folder
// of a session started from the app, and the background sync pass, which
// never records a folder (syncHosts).
import { useEffect, useRef } from "react";
import { ErrorCode, ErrorReason, type Project, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import type { AgentProject, AgentWorkspace } from "./agent-projects-client.ts";
import type { AgentProjectsStore, ProjectsSnapshot } from "./agent-projects-store.ts";
import { canonicalRemote, remoteMismatch, remoteUrlFor } from "./git-remote.ts";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { findWorkspace, placeFolder, projectForRemote, projectNameFor, remoteKey, repairWorkspaces, type FolderInfo, type KnownRemote, type Placement } from "./project-sync.ts";
import { locate } from "./project-tree.ts";
import { inFolder, projectsSupported, samePath } from "./projects-view.ts";

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
 * after the repository or folder).
 */
export async function placeByHand(store: AgentProjectsStore, host: Host, dir: string, options: { target?: AgentProject; name?: string; sensitive?: boolean }): Promise<Placement> {
	const known = store.snapshot().projects;
	const remote = options.target?.gitRemote ?? "";
	// What the machine reported already: a mismatch is refused before the machine is asked anything.
	if (remoteMismatch(remote, knownFolder(host, dir).remote)) throw new RemoteMismatchError();
	const { folder, added } = await machineFolder(host, dir, options.sensitive ?? false, options.name ?? "");
	if (options.target !== undefined && remoteMismatch(remote, folder.remote)) {
		if (added) await forget(host, folder.dir).catch(() => undefined);
		throw new RemoteMismatchError();
	}
	await store.setDetached({ machineId: host.id, dir: folder.dir }, false);
	return store.change((api) => placeFolder(api, [...known], folder, options.target?.id));
}

/**
 * The machine drops `dir` from its own list (the folder and its sessions
 * stay). The list is asked again, not read from this device's copy: a copy
 * that is old or not loaded yet would show no such folder, nothing would be
 * dropped, and a device still on an older build (which recorded every folder
 * a machine keeps) would add the workspace again right after it left.
 * Throws when the machine does not answer, so the caller remembers to retry.
 */
async function forget(host: Host, dir: string): Promise<void> {
	const frame = await host.link.request({ case: "projectList", value: {} });
	if (frame.body.case !== "projectListResult") throw new Error("the machine did not list its projects");
	const own = frame.body.value.projects.find((p) => samePath(p.dir, dir));
	if (own !== undefined) await host.link.request({ case: "projectRemove", value: { id: own.id } });
}

/**
 * Before a workspace leaves the app: its machine drops the folder too, now
 * when it is online, else when it is back (marked on the server, see
 * syncHosts). `host` null: the machine is offline or gone. The machine goes
 * first: until its list no longer holds the folder, a device still on an
 * older build (which recorded every folder a machine keeps) would add it again.
 */
async function release(store: AgentProjectsStore, workspace: AgentWorkspace, host: Host | null): Promise<void> {
	const key = { machineId: workspace.machineId, dir: workspace.dir };
	if (workspace.machineId === 0) return;
	if (host === null) return store.setDetached(key, true);
	try {
		await forget(host, workspace.dir);
	} catch {
		await store.setDetached(key, true);
	}
}

/** Workspaces leaving the app on this device: their machine dropped the folder, the server still records them for a moment. */
const leaving = new WeakMap<AgentProjectsStore, Set<number>>();

/** Runs `remove` with `workspaces` marked as leaving, so a sync pass meanwhile does not have their machine keep the folder again. */
async function whileLeaving(store: AgentProjectsStore, workspaces: readonly AgentWorkspace[], remove: () => Promise<void>): Promise<void> {
	let ids = leaving.get(store);
	if (ids === undefined) {
		ids = new Set();
		leaving.set(store, ids);
	}
	for (const w of workspaces) ids.add(w.id);
	try {
		await remove();
	} finally {
		for (const w of workspaces) ids.delete(w.id);
	}
}

export async function detachWorkspace(store: AgentProjectsStore, workspace: AgentWorkspace, host: Host | null): Promise<void> {
	await whileLeaving(store, [workspace], async () => {
		await release(store, workspace, host);
		await store.change((api) => api.detach(workspace.id));
	});
}

/** Deletes the project's record and its workspaces' (never a file or a session). */
export async function deleteProject(store: AgentProjectsStore, project: AgentProject, hostOf: (machineId: number) => Host | null): Promise<void> {
	await whileLeaving(store, project.workspaces, async () => {
		await Promise.all(project.workspaces.map((w) => release(store, w, hostOf(w.machineId))));
		await store.change((api) => api.remove(project.id));
	});
}

/**
 * A session started from the app in a folder no workspace holds: the git
 * work tree holding the folder (the folder itself outside git, or from
 * machines that do not report it) becomes a workspace of the project linking
 * its repository, else of a new project named after the repository or the
 * folder. A session in a folder inside a clone so lands in the clone's
 * workspace, never in one of its own. A sensitive work tree (a home folder
 * kept in git, …) gives way to the folder; a sensitive folder is left
 * alone: its sessions wait under "Chưa phân loại".
 */
export async function adoptStarted(store: AgentProjectsStore, host: Host, thread: Pick<ThreadSummary, "dir" | "gitRoot">): Promise<void> {
	if (host.id <= 0 || store.snapshot().status !== "ready") return;
	const { dir } = thread;
	if (locate(store.snapshot().projects, host.id, dir) !== null) return;
	const root = adoptedFolder(thread);
	try {
		await placeByHand(store, host, root, {});
		return;
	} catch (err) {
		if (!isNeedsConsent(err)) return console.warn("ai: could not make a project of the session's folder", err);
		if (root === dir) return;
	}
	try {
		await placeByHand(store, host, dir, {});
	} catch (err) {
		if (!isNeedsConsent(err)) console.warn("ai: could not make a project of the session's folder", err);
	}
}

/** The folder a started session's workspace records: its git work tree when the machine reports one holding it, else its own. */
export function adoptedFolder(thread: Pick<ThreadSummary, "dir" | "gitRoot">): string {
	return thread.gitRoot !== "" && inFolder(thread.dir, thread.gitRoot) ? thread.gitRoot : thread.dir;
}

/** One machine for the sync: online, in the directory, keeping projects, its list known. */
export interface SyncHost extends Host {
	readonly ready: boolean;
}

/**
 * The projects the machine keeps right now, asked again: the list this device
 * holds can be older than the machine's (a device that was away, or whose
 * link was cut, while another removed a folder). Recording a folder from an
 * old list would bring back a project just deleted. undefined when the
 * machine does not answer: the pass leaves it for the next one.
 */
async function currentProjects(host: Host): Promise<readonly Project[] | undefined> {
	try {
		const frame = await host.link.request({ case: "projectList", value: {} });
		return frame.body.case === "projectListResult" ? frame.body.value.projects : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A workspace of `host` the machine does not keep (recorded by an older build
 * from a list the machine has since lost, or dropped on the machine alone):
 * the machine keeps its folder again, since its files and git open only
 * through the machine's own project. Not a folder detached and waiting to be
 * dropped, nor a workspace leaving right now, nor one the machine keeps as a
 * folder that went missing.
 * A sensitive folder waits for the user (Thêm workspace asks); a folder no
 * longer on the disk stays as it is.
 */
async function keepWorkspaces(store: AgentProjectsStore, host: Host, known: readonly AgentProject[], listed: readonly Project[]): Promise<void> {
	const workspaces = known.flatMap((p) => p.workspaces).filter((w) => w.machineId === host.id);
	for (const workspace of workspaces) {
		if (listed.some((p) => inFolder(workspace.dir, p.dir))) continue;
		if (store.isDetached({ machineId: host.id, dir: workspace.dir }) || leaving.get(store)?.has(workspace.id) === true) continue;
		// Gone from the server since the pass began (detached on this device meanwhile).
		if (findWorkspace(store.snapshot().projects, host.id, workspace.dir) === undefined) continue;
		try {
			await host.link.request({ case: "projectAdd", value: { dir: workspace.dir, name: "", consent: { sensitive: false, projectSettings: false } } });
		} catch (err) {
			const waits = isNeedsConsent(err) || (err instanceof RemoteError && (err.reason === ErrorReason.FOLDER_NOT_FOUND || err.reason === ErrorReason.PROJECT_EXISTS));
			if (!waits) console.warn("ai: the machine did not keep a workspace's folder", err);
		}
	}
}

function warnMark(err: unknown): void {
	console.warn("ai: could not update the mark of a dropped folder", err);
}

/**
 * One pass over `hosts`. It never records a folder: a workspace appears only
 * for the machine the user picked (Thêm workspace, Thêm dự án) or where they
 * started a session from the app, so another machine's clone of the same
 * repository stays out of the project until it is added by hand. The pass
 * only has a machine drop the folders detached while it was offline, keep
 * again the folder of a workspace it lost, and moves a workspace grouped
 * with another repository to its own (repairWorkspaces).
 */
export async function syncHosts(store: AgentProjectsStore, hosts: readonly SyncHost[]): Promise<number> {
	const snapshot = store.snapshot();
	if (snapshot.status !== "ready") return 0;
	const known = [...snapshot.projects];
	// Every machine is asked at once: one that is slow to answer holds up only itself.
	const lists = new Map(await Promise.all(hosts.filter((h) => h.ready && h.id > 0).map(async (h) => [h, await currentProjects(h)] as const)));
	for (const host of hosts) {
		const listed = lists.get(host);
		if (listed === undefined) continue;
		const own = listed.filter((p) => !p.missing);
		// Detached here while the machine was offline: it drops the folder now.
		for (const p of own) {
			const key = { machineId: host.id, dir: p.dir };
			if (!store.isDetached(key)) continue;
			// Placed again since (on another device): it stays.
			if (findWorkspace(known, host.id, p.dir) !== undefined) {
				await store.setDetached(key, false).catch(warnMark);
				continue;
			}
			await host.link.request({ case: "projectRemove", value: { id: p.id } }).then(
				() => store.setDetached(key, false).catch(warnMark),
				(err: unknown) => console.warn("ai: the machine did not drop a detached folder", err),
			);
		}
		// A mark for a folder the machine no longer keeps: it dropped the folder (this device or another did it), so nothing is left to wait for.
		for (const mark of store.detachedOf(host.id)) {
			if (!own.some((p) => samePath(p.dir, mark.dir))) await store.setDetached(mark, false).catch(warnMark);
		}
		await keepWorkspaces(store, host, known, listed);
	}
	// A workspace in a project that links another repository goes to its own repository's project (projects linking none are left alone).
	const moved = await repairWorkspaces(store.api, known, knownRemotes(known, hosts)).catch((err: unknown) => {
		console.warn("ai: could not move a workspace to its repository's project", err);
		return 0;
	});
	if (moved > 0) await store.refresh();
	return moved;
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

/** Links `project` to the repository of `url` ("" unlinks); a folder of that repository added later joins it, and the next sync pass moves another repository's workspaces out of it. */
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
 * Keeps the server's projects in step with the machines online (syncHosts:
 * dropped folders, workspace folders a machine lost, workspaces grouped with
 * another repository): a pass after the lists settle, one at a time. It
 * never adds a workspace.
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

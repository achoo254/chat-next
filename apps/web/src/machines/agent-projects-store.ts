// The user's AI Agent projects as the server keeps them, for every AI Agent
// screen: listed once, again when another device changes them (the
// agent_projects_changed update), when the app comes back to the front and
// after each change made here. One store per signed-in app, kept with the
// link hub. It also remembers, on this device, the folders the user is
// placing by hand right now (the sync leaves them alone). The folders dropped
// while their machine was offline (the machine is told when it is back, so
// the sync does not add them again) are marked on the server, so every
// device of the user leaves them alone, not only the one that dropped them.
import { useEffect, useSyncExternalStore } from "react";
import { EventKeys } from "@achoo254/chat-core";
import { useServices, type Services } from "../messaging/data/services.tsx";
import { createAgentProjectsApi, type AgentProject, type AgentProjectsApi } from "./agent-projects-client.ts";
import type { LinkHub } from "./link/link-hub.ts";
import { samePath } from "./projects-view.ts";
import { useHub } from "./use-machines.ts";

export interface ProjectsSnapshot {
	/** "loading" until the first list arrives; "error" while the last list failed (the previous projects stay). */
	readonly status: "loading" | "ready" | "error";
	readonly projects: readonly AgentProject[];
}

export interface FolderKey {
	readonly machineId: number;
	readonly dir: string;
}

export class AgentProjectsStore {
	private state: ProjectsSnapshot = { status: "loading", projects: [] };
	private readonly listeners = new Set<() => void>();
	private loading: Promise<void> | null = null;
	private again = false;
	private readonly claims: FolderKey[] = [];
	/** The folders marked as dropped: as the server listed them, and what this device marked since. */
	private marks: FolderKey[] = [];

	constructor(readonly api: AgentProjectsApi) {}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): ProjectsSnapshot => this.state;

	/** Lists again; calls while a list runs coalesce into one more after it. */
	refresh(): Promise<void> {
		if (this.loading !== null) {
			this.again = true;
			return this.loading;
		}
		this.loading = (async () => {
			do {
				this.again = false;
				try {
					const { projects, detached } = await this.api.listAll();
					this.marks = [...detached];
					this.set({ status: "ready", projects });
				} catch {
					// Shown as "error" with what was known; the next change, focus or update lists again.
					this.set({ status: "error", projects: this.state.projects });
				}
			} while (this.again);
			this.loading = null;
		})();
		return this.loading;
	}

	/** Runs a change made by hand, then lists again (also when it failed). */
	async change<T>(run: (api: AgentProjectsApi) => Promise<T>): Promise<T> {
		try {
			return await run(this.api);
		} finally {
			await this.refresh();
		}
	}

	/**
	 * Puts the projects in the order of `ids` at once (those left out follow),
	 * then on the server; a refusal brings the server's order back.
	 */
	reorder(ids: readonly number[]): Promise<void> {
		const rank = new Map(ids.map((id, i) => [id, i]));
		const projects = [...this.state.projects].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length) || a.order - b.order).map((p, i) => ({ ...p, order: i + 1 }));
		this.set({ status: this.state.status, projects });
		return this.change((api) => api.reorder(ids));
	}

	/** While `run` runs, the sync leaves `folder` alone (the user is placing it). */
	async claim<T>(folder: FolderKey, run: () => Promise<T>): Promise<T> {
		this.claims.push(folder);
		try {
			return await run();
		} finally {
			this.claims.splice(this.claims.indexOf(folder), 1);
		}
	}

	claimed(folder: FolderKey): boolean {
		return this.claims.some((c) => c.machineId === folder.machineId && samePath(c.dir, folder.dir));
	}

	/** Dropped by the user while its machine could not be told (marked on the server, so by any device). */
	isDetached(folder: FolderKey): boolean {
		return this.marks.some((d) => d.machineId === folder.machineId && samePath(d.dir, folder.dir));
	}

	/** The folders of machine `machineId` marked as dropped. */
	detachedOf(machineId: number): readonly FolderKey[] {
		return this.marks.filter((d) => d.machineId === machineId);
	}

	/**
	 * Marks a folder as dropped (its machine could not be told), or takes the
	 * mark off (the machine dropped it, or it is recorded again). Takes effect
	 * here at once, then on the server; the list that follows brings the
	 * server's marks back, also when the server refused. Nothing is sent when
	 * the mark is already as asked.
	 */
	async setDetached(folder: FolderKey, detached: boolean): Promise<void> {
		if (this.isDetached(folder) === detached) return;
		this.marks = this.marks.filter((d) => !(d.machineId === folder.machineId && samePath(d.dir, folder.dir)));
		if (detached) this.marks.push({ machineId: folder.machineId, dir: folder.dir });
		try {
			await this.api.setFolderDetached(folder.machineId, folder.dir, detached);
		} finally {
			await this.refresh();
		}
	}

	private set(next: ProjectsSnapshot): void {
		this.state = next;
		for (const listener of this.listeners) listener();
	}
}

const stores = new WeakMap<LinkHub, AgentProjectsStore>();

/** The chat source's change events, when the screens run inside the signed-in app (not in the isolated tests and harness). */
function changesOf(services: Services): Services["source"]["events"] | null {
	return "source" in services ? services.source.events : null;
}

/** The store, listed once and kept current while an AI Agent screen shows. */
export function useAgentProjects(): [AgentProjectsStore, ProjectsSnapshot] {
	const hub = useHub();
	const services = useServices();
	let store = stores.get(hub);
	if (store === undefined) {
		store = new AgentProjectsStore(createAgentProjectsApi(services.transport));
		stores.set(hub, store);
	}
	const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
	const events = changesOf(services);
	useEffect(() => {
		const current = store;
		if (current.snapshot().status === "loading") current.refresh().catch(() => undefined);
		const onVisible = () => {
			if (document.visibilityState === "visible") current.refresh().catch(() => undefined);
		};
		document.addEventListener("visibilitychange", onVisible);
		const off = events?.subscribe(EventKeys.agentProjects, () => void current.refresh().catch(() => undefined));
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			off?.();
		};
	}, [store, events]);
	return [store, snapshot];
}

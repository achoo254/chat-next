// The user's AI Agent projects as the server keeps them, for every AI Agent
// screen: listed once, again when another device changes them (the
// agent_projects_changed update), when the app comes back to the front and
// after each change made here. One store per signed-in app, kept with the
// link hub. It also remembers, on this device, the folders the user is
// placing by hand right now (the sync leaves them alone) and the workspaces
// detached while their machine was offline (the machine is told when it is
// back, so the sync does not add them again).
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

const DETACHED_KEY = "ai:detached";

export interface FolderKey {
	readonly machineId: number;
	readonly dir: string;
}

function readDetached(): FolderKey[] {
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(DETACHED_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is FolderKey => typeof x === "object" && x !== null && typeof (x as FolderKey).machineId === "number" && typeof (x as FolderKey).dir === "string");
	} catch {
		return [];
	}
}

function writeDetached(list: readonly FolderKey[]): void {
	try {
		window.localStorage.setItem(DETACHED_KEY, JSON.stringify(list));
	} catch {
		// Private mode: the machine is still told while this page stays open.
	}
}

export class AgentProjectsStore {
	private state: ProjectsSnapshot = { status: "loading", projects: [] };
	private readonly listeners = new Set<() => void>();
	private loading: Promise<void> | null = null;
	private again = false;
	private readonly claims: FolderKey[] = [];
	private detached: FolderKey[] = readDetached();

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
					this.set({ status: "ready", projects: await this.api.list() });
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

	/** Detached here while its machine could not be told. */
	isDetached(folder: FolderKey): boolean {
		return this.detached.some((d) => d.machineId === folder.machineId && samePath(d.dir, folder.dir));
	}

	setDetached(folder: FolderKey, detached: boolean): void {
		this.detached = this.detached.filter((d) => !(d.machineId === folder.machineId && samePath(d.dir, folder.dir)));
		if (detached) this.detached.push({ machineId: folder.machineId, dir: folder.dir });
		writeDetached(this.detached);
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

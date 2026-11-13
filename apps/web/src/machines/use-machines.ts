// Hooks and helpers shared by the AI Agent screens: the link hub from
// the slot above the screens, the directory, one machine's link, and the
// wording of remote errors.
import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { brand } from "../brand.ts";
import { isStandalone } from "../install-prompt.ts";
import { IS_NATIVE } from "../server-origin.ts";
import { ThreadState, type MachineInfo, type ProviderInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { useServices } from "../messaging/data/services.tsx";
import { setAgentNeeds } from "./agent-needs.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { useHubSlot } from "./link/connection-provider.tsx";
import { deviceKeyStore } from "./link/device-keys.ts";
import { deviceIdentity } from "./link/device-registration.ts";
import { LinkHub, LOCAL_REF, localMachine, type DirectoryState } from "./link/link-hub.ts";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { machineErrorText } from "./machine-errors.ts";
import { browserSocket } from "./link/socket.ts";
import { connOf, shouldConnect, type Conn } from "./machine-status.ts";
import { createMachinesDirectory, type MachineEntry } from "./machines-client.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const DIRECTORY_REFRESH_MS = 60_000;

/** The hub of links, made the first time a machines screen opens. */
export function useHub(): LinkHub {
	const slot = useHubSlot();
	const { transport } = useServices();
	const t = useMachinesCopy();
	return slot.get(() => {
		const hub = new LinkHub({
			// A 401 also reaches the client core, which ends the session; nothing to add here.
			directory: createMachinesDirectory(transport, () => undefined),
			keys: deviceKeyStore(),
			identity: deviceIdentity({ userAgent: navigator.userAgent, native: IS_NATIVE, standalone: isStandalone(), appName: brand.appName }),
			socket: browserSocket,
			localName: t.local.name,
		});
		countNeeds(hub);
		return hub;
	});
}

/** Waiting sessions of every machine the hub has a link to, for the navigation badge. */
export function needsOf(hub: LinkHub): number {
	const refs = hub.directory().machines.map((m) => m.ref);
	if (localMachine() !== null) refs.push(LOCAL_REF);
	let count = 0;
	for (const ref of refs) {
		for (const thread of hub.link(ref).snapshot().threads) if (thread.state === ThreadState.WAITING) count += 1;
	}
	return count;
}

/**
 * Keeps the navigation badge (agent-needs.ts) up to date for as long as the
 * hub lives, including while the user is in a chat: it follows the
 * directory and every machine's link.
 */
function countNeeds(hub: LinkHub): void {
	const watched = new Set<string>();
	const update = () => setAgentNeeds(needsOf(hub));
	const follow = () => {
		for (const machine of hub.directory().machines) {
			if (watched.has(machine.ref)) continue;
			watched.add(machine.ref);
			hub.link(machine.ref).subscribe(update);
		}
		update();
	};
	hub.subscribe(follow);
	follow();
}

/**
 * While a machines screen is open and the app visible, links ping (so the
 * machines hold back pushes) and reconnect at once when the app comes back
 * or the network returns. The directory refreshes every minute. Entering the
 * machines screens registers this device with the account (once per page),
 * so the machines know it by the time a link opens.
 */
export function useHubPresence(hub: LinkHub): void {
	useEffect(() => {
		// A failure here is retried by the first link that needs the key, which also reports it.
		hub.device().catch(() => undefined);
		const visible = () => document.visibilityState === "visible";
		const update = () => {
			hub.setActive(visible());
			if (visible()) hub.wake();
		};
		update();
		hub.refresh().catch(() => undefined);
		const timer = window.setInterval(() => {
			if (visible()) hub.refresh().catch(() => undefined);
		}, DIRECTORY_REFRESH_MS);
		document.addEventListener("visibilitychange", update);
		window.addEventListener("online", update);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("online", update);
			hub.setActive(false);
		};
	}, [hub]);
}

export function useDirectory(hub: LinkHub): DirectoryState {
	return useSyncExternalStore(hub.subscribe, hub.directory);
}

/** The machine `ref` as the directory lists it (or the development machine). */
export function useEntry(hub: LinkHub, ref: string): MachineEntry | null {
	// Read from the snapshot itself, so the result follows the directory (a
	// bare hub.entry(ref) would be memoized on hub and ref alone).
	const directory = useDirectory(hub);
	return directory.machines.find((m) => m.ref === ref) ?? hub.entry(ref);
}

/** The started link to `ref` and its state. */
export function useLink(hub: LinkHub, ref: string): [MachineLink, LinkState] {
	const link = hub.link(ref);
	useEffect(() => link.start(), [link]);
	const state = useSyncExternalStore(link.subscribe, link.snapshot);
	return [link, state];
}

/** One machine as the session column and the boards show it. */
export interface MachineView {
	readonly entry: MachineEntry;
	readonly link: MachineLink;
	readonly state: LinkState;
	readonly conn: Conn;
}

/**
 * Every machine of the directory (and the development machine) with its
 * link. A link opens only to a machine the directory sees online
 * (shouldConnect), so sleeping machines hold no socket; open links ping
 * only while a machines screen is visible (useHubPresence).
 */
export function useMachineViews(hub: LinkHub, now: number): MachineView[] {
	const directory = useDirectory(hub);
	const local = localMachine() !== null ? hub.entry(LOCAL_REF) : null;
	const entries = local === null ? directory.machines : [...directory.machines, local];
	const refs = entries.map((e) => e.ref).join(",");
	const links = entries.map((e) => hub.link(e.ref));
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		const offs = refs === "" ? [] : refs.split(",").map((ref) => hub.link(ref).subscribe(rerender));
		return () => {
			for (const off of offs) off();
		};
	}, [hub, refs]);
	const states = links.map((link) => link.snapshot());
	useEffect(() => {
		for (const entry of entries) {
			if (shouldConnect(entry, now)) hub.link(entry.ref).start();
		}
	});
	return entries.map((entry, i) => {
		const link = links[i] ?? hub.link(entry.ref);
		const state = states[i] ?? link.snapshot();
		return { entry, link, state, conn: connOf(entry, state, now) };
	});
}

/** Watches a thread while the component shows it. */
export function useWatch(link: MachineLink, threadId: string): void {
	useEffect(() => link.watch(threadId), [link, threadId]);
}

/** The current time, refreshed every `everyMs` (for "5 minutes ago" and online dots). */
export function useNow(everyMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), everyMs);
		return () => window.clearInterval(timer);
	}, [everyMs]);
	return now;
}

export function timeAgo(t: MachinesCopy, thenMs: number, nowMs: number): string {
	const minutes = Math.floor((nowMs - thenMs) / 60_000);
	if (minutes < 1) return t.ago.now;
	if (minutes < 60) return t.ago.minutes(minutes);
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t.ago.hours(hours);
	return t.ago.days(Math.floor(hours / 24));
}

/** The adapter `id` as the machine reports it. */
export function providerOf(info: MachineInfo | null, id: string): ProviderInfo | null {
	return info?.providers.find((p) => p.id === id) ?? null;
}

/** The AI's display name: as the machine names it, else its id. */
export function aiName(info: MachineInfo | null, id: string): string {
	return providerOf(info, id)?.name || id || "AI";
}

/** A model's display name from the provider's list, else its id. */
export function modelName(info: MachineInfo | null, provider: string, model: string): string {
	const found = providerOf(info, provider)?.capabilities?.models.find((m) => m.id === model);
	return found?.name || model;
}

/**
 * A model id as the AI reports it, for people: "claude-opus-5-5" and
 * "claude-sonnet-4-5-20250929" read "Opus 5.5" and "Sonnet 4.5" (a "[1m]"
 * suffix dropped); any other id
 * stays as it is.
 */
export function readableModel(id: string): string {
	// A context-window suffix ("claude-opus-5-5[1m]") is not part of the name.
	const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id);
	if (m === null) return id;
	const family = m[1] ?? "";
	return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2] ?? ""}${m[3] === undefined ? "" : `.${m[3]}`}`;
}

/**
 * Which model the AI's default is, for people: the model the latest turn
 * reports answering (it names the exact version), else the one the AI's
 * settings on the machine pick ("Opus"); "" when neither is known.
 */
export function defaultModelName(info: MachineInfo | null, provider: string, answered: string): string {
	const id = answered !== "" ? answered : (providerOf(info, provider)?.defaultModel ?? "");
	return id === "" ? "" : readableModel(modelName(info, provider, id));
}

/** What to tell the user about a failed request, in the account's language (see machine-errors.ts). */
export function errorText(t: MachinesCopy, err: unknown, ai: string): string {
	return machineErrorText(t, err, ai);
}

/** "elsewhere": idle here, but its session runs a turn elsewhere on the machine (a terminal, an IDE). */
export type StateKey = "waiting" | "running" | "queued" | "idle" | "error" | "elsewhere";

/** What stateKey and isRunning read; busyElsewhere is absent from older machines (and reads as false). */
export type ThreadStateOf = Pick<ThreadSummary, "state"> & Partial<Pick<ThreadSummary, "busyElsewhere">>;

export function stateKey(thread: ThreadStateOf): StateKey {
	switch (thread.state) {
		case ThreadState.WAITING:
			return "waiting";
		case ThreadState.RUNNING:
			return "running";
		case ThreadState.QUEUED:
			return "queued";
		case ThreadState.ERROR:
			return "error";
		default:
			return thread.busyElsewhere === true ? "elsewhere" : "idle";
	}
}

/** Runs a turn: on the machine for devices, waiting for room, or elsewhere on the machine. */
export function isRunning(thread: ThreadStateOf): boolean {
	const key = stateKey(thread);
	return key === "running" || key === "queued" || key === "elsewhere";
}

/** The last path segment, for headers and tiles ("~/code/chat-next" → "chat-next"). */
export function folderName(dir: string): string {
	const parts = dir.split(/[\\/]+/).filter((p) => p !== "");
	return parts.at(-1) ?? dir;
}

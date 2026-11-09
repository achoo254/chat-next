// Hooks and helpers shared by the "My machines" screens: the link hub from
// the slot above the screens, the directory, one machine's link, and the
// wording of remote errors.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ThreadState, type MachineInfo, type ProviderInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { useServices } from "../messaging/data/services.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { useHubSlot } from "./link/connection-provider.tsx";
import { deviceKeyStore } from "./link/device-keys.ts";
import { deviceName, LinkHub, type DirectoryState } from "./link/link-hub.ts";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { machineErrorText } from "./machine-errors.ts";
import { browserSocket } from "./link/socket.ts";
import { createMachinesDirectory, type MachineEntry } from "./machines-client.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const DIRECTORY_REFRESH_MS = 60_000;

/** The hub of links, made the first time a machines screen opens. */
export function useHub(): LinkHub {
	const slot = useHubSlot();
	const { transport } = useServices();
	const t = useMachinesCopy();
	return slot.get(
		() =>
			new LinkHub({
				// A 401 also reaches the client core, which ends the session; nothing to add here.
				directory: createMachinesDirectory(transport, () => undefined),
				keys: deviceKeyStore(),
				deviceName: deviceName(navigator.userAgent),
				socket: browserSocket,
				localName: t.local.name,
			}),
	);
}

/**
 * While a machines screen is open and the app visible, links ping (so the
 * machines hold back pushes) and reconnect at once when the app comes back
 * or the network returns. The directory refreshes every minute.
 */
export function useHubPresence(hub: LinkHub): void {
	useEffect(() => {
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

/** What to tell the user about a failed request, in the account's language (see machine-errors.ts). */
export function errorText(t: MachinesCopy, err: unknown, ai: string): string {
	return machineErrorText(t, err, ai);
}

export type StateKey = "waiting" | "running" | "queued" | "idle" | "error";

export function stateKey(thread: Pick<ThreadSummary, "state">): StateKey {
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
			return "idle";
	}
}

/** The last path segment, for headers and tiles ("~/code/chat-next" → "chat-next"). */
export function folderName(dir: string): string {
	const parts = dir.split(/[\\/]+/).filter((p) => p !== "");
	return parts.at(-1) ?? dir;
}

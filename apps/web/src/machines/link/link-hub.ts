// The machines screens' shared state: the directory (ListMachines), this
// device's key registered with the account (device-registration.ts) and one
// MachineLink per machine, kept in the HubSlot above the screens
// (connection-provider.tsx). In development a machine on this computer
// ("local", `tunelo run --port N`) can stand in for the directory: it is one
// of the directory's machines, reached on 127.0.0.1 instead of its tunnel.
import type { KeyPair } from "@achoo254/chat-remote-protocol";
import type { MachineEntry, MachinesDirectory } from "../machines-client.ts";
import type { DeviceKeyStore } from "./device-keys.ts";
import { registeredDevice, type DeviceIdentity } from "./device-registration.ts";
import { MachineLink } from "./machine-link.ts";
import type { SocketFactory } from "./socket.ts";

export const LOCAL_REF = "local";
const LOCAL_KEY = "machines:local";

export type DirectoryState =
	| { readonly status: "loading"; readonly machines: readonly MachineEntry[] }
	| { readonly status: "ready"; readonly machines: readonly MachineEntry[] }
	| { readonly status: "error"; readonly machines: readonly MachineEntry[] };

/** The development machine: its port on this computer and which machine of the directory it is. */
export interface LocalMachine {
	readonly port: number;
	readonly machineId: number;
}

/** The development machine, if one was set up (development builds only). */
export function localMachine(): LocalMachine | null {
	if (!import.meta.env.DEV) return null;
	try {
		const raw: unknown = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? "null");
		if (typeof raw !== "object" || raw === null) return null;
		const { port, machineId } = raw as Record<string, unknown>;
		if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port >= 65536) return null;
		if (typeof machineId !== "number" || !Number.isSafeInteger(machineId) || machineId <= 0) return null;
		return { port, machineId };
	} catch {
		return null;
	}
}

export function setLocalMachine(local: LocalMachine | null): void {
	if (!import.meta.env.DEV) return;
	if (local === null) window.localStorage.removeItem(LOCAL_KEY);
	else window.localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
}

function localEntry(local: LocalMachine, name: string, listed: MachineEntry | undefined): MachineEntry {
	return {
		ref: LOCAL_REF,
		id: 0,
		name,
		os: listed?.os ?? "",
		arch: listed?.arch ?? "",
		agentVersion: listed?.agentVersion ?? "",
		claudeVersion: listed?.claudeVersion ?? "",
		tunnelUrl: `ws://127.0.0.1:${local.port}`,
		createdAt: 0,
		lastSeenAt: 0,
		// The key the account lists for that machine; empty until the directory loaded.
		publicKey: listed?.publicKey ?? new Uint8Array(0),
	};
}

export interface HubDeps {
	readonly directory: MachinesDirectory;
	readonly keys: DeviceKeyStore;
	/** How this device names itself on the account's device list. */
	readonly identity: DeviceIdentity;
	readonly socket: SocketFactory;
	/** Name shown for the development machine. */
	readonly localName: string;
}

export class LinkHub {
	private state: DirectoryState = { status: "loading", machines: [] };
	private loading: Promise<readonly MachineEntry[]> | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly links = new Map<string, MachineLink>();
	/** Second connections that carry only a machine's terminal (MachineLink purpose "terminal"). */
	private readonly carriers = new Map<string, MachineLink>();
	private active = false;
	/** This device's key, registered with the account on first use. */
	readonly device: () => Promise<KeyPair>;

	constructor(readonly deps: HubDeps) {
		this.device = registeredDevice(deps.keys, deps.directory, deps.identity);
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly directory = (): DirectoryState => this.state;

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	/** Loads the directory (once at a time). */
	refresh(): Promise<readonly MachineEntry[]> {
		if (this.loading !== null) return this.loading;
		if (this.state.status === "error") {
			this.state = { status: "loading", machines: this.state.machines };
			this.emit();
		}
		this.loading = this.deps.directory.list().then(
			(machines) => {
				this.loading = null;
				this.state = { status: "ready", machines };
				this.emit();
				return machines;
			},
			(err: unknown) => {
				this.loading = null;
				this.state = { status: "error", machines: this.state.machines };
				this.emit();
				throw err;
			},
		);
		return this.loading;
	}

	/** The machine `ref` from the directory (or the development machine); null when unknown. */
	entry(ref: string): MachineEntry | null {
		if (ref === LOCAL_REF) {
			const local = localMachine();
			return local === null ? null : localEntry(local, this.deps.localName, this.state.machines.find((m) => m.id === local.machineId));
		}
		return this.state.machines.find((m) => m.ref === ref) ?? null;
	}

	/** The link to `ref`, made (not started) on first use. */
	link(ref: string): MachineLink {
		let link = this.links.get(ref);
		if (link === undefined) {
			link = this.makeLink(ref, "chat");
			link.setActive(this.active);
			this.links.set(ref, link);
		}
		return link;
	}

	/** The terminal's own connection to `ref`, made (not started) on first use; the terminal starts and stops it. */
	terminalCarrier(ref: string): MachineLink {
		let carrier = this.carriers.get(ref);
		if (carrier === undefined) {
			carrier = this.makeLink(ref, "terminal");
			this.carriers.set(ref, carrier);
		}
		return carrier;
	}

	private makeLink(ref: string, purpose: "chat" | "terminal"): MachineLink {
		return new MachineLink({
			device: this.device,
			expectedKey: () => {
				const key = this.entry(ref)?.publicKey;
				return key === undefined || key.length !== 32 ? null : key;
			},
			seenKey: () => this.deps.keys.seenMachineKey(ref),
			rememberKey: (key) => this.deps.keys.rememberMachineKey(ref, key),
			tunnelUrl: () => this.entry(ref)?.tunnelUrl ?? "",
			refreshTunnel: async () => {
				await this.refresh();
				return this.entry(ref)?.tunnelUrl ?? "";
			},
			socket: this.deps.socket,
			purpose,
		});
	}

	/** Restarts the terminal connection of `ref` if it runs (a new address, a new key accepted). */
	private restartCarrier(ref: string): void {
		const carrier = this.carriers.get(ref);
		if (carrier === undefined || !carrier.started) return;
		carrier.stop();
		carrier.start();
	}

	/**
	 * Reads the machine's latest state again: the directory (its address,
	 * heartbeat and key), then fresh links. A link stopped because the
	 * machine's key changed takes the key the account lists now: asking for
	 * this is the user's consent to it. A directory failure leaves the link
	 * alone.
	 */
	async reload(ref: string): Promise<void> {
		await this.refresh();
		const status = this.links.get(ref)?.snapshot().status;
		if (status?.kind === "failed" && status.reason === "key-changed") {
			console.warn(`machines: the user accepted the new key of machine ${ref}`);
			await this.deps.keys.forgetMachineKey(ref);
		}
		this.restartCarrier(ref);
		const link = this.links.get(ref);
		if (link === undefined) return;
		link.stop();
		link.start();
	}

	/** Forgets a machine on this device (removed from the account). */
	async forget(ref: string): Promise<void> {
		this.links.get(ref)?.stop();
		this.links.delete(ref);
		this.carriers.get(ref)?.stop();
		await this.deps.keys.forgetMachineKey(ref);
	}

	/** The user is on a machines screen and the app is visible: links ping. */
	setActive(active: boolean): void {
		this.active = active;
		for (const link of this.links.values()) link.setActive(active);
	}

	/** Reconnect now (back in the foreground, network back). */
	wake(): void {
		for (const link of this.links.values()) link.wake();
		for (const carrier of this.carriers.values()) carrier.wake();
	}

	dispose(): void {
		for (const link of this.links.values()) link.stop();
		for (const carrier of this.carriers.values()) carrier.stop();
	}
}

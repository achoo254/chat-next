// The machines screens' shared state: the directory (ListMachines) and one
// MachineLink per machine, kept in the HubSlot above the screens
// (connection-provider.tsx). In development a machine on this computer
// ("local", `chat-agent run --port N`) can stand in for the directory.
import type { MachineEntry, MachinesDirectory } from "../machines-client.ts";
import type { DeviceKeyStore } from "./device-keys.ts";
import { MachineLink } from "./machine-link.ts";
import type { SocketFactory } from "./socket.ts";

export const LOCAL_REF = "local";
const LOCAL_PORT_KEY = "machines:local-port";

export type DirectoryState =
	| { readonly status: "loading"; readonly machines: readonly MachineEntry[] }
	| { readonly status: "ready"; readonly machines: readonly MachineEntry[] }
	| { readonly status: "error"; readonly machines: readonly MachineEntry[] };

/** The development machine's port, if one was paired (development builds only). */
export function localPort(): number | null {
	if (!import.meta.env.DEV) return null;
	const port = Number(window.localStorage.getItem(LOCAL_PORT_KEY));
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function setLocalPort(port: number | null): void {
	if (!import.meta.env.DEV) return;
	if (port === null) window.localStorage.removeItem(LOCAL_PORT_KEY);
	else window.localStorage.setItem(LOCAL_PORT_KEY, String(port));
}

function localEntry(port: number, name: string): MachineEntry {
	return {
		ref: LOCAL_REF,
		id: 0,
		name,
		os: "",
		arch: "",
		agentVersion: "",
		claudeVersion: "",
		tunnelUrl: `ws://127.0.0.1:${port}`,
		createdAt: 0,
		lastSeenAt: 0,
	};
}

export interface HubDeps {
	readonly directory: MachinesDirectory;
	readonly keys: DeviceKeyStore;
	readonly deviceName: string;
	readonly socket: SocketFactory;
	/** Name shown for the development machine. */
	readonly localName: string;
}

export class LinkHub {
	private state: DirectoryState = { status: "loading", machines: [] };
	private loading: Promise<readonly MachineEntry[]> | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly links = new Map<string, MachineLink>();
	private active = false;

	constructor(readonly deps: HubDeps) {}

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
			const port = localPort();
			return port === null ? null : localEntry(port, this.deps.localName);
		}
		return this.state.machines.find((m) => m.ref === ref) ?? null;
	}

	/** The link to `ref`, made (not started) on first use. */
	link(ref: string): MachineLink {
		let link = this.links.get(ref);
		if (link === undefined) {
			link = new MachineLink({
				device: () => this.deps.keys.device(),
				deviceName: this.deps.deviceName,
				pinned: () => this.deps.keys.pinned(ref),
				tunnelUrl: () => this.entry(ref)?.tunnelUrl ?? "",
				refreshTunnel: async () => {
					if (ref !== LOCAL_REF) await this.refresh();
					return this.entry(ref)?.tunnelUrl ?? "";
				},
				socket: this.deps.socket,
			});
			link.setActive(this.active);
			this.links.set(ref, link);
		}
		return link;
	}

	/** Pins a machine key after pairing and restarts its link with it. */
	async pinned(ref: string, machineKey: Uint8Array): Promise<void> {
		await this.deps.keys.pin(ref, machineKey);
		const link = this.links.get(ref);
		if (link !== undefined) {
			link.stop();
			link.start();
		}
	}

	/** Forgets a machine on this device (removed, or paired again). */
	async forget(ref: string): Promise<void> {
		this.links.get(ref)?.stop();
		this.links.delete(ref);
		await this.deps.keys.forget(ref);
	}

	/** The user is on a machines screen and the app is visible: links ping. */
	setActive(active: boolean): void {
		this.active = active;
		for (const link of this.links.values()) link.setActive(active);
	}

	/** Reconnect now (back in the foreground, network back). */
	wake(): void {
		for (const link of this.links.values()) link.wake();
	}

	dispose(): void {
		for (const link of this.links.values()) link.stop();
	}
}

/** A name for this device on the machine's device list, such as "Chrome on Windows". */
export function deviceName(userAgent: string): string {
	const browser = /Edg\//.test(userAgent)
		? "Edge"
		: /Firefox\//.test(userAgent)
			? "Firefox"
			: /Chrome\//.test(userAgent)
				? "Chrome"
				: /Safari\//.test(userAgent)
					? "Safari"
					: "Browser";
	const os = /iPhone/.test(userAgent)
		? "iPhone"
		: /iPad/.test(userAgent)
			? "iPad"
			: /Android/.test(userAgent)
				? "Android"
				: /Windows/.test(userAgent)
					? "Windows"
					: /Mac OS X|Macintosh/.test(userAgent)
						? "macOS"
						: /Linux/.test(userAgent)
							? "Linux"
							: "";
	return os === "" ? browser : `${browser} · ${os}`;
}

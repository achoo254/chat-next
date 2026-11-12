// The machine directory on the chat server (MachinesService, ADR 0013): the
// user's machines with their tunnel address, last heartbeat and key, renaming
// and removing a machine, and the account's devices (registering this one
// with a proof that it holds its key, listing and revoking them). tunelo adds
// a machine by itself with the account it signed in with. Mapped from the
// wire (ADR 0001: int64 arrive as bigint below 2^53, leave as number). The
// account is the anchor of trust: a device expects the machine key listed
// here, and a machine accepts the device keys the account lists for it.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { MachinesService, type AccountDevice, type KeyChallenge, type Machine } from "@achoo254/chat-proto/machines";

/** A heartbeat this recent counts as online (the agent beats every 60 s). */
export const ONLINE_MS = 2 * 60_000;

export interface MachineEntry {
	/** The machine id as text; "local" for the development machine. */
	readonly ref: string;
	readonly id: number;
	readonly name: string;
	/** process.platform and process.arch of the agent: "darwin", "win32", "linux"; "arm64", "x64". */
	readonly os: string;
	readonly arch: string;
	readonly agentVersion: string;
	readonly claudeVersion: string;
	/** "" while the tunnel is down. */
	readonly tunnelUrl: string;
	/** Unix seconds. */
	readonly createdAt: number;
	readonly lastSeenAt: number;
	/** The machine's X25519 key the handshake must meet (32 bytes; empty when the server has none). */
	readonly publicKey: Uint8Array;
}

/** A device key of the account, as ListDevices returns it. */
export interface DeviceEntry {
	readonly publicKey: Uint8Array;
	readonly name: string;
	/** "web", "pwa", "ios", "android", … as the device reported it. */
	readonly platform: string;
	/** Unix seconds. */
	readonly createdAt: number;
	/** 0 before the device opened a link to any machine. */
	readonly lastSeenAt: number;
	/** 0 while the key is live. */
	readonly revokedAt: number;
	/** Registered by the session that asks: this device. */
	readonly current: boolean;
}

export interface DeviceRegistration {
	readonly publicKey: Uint8Array;
	readonly name: string;
	readonly platform: string;
	/** The challenge as received, and the mac proving the private key (proveKeyPossession). */
	readonly challenge: KeyChallenge;
	readonly mac: Uint8Array;
}

export interface MachinesDirectory {
	list(): Promise<MachineEntry[]>;
	rename(id: number, name: string): Promise<MachineEntry>;
	remove(id: number): Promise<void>;
	keyChallenge(): Promise<KeyChallenge>;
	registerDevice(registration: DeviceRegistration): Promise<DeviceEntry>;
	devices(): Promise<DeviceEntry[]>;
	revokeDevice(deviceKey: Uint8Array): Promise<void>;
}

export function toEntry(m: Machine): MachineEntry {
	return {
		ref: String(m.id),
		id: Number(m.id),
		name: m.name,
		os: m.os,
		arch: m.arch,
		agentVersion: m.agentVersion,
		claudeVersion: m.claudeVersion,
		tunnelUrl: m.tunnelUrl,
		createdAt: Number(m.createdAt),
		lastSeenAt: Number(m.lastSeenAt),
		publicKey: m.publicKey,
	};
}

export function toDevice(d: AccountDevice): DeviceEntry {
	return {
		publicKey: d.publicKey,
		name: d.name,
		platform: d.platform,
		createdAt: Number(d.createdAt),
		lastSeenAt: Number(d.lastSeenAt),
		revokedAt: Number(d.revokedAt),
		current: d.current,
	};
}

export function isOnline(entry: Pick<MachineEntry, "lastSeenAt" | "ref">, nowMs: number): boolean {
	return entry.ref === "local" || nowMs - entry.lastSeenAt * 1000 < ONLINE_MS;
}

export function createMachinesDirectory(transport: Transport, onUnauthenticated: () => void): MachinesDirectory {
	const client = createClient(MachinesService, transport);
	const call = async <T,>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (err) {
			if (ConnectError.from(err).code === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	};
	return {
		list: () => call(async () => (await client.listMachines({})).machines.map(toEntry)),
		rename: (id, name) =>
			call(async () => {
				const response = await client.renameMachine({ machineId: BigInt(id), name });
				if (response.machine === undefined) throw new Error("rename returned no machine");
				return toEntry(response.machine);
			}),
		remove: (id) =>
			call(async () => {
				await client.revokeMachine({ machineId: BigInt(id) });
			}),
		keyChallenge: () =>
			call(async () => {
				const { challenge } = await client.getDeviceKeyChallenge({});
				if (challenge === undefined) throw new Error("the server sent no key challenge");
				return challenge;
			}),
		registerDevice: (r) =>
			call(async () => {
				const { device } = await client.registerDevice({
					publicKey: new Uint8Array(r.publicKey),
					name: r.name,
					platform: r.platform,
					proof: { challenge: r.challenge, mac: new Uint8Array(r.mac) },
				});
				if (device === undefined) throw new Error("register returned no device");
				return toDevice(device);
			}),
		devices: () => call(async () => (await client.listDevices({})).devices.map(toDevice)),
		revokeDevice: (deviceKey) =>
			call(async () => {
				await client.revokeDevice({ devicePublicKey: new Uint8Array(deviceKey) });
			}),
	};
}

/** Server reasons (rate limits, a machine that is gone), from a Connect error. */
export function directoryErrorReason(err: unknown): string {
	const e = ConnectError.from(err);
	return e.code === Code.ResourceExhausted ? "rate" : e.code === Code.NotFound ? "not-found" : "other";
}

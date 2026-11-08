// The machine directory on the chat server (MachinesService, ADR 0013): the
// user's machines with their tunnel address and last heartbeat, renaming,
// removing a machine and revoking a paired device. tunelo adds a machine by
// itself with the account it signed in with; there are no install codes. Mapped
// from the wire (ADR 0001: int64 arrive as bigint below 2^53, leave as number). The
// server never vouches for a machine key: pairing does.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { MachinesService, type Machine } from "@achoo254/chat-proto/machines";

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
	/** Tied to the account by tunelo login; false for a machine of an old install code until then. */
	readonly claimed: boolean;
}

export interface MachinesDirectory {
	list(): Promise<MachineEntry[]>;
	rename(id: number, name: string): Promise<MachineEntry>;
	remove(id: number): Promise<void>;
	revokeDevice(id: number, deviceKey: Uint8Array): Promise<void>;
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
		claimed: m.claimed,
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
		revokeDevice: (id, deviceKey) =>
			call(async () => {
				await client.revokeDevice({ machineId: BigInt(id), devicePublicKey: new Uint8Array(deviceKey) });
			}),
	};
}

/** Server reasons (rate limits, a machine that is gone), from a Connect error. */
export function directoryErrorReason(err: unknown): string {
	const e = ConnectError.from(err);
	return e.code === Code.ResourceExhausted ? "rate" : e.code === Code.NotFound ? "not-found" : "other";
}

// One reading of "can this device use that machine now", shared by the
// session column, the boards and the session header, so every place names
// the same reason: blocked (the machine refused this device, the device was
// revoked, the machine's key changed, the session must sign in again), tunelo
// too old, offline (from the directory's heartbeat), connecting, reconnecting
// (attempt N), or open.
import type { LinkFailure, LinkState } from "./link/machine-link.ts";
import { isOnline, type MachineEntry } from "./machines-client.ts";

/** A lasting failure the user must act on, other than updating tunelo. */
export type BlockReason = Exclude<LinkFailure, "version">;

export type Conn =
	| { readonly kind: "blocked"; readonly reason: BlockReason }
	| { readonly kind: "update" }
	| { readonly kind: "offline"; readonly lastSeenMs: number }
	| { readonly kind: "connecting" }
	| { readonly kind: "retrying"; readonly attempt: number }
	| { readonly kind: "on" };

/** The directory sees the machine and it has a tunnel address. */
export function reachable(entry: Pick<MachineEntry, "ref" | "lastSeenAt" | "tunnelUrl">, nowMs: number): boolean {
	return isOnline(entry, nowMs) && entry.tunnelUrl !== "";
}

/**
 * The link to open: only to a machine the directory sees online. The others
 * cost nothing: no socket, no ping, no retries.
 */
export function shouldConnect(entry: Pick<MachineEntry, "ref" | "lastSeenAt" | "tunnelUrl">, nowMs: number): boolean {
	return reachable(entry, nowMs);
}

/** The link's own state wins once it has opened or failed. */
export function connOf(entry: Pick<MachineEntry, "ref" | "lastSeenAt" | "tunnelUrl">, state: Pick<LinkState, "status">, nowMs: number): Conn {
	const status = state.status;
	if (status.kind === "open") return { kind: "on" };
	if (status.kind === "failed") return status.reason === "version" ? { kind: "update" } : { kind: "blocked", reason: status.reason };
	if (!reachable(entry, nowMs)) return { kind: "offline", lastSeenMs: entry.lastSeenAt * 1000 };
	if ((status.kind === "connecting" || status.kind === "offline") && status.attempt > 1) return { kind: "retrying", attempt: status.attempt };
	return { kind: "connecting" };
}

/** Something only the user can unblock stops this device from using the machine. */
export function isBlocked(conn: Conn): conn is Extract<Conn, { kind: "blocked" }> {
	return conn.kind === "blocked";
}

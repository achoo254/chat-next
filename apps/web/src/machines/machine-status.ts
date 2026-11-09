// One reading of "can this device use that machine now", shared by the
// session column, the boards and the session header, so every place names
// the same reason: not paired with this device, must pair again, tunelo too
// old, offline (from the directory's heartbeat), connecting, reconnecting
// (attempt N), or open.
import type { LinkState } from "./link/machine-link.ts";
import { isOnline, type MachineEntry } from "./machines-client.ts";

export type Conn =
	| { readonly kind: "checking" }
	| { readonly kind: "unpaired" }
	| { readonly kind: "repair" }
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
 * The link to open: only to a machine this device is paired with (its key
 * is pinned) and that the directory sees online. The others cost nothing:
 * no socket, no ping, no retries.
 */
export function shouldConnect(entry: Pick<MachineEntry, "ref" | "lastSeenAt" | "tunnelUrl">, pinned: boolean | null, nowMs: number): boolean {
	return pinned === true && reachable(entry, nowMs);
}

/**
 * `pinned`: whether this device holds the machine's key (null while
 * reading it). The link's own state wins once it has opened or failed.
 */
export function connOf(entry: Pick<MachineEntry, "ref" | "lastSeenAt" | "tunnelUrl">, pinned: boolean | null, state: Pick<LinkState, "status">, nowMs: number): Conn {
	const status = state.status;
	if (status.kind === "open") return { kind: "on" };
	if (status.kind === "failed") {
		switch (status.reason) {
			case "unpaired":
				return { kind: "unpaired" };
			case "version":
				return { kind: "update" };
			default:
				return { kind: "repair" };
		}
	}
	if (pinned === false) return { kind: "unpaired" };
	if (!reachable(entry, nowMs)) return { kind: "offline", lastSeenMs: entry.lastSeenAt * 1000 };
	if (pinned === null) return { kind: "checking" };
	if ((status.kind === "connecting" || status.kind === "offline") && status.attempt > 1) return { kind: "retrying", attempt: status.attempt };
	return { kind: "connecting" };
}

/** Pairing (again) is what unblocks this machine on this device. */
export function needsPairing(conn: Conn): boolean {
	return conn.kind === "unpaired" || conn.kind === "repair";
}

// Which tunelo a machine runs, for features a newer one adds.
import { TerminalAvailability, type MachineInfo } from "@achoo254/chat-proto/remote/remote";

/** `version` ("2.0.1", "v2.1.0-beta") is at least `min`; false when unreadable. */
export function versionAtLeast(version: string, min: readonly number[]): boolean {
	const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (parts === null) return false;
	for (let i = 0; i < min.length; i++) {
		const have = Number(parts[i + 1]);
		const want = min[i] ?? 0;
		if (have !== want) return have > want;
	}
	return true;
}

/** The first tunelo that deletes and archives sessions (ThreadDelete, ThreadSetArchived). */
export const AGENT_THREAD_ACTIONS = [2, 0, 6] as const;

/** The first tunelo that keeps projects (ProjectList and friends). */
export const AGENT_PROJECTS = [2, 0, 7] as const;

/** The first tunelo that opens a session with no first message (it waits for the first one typed in it). */
export const AGENT_PARKED_SESSION = [2, 0, 9] as const;

/**
 * The first tunelo that tells what a running turn does (ThreadActivity) and
 * which sessions run a turn elsewhere on the machine (ThreadSummary.busy_elsewhere).
 */
export const AGENT_LIVE_ACTIVITY = [2, 5, 0] as const;

/**
 * Whether the machine offers a terminal: "available" (tunelo 2.4.0+ with its
 * terminal process), "missing" (the process is not installed yet: update),
 * "incompatible" (another major version runs, or nothing supervises it:
 * install again), "update" (a tunelo before 2.4.0), or "unknown" while the
 * machine has not described itself.
 */
export type TerminalGate = "available" | "missing" | "incompatible" | "update" | "unknown";

export function terminalGate(info: Pick<MachineInfo, "terminal"> | null): TerminalGate {
	if (info === null) return "unknown";
	switch (info.terminal) {
		case TerminalAvailability.AVAILABLE:
			return "available";
		case TerminalAvailability.MISSING:
			return "missing";
		case TerminalAvailability.INCOMPATIBLE:
			return "incompatible";
		default:
			return "update";
	}
}

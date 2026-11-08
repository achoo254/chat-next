// What the status bar above the composer reads, as plain functions: the
// countdown to a usage window's reset, a usage window shown or not, and the
// session's permission mode as one of the known Claude modes.
import type { RateWindow } from "@achoo254/chat-proto/remote/remote";

export interface Countdown {
	readonly days: number;
	readonly hours: number;
	readonly minutes: number;
}

/** Time left until `resetsAtMs` (Unix ms); null when unknown (0) or already past. */
export function resetIn(resetsAtMs: bigint | number, nowMs: number): Countdown | null {
	const at = Number(resetsAtMs);
	if (!Number.isFinite(at) || at <= 0) return null;
	const left = at - nowMs;
	if (left <= 0) return null;
	// Rounded up to the minute: "1m" until the very end, never "0m".
	const total = Math.ceil(left / 60_000);
	return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60 };
}

/** A usage window to show: present and with a sane percentage (0-100); null otherwise. */
export function usageOf(window: RateWindow | undefined, nowMs: number): { readonly pct: number; readonly left: Countdown | null; readonly resetsAt: number } | null {
	if (window === undefined) return null;
	const pct = Math.min(100, Math.max(0, Math.round(window.utilization)));
	return { pct, left: resetIn(window.resetsAt, nowMs), resetsAt: Number(window.resetsAt) };
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";

const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "auto"];

/** A known mode, or null for a value this page does not know (shown as is). */
export function permissionMode(value: string): PermissionMode | null {
	return (MODES as readonly string[]).includes(value) ? (value as PermissionMode) : null;
}

/** "max" becomes "Max": the plan as the AI's CLI names it, capitalised; "" stays "". */
export function planName(plan: string): string {
	return plan === "" ? "" : plan.charAt(0).toUpperCase() + plan.slice(1);
}

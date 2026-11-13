// What the status bar above the composer reads, as plain functions: the
// countdown to a usage window's reset, a usage window shown or not, and the
// session's permission mode by the label it shows.
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

/** The permission modes this page has a label for (status-bar.tsx); the AI's own bypass mode reads "bypass". */
export type ModeKey = "default" | "acceptEdits" | "plan" | "auto" | "bypass";

/** Mode ids as the AIs name them, by the label they share. */
const KNOWN_MODES: Readonly<Record<string, Exclude<ModeKey, "bypass">>> = {
	default: "default",
	acceptEdits: "acceptEdits",
	"accept-edits": "acceptEdits",
	plan: "plan",
	auto: "auto",
};

/**
 * The label of a session's permission mode: "bypass" for the AI's mode that
 * skips every prompt (ProviderCapabilities.bypass_mode_id), a known mode, or
 * null for one this page does not know (shown as the AI names it).
 */
export function modeKey(value: string, bypassModeId: string): ModeKey | null {
	if (value !== "" && value === bypassModeId) return "bypass";
	return Object.hasOwn(KNOWN_MODES, value) ? (KNOWN_MODES[value] ?? null) : null;
}

/** A mode as people read it: its translated label, else the id the AI gave it. */
export function modeLabel(labels: Readonly<Record<ModeKey, string>>, value: string, bypassModeId: string): string {
	const key = modeKey(value, bypassModeId);
	return key === null ? value : labels[key];
}

/** "max" becomes "Max": the plan as the AI's CLI names it, capitalised; "" stays "". */
export function planName(plan: string): string {
	return plan === "" ? "" : plan.charAt(0).toUpperCase() + plan.slice(1);
}

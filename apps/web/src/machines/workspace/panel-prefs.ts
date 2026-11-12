// The workspace panel's place on this device, per machine and workspace:
// open or closed, its width and its tab. Kept in localStorage; a browser
// that refuses storage (private mode) keeps it for the page only.

export type PanelTab = "explorer" | "scm";

export interface PanelPrefs {
	readonly open: boolean;
	readonly width: number;
	readonly tab: PanelTab;
}

export const PANEL_WIDTH = { min: 240, max: 720, initial: 340 } as const;

export const DEFAULT_PREFS: PanelPrefs = { open: false, width: PANEL_WIDTH.initial, tab: "explorer" };

const KEY = (machine: string, workspace: string) => `ai:panel:${machine}:${workspace}`;

/** A width within the panel's bounds (whole pixels). */
export function clampWidth(width: number): number {
	if (!Number.isFinite(width)) return PANEL_WIDTH.initial;
	return Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width)));
}

/** Parses what storage holds; anything unreadable gives the defaults. */
export function parsePrefs(raw: string | null): PanelPrefs {
	if (raw === null) return DEFAULT_PREFS;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return DEFAULT_PREFS;
	}
	if (typeof value !== "object" || value === null) return DEFAULT_PREFS;
	const record = value as Record<string, unknown>;
	return {
		open: record.open === true,
		width: typeof record.width === "number" ? clampWidth(record.width) : PANEL_WIDTH.initial,
		tab: record.tab === "scm" ? "scm" : "explorer",
	};
}

export function readPrefs(machine: string, workspace: string): PanelPrefs {
	try {
		return parsePrefs(window.localStorage.getItem(KEY(machine, workspace)));
	} catch {
		return DEFAULT_PREFS;
	}
}

export function writePrefs(machine: string, workspace: string, prefs: PanelPrefs): void {
	try {
		window.localStorage.setItem(KEY(machine, workspace), JSON.stringify(prefs));
	} catch {
		// Storage refused: the panel keeps its place for this page only.
	}
}

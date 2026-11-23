// The Live Map's stations in one table: the code the machine sends
// (apps/agent/src/observatory/live-map/station-map.ts), the copy key of its
// name (`observe.stations` in copy-*.ts), its icon and its place in lists. A
// later profile that renames stations (Git + CI/CD as "Publishing" for
// marketing work) changes this table and the copy, nothing else. A code this
// app does not know (a newer machine adds stations) is read as CORE.
import type { MachineIconName } from "../machine-icons.tsx";

export const STATION_CODES = ["CORE", "ORCHESTRATOR", "FILES", "MEMORY", "SKILLS", "MCP", "EXTERNAL", "SANDBOX", "TESTING", "GIT"] as const;

export type StationCode = (typeof STATION_CODES)[number];

export interface StationEntry {
	readonly code: StationCode;
	/** The key of its name under `observe.stations`. */
	readonly labelKey: StationCode;
	readonly icon: MachineIconName;
	/** Lists show stations by this, lowest first. */
	readonly order: number;
}

const entry = (code: StationCode, icon: MachineIconName): StationEntry => ({ code, labelKey: code, icon, order: STATION_CODES.indexOf(code) });

export const STATION_CATALOG: Readonly<Record<StationCode, StationEntry>> = {
	CORE: entry("CORE", "cpu"),
	ORCHESTRATOR: entry("ORCHESTRATOR", "ai-board"),
	FILES: entry("FILES", "folder"),
	MEMORY: entry("MEMORY", "repo"),
	SKILLS: entry("SKILLS", "ai-skills"),
	MCP: entry("MCP", "plug"),
	EXTERNAL: entry("EXTERNAL", "globe"),
	SANDBOX: entry("SANDBOX", "terminal"),
	TESTING: entry("TESTING", "check-circle"),
	GIT: entry("GIT", "branch"),
};

const KNOWN: ReadonlySet<string> = new Set(STATION_CODES);

function isStationCode(code: string): code is StationCode {
	return KNOWN.has(code);
}

/** The station a code names; CORE for an empty or unknown one. */
export function stationOf(code: string): StationCode {
	return isStationCode(code) ? code : "CORE";
}

/** The stations in list order. */
export function orderedStations(): readonly StationEntry[] {
	return STATION_CODES.map((code) => STATION_CATALOG[code]);
}

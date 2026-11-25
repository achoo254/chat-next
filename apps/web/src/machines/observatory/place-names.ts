// The name and icon of each place of the Live Map: a station's from its copy
// and catalog (observe.stations, station-catalog.ts), the three places
// without a station (input port, permission lock, context reservoir) from
// observe.map.
import type { MachinesCopy } from "../copy-vi.ts";
import type { MachineIconName } from "../machine-icons.tsx";
import { STATION_PLACE, type PlaceId } from "./render/scene-table.ts";
import { STATION_CATALOG, STATION_CODES, type StationCode } from "./station-catalog.ts";

export function placeNames(observe: MachinesCopy["observe"]): Readonly<Record<PlaceId, string>> {
	const s = observe.stations;
	return {
		core: s.CORE,
		orchestrator: s.ORCHESTRATOR,
		files: s.FILES,
		memory: s.MEMORY,
		skills: s.SKILLS,
		mcp: s.MCP,
		external: s.EXTERNAL,
		sandbox: s.SANDBOX,
		testing: s.TESTING,
		git: s.GIT,
		"user-desk": observe.map.userDesk,
		security: observe.map.gateway,
		monitoring: observe.map.monitoring,
	};
}

/** The station a place is, if one. */
export function stationAtPlace(place: PlaceId | null): StationCode | null {
	return STATION_CODES.find((code) => STATION_PLACE[code] === place) ?? null;
}

const OTHER_ICONS: Readonly<Partial<Record<PlaceId, MachineIconName>>> = { "user-desk": "user", security: "shield", monitoring: "gauge" };

export function placeIcon(place: PlaceId): MachineIconName {
	const station = stationAtPlace(place);
	return station === null ? (OTHER_ICONS[place] ?? "circle") : STATION_CATALOG[station].icon;
}

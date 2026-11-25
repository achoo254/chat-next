// The name of each place of the Live Map: a station's from its copy
// (observe.stations), the three places without a station (input port,
// permission lock, context reservoir) from observe.map.
import type { MachinesCopy } from "../copy-vi.ts";
import type { PlaceId } from "./render/scene-table.ts";

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

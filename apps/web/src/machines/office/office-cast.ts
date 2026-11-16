// Who is who in the office: each agent type keeps one friendly name, one
// accessory, one colour and one home room across every session. The names
// live in the copy (copy-*.ts, office.cast); an agent type this table does
// not know gets a colour hashed from its name into a fixed palette and a name
// built from the type itself. This palette is the only place the office
// hard-codes colours: characters must look the same in 2D and in 3D.
import type { RoomCode } from "./office-rooms.ts";
import type { ServiceKind } from "./office-state.ts";

/** The friendly names the copy carries (office.cast in copy-*.ts). */
export type CastKey = "scout" | "explore" | "generalPurpose" | "tester" | "codeReviewer" | "researcher" | "planner" | "debugger";

/** What a character holds or wears (the 3D scene attaches the prop; 2D only shows the colour). */
export type Accessory = "magnifier" | "map" | "toolbox" | "hardhat" | "glasses" | "books" | "clipboard" | "flashlight" | "none";

export interface CastEntry {
	/** null for a type the table does not know: the name is built from the type. */
	readonly key: CastKey | null;
	readonly accessory: Accessory;
	readonly color: string;
	/** Where the employee types and thinks (only replaces WORK). */
	readonly homeRoom: RoomCode;
}

interface Known {
	readonly key: CastKey;
	readonly accessory: Accessory;
	readonly color: string;
}

/** Agent types by their lower-case name. */
const KNOWN: Readonly<Record<string, Known>> = {
	scout: { key: "scout", accessory: "magnifier", color: "#2a9d8f" },
	explore: { key: "explore", accessory: "map", color: "#3f8f5f" },
	"general-purpose": { key: "generalPurpose", accessory: "toolbox", color: "#5b7bd5" },
	tester: { key: "tester", accessory: "hardhat", color: "#e9a23b" },
	"code-reviewer": { key: "codeReviewer", accessory: "glasses", color: "#8e6bd8" },
	researcher: { key: "researcher", accessory: "books", color: "#3a86c8" },
	planner: { key: "planner", accessory: "clipboard", color: "#4caf73" },
	plan: { key: "planner", accessory: "clipboard", color: "#4caf73" },
	debugger: { key: "debugger", accessory: "flashlight", color: "#d9534f" },
};

/** Colours of agent types the table does not know, picked by a hash of the name. */
export const UNKNOWN_PALETTE: readonly string[] = ["#c0607a", "#4f9da6", "#a07b3b", "#6a7fdb", "#b5652d", "#3d9970", "#9b59b6", "#d4813a", "#5a8f29", "#c2549d", "#2f7fa3", "#8c6d4f"];

/** The director, the user (chairman) and the machines. */
export const ROLE_COLORS = { director: "#2c3e66", chairman: "#8a6d1f", machine: "#5f6b7a" } as const;

/** A background service's robot by what it runs (a script keeps the machines' grey). */
export const SERVICE_COLORS: Readonly<Record<ServiceKind, string>> = {
	"dev-server": "#3d9970",
	"test-watch": "#9b59b6",
	build: "#d4813a",
	"ci-watch": "#2f7fa3",
	git: "#c0503f",
	database: "#6a7fdb",
	script: ROLE_COLORS.machine,
};

/** A stable 32-bit hash of the type's name (FNV-1a), so a colour never changes between sessions. */
export function nameHash(name: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** The home room of an agent type: planner, researcher, code-reviewer, tester and any "security" type have one; the rest work in WORK. */
export function homeRoomOf(agentType: string): RoomCode {
	const type = agentType.trim().toLowerCase();
	if (type.includes("security")) return "SECURITY";
	switch (type) {
		case "planner":
		case "plan":
			return "PLANNING";
		case "researcher":
			return "LIBRARY";
		case "code-reviewer":
			return "AUDIT";
		case "tester":
			return "QA";
		default:
			return "WORK";
	}
}

export function castOf(agentType: string): CastEntry {
	const type = agentType.trim().toLowerCase();
	const known = KNOWN[type];
	const homeRoom = homeRoomOf(type);
	if (known !== undefined) return { ...known, homeRoom };
	const color = UNKNOWN_PALETTE[nameHash(type) % UNKNOWN_PALETTE.length] ?? ROLE_COLORS.machine;
	return { key: null, accessory: "none", color, homeRoom };
}

/** A readable name from an agent type the copy does not name: "docs-manager" → "Docs Manager"; "" → "". */
export function nameFromType(agentType: string): string {
	return agentType
		.trim()
		.split(/[-_\s:/.]+/)
		.filter((word) => word !== "")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

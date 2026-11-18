// Who is who in the office: each agent type belongs to one of the 13 job titles
// of the studio (name, character model, colour, home room), the same across every session. The names
// live in the copy (copy-*.ts, office.cast); an agent type this table does
// not know gets a colour hashed from its name into a fixed palette and a name
// built from the type itself. This palette is the only place the office
// hard-codes colours: characters must look the same in 2D and in 3D.
import type { RoomCode } from "./office-rooms.ts";
import type { ServiceKind } from "./office-state.ts";

/** The job titles the copy names (office.cast in copy-*.ts): the 13 staff of the AI game studio. */
export type CastKey =
	| "producerPm"
	| "techLead"
	| "gameplayDeveloper"
	| "backendDevops"
	| "gameDesigner"
	| "uiUxDesigner"
	| "artist"
	| "qaTester"
	| "codeSecurityReviewer"
	| "contentMarketing"
	| "growthAnalytics"
	| "researchAnalyst"
	| "financeController";

/** What a character holds or wears (the 3D scene attaches the prop; 2D only shows the colour). */
export type Accessory = "magnifier" | "map" | "toolbox" | "hardhat" | "glasses" | "books" | "clipboard" | "flashlight" | "none";

export interface CastEntry {
	/** null for a type no job title claims: the name is built from the type, and it works as the fallback title (Gameplay Developer's model). */
	readonly key: CastKey | null;
	readonly accessory: Accessory;
	readonly color: string;
	/** Where the employee types and thinks (only replaces WORK). */
	readonly homeRoom: RoomCode;
	/** The character model of the job title (a key of office-assets.json staffCharacters). */
	readonly model: string;
}

interface Title {
	readonly key: CastKey;
	/** The built character model of the title. */
	readonly model: string;
	readonly color: string;
	readonly homeRoom: RoomCode;
	/** Agent types by their lower-case name. */
	readonly types: readonly string[];
	/** Starts of a word in an unknown type's name that send the type to this title. */
	readonly words: readonly string[];
}

/**
 * The 13 staff of the studio (tools/office-art/staff-cast.json in the workspace holds the same table). Order matters for
 * the words: the first title with a matching word claims an unknown type, so "security" is the reviewer's before anything else.
 */
const TITLES: readonly Title[] = [
	{ key: "codeSecurityReviewer", model: "code-reviewer", color: "#6b6f78", homeRoom: "AUDIT", types: ["code-reviewer", "content-reviewer", "security", "cti-expert"], words: ["security", "review", "audit", "cti", "vuln"] },
	{ key: "qaTester", model: "tester", color: "#5cc3a0", homeRoom: "WORK", types: ["tester"], words: ["test", "qa"] },
	{ key: "backendDevops", model: "it-operator", color: "#f08a24", homeRoom: "SERVER", types: ["git-manager", "database-admin", "devops", "deploy"], words: ["git", "deploy", "devops", "database", "backend", "server", "infra", "release"] },
	{ key: "uiUxDesigner", model: "ui-ux-designer", color: "#d9a520", homeRoom: "WORK", types: ["ui-ux-designer"], words: ["ui", "ux", "interface"] },
	{ key: "artist", model: "artist", color: "#c9b27a", homeRoom: "WORK", types: [], words: ["artist", "illustrat", "image", "3d", "texture"] },
	{ key: "gameDesigner", model: "game-designer", color: "#e0594f", homeRoom: "PLANNING", types: ["brainstormer"], words: ["design", "level", "balance", "brainstorm"] },
	{ key: "producerPm", model: "planner", color: "#b07a4a", homeRoom: "PLANNING", types: ["planner", "plan", "project-manager", "journal-writer"], words: ["plan", "project", "produc", "journal", "roadmap"] },
	{ key: "researchAnalyst", model: "researcher", color: "#7a5a3a", homeRoom: "LIBRARY", types: ["researcher", "docs-seeker", "claude-code-guide"], words: ["research", "seek", "guide", "lookup"] },
	{ key: "techLead", model: "tech-lead", color: "#6fa8dc", homeRoom: "WORK", types: ["scout", "scout-external", "explore", "code-simplifier"], words: ["tech", "scout", "explor", "simplif", "architect"] },
	{
		key: "growthAnalytics",
		model: "data-analyst",
		color: "#2a9d9a",
		homeRoom: "LIBRARY",
		types: ["analytics-analyst", "funnel-architect", "lead-qualifier", "sale-enabler", "upsell-maximizer", "campaign-manager", "continuity-specialist", "attraction-specialist"],
		words: ["data", "analytic", "growth", "funnel", "lead", "sale", "campaign", "upsell", "attraction", "continuity"],
	},
	{
		key: "contentMarketing",
		model: "content-writer",
		color: "#e58fa8",
		homeRoom: "PLANNING",
		types: ["content-creator", "copywriter", "social-media-manager", "email-wizard", "seo-specialist", "docs-manager", "community-manager"],
		words: ["content", "copy", "seo", "social", "email", "doc", "market", "writ", "communit"],
	},
	{ key: "financeController", model: "finance-accountant", color: "#3f8a4f", homeRoom: "AUDIT", types: [], words: ["financ", "cost", "token", "budget"] },
	{ key: "gameplayDeveloper", model: "fullstack-developer", color: "#7a7f87", homeRoom: "WORK", types: ["fullstack-developer", "debugger", "campaign-debugger", "statusline-setup", "general-purpose"], words: ["debug", "fix", "bug", "develop", "implement", "code"] },
];

/**
 * The permanent staff of the office: one person per job title, always in the building (office-placement.ts). `homeKey` is the
 * staff key the layout's anchors carry as `home` (tools/office-art/staff-cast.json); `repType` is the agent type the person
 * goes by (their name, model and colour come from it).
 */
export interface StudioTitle {
	readonly key: CastKey;
	readonly homeKey: string;
	readonly repType: string;
	readonly homeRoom: RoomCode;
}

const TITLE_META: Readonly<Record<CastKey, { readonly homeKey: string; readonly repType: string }>> = {
	producerPm: { homeKey: "producer-pm", repType: "planner" },
	techLead: { homeKey: "tech-lead", repType: "scout" },
	gameplayDeveloper: { homeKey: "gameplay-developer", repType: "fullstack-developer" },
	backendDevops: { homeKey: "backend-devops", repType: "devops" },
	gameDesigner: { homeKey: "game-designer", repType: "brainstormer" },
	uiUxDesigner: { homeKey: "ui-ux-designer", repType: "ui-ux-designer" },
	artist: { homeKey: "artist-2d-3d", repType: "artist" },
	qaTester: { homeKey: "qa-tester", repType: "tester" },
	codeSecurityReviewer: { homeKey: "code-security-reviewer", repType: "code-reviewer" },
	contentMarketing: { homeKey: "content-marketing", repType: "content-creator" },
	growthAnalytics: { homeKey: "growth-analytics", repType: "analytics-analyst" },
	researchAnalyst: { homeKey: "research-analyst", repType: "researcher" },
	financeController: { homeKey: "ai-finance-controller", repType: "finance" },
};

/** The 13 permanent staff, in the table's order. */
export const STUDIO_TITLES: readonly StudioTitle[] = TITLES.map((t) => ({ key: t.key, homeKey: TITLE_META[t.key].homeKey, repType: TITLE_META[t.key].repType, homeRoom: t.homeRoom }));

/** The title an agent type belongs to; one no title claims is the Gameplay Developer's (the hands-on fallback). */
export function titleKeyOf(agentType: string): CastKey {
	return titleOf(agentType.trim().toLowerCase())?.key ?? "gameplayDeveloper";
}

/** Backend & DevOps is always on duty in the server room: never at rest, never away. */
export const ALWAYS_ON_DUTY: CastKey = "backendDevops";

/** The model of unknown types: the hands-on Gameplay Developer's. */
const FALLBACK_MODEL = "fullstack-developer";

const BY_TYPE: ReadonlyMap<string, Title> = new Map(TITLES.flatMap((title) => title.types.map((type) => [type, title] as const)));

function titleOf(type: string): Title | null {
	const exact = BY_TYPE.get(type);
	if (exact !== undefined) return exact;
	const words = type.split(/[-_\s:/.]+/).filter((w) => w !== "");
	return TITLES.find((title) => title.words.some((prefix) => words.some((w) => w.startsWith(prefix)))) ?? null;
}

/** Colours of agent types the table does not know, picked by a hash of the name. */
export const UNKNOWN_PALETTE: readonly string[] = ["#c0607a", "#4f9da6", "#a07b3b", "#6a7fdb", "#b5652d", "#3d9970", "#9b59b6", "#d4813a", "#5a8f29", "#c2549d", "#2f7fa3", "#8c6d4f"];

/** The director and the user (chairman). */
export const ROLE_COLORS = { director: "#2c3e66", chairman: "#8a6d1f" } as const;

/** A neutral grey for the indexed palette read's type (the hashed index is always in range). */
const FALLBACK_COLOR = "#5f6b7a";

/**
 * Whose work a background service is, by what it runs: the dev server, builds
 * and databases are Backend & DevOps's, test watchers QA's, CI watching the
 * Tech Lead's, git and any other script (or a kind the agent did not send) the
 * Gameplay Developer's.
 */
const SERVICE_OWNERS: Readonly<Record<ServiceKind, CastKey>> = {
	"dev-server": "backendDevops",
	build: "backendDevops",
	database: "backendDevops",
	"test-watch": "qaTester",
	"ci-watch": "techLead",
	git: "gameplayDeveloper",
	script: "gameplayDeveloper",
};

/** The job title a background service's run is shown on; an unlabelled one (an older agent's) is the Gameplay Developer's. */
export function serviceOwnerOf(kind: ServiceKind | null | undefined): CastKey {
	return kind === null || kind === undefined ? "gameplayDeveloper" : SERVICE_OWNERS[kind];
}

/** A stable 32-bit hash of the type's name (FNV-1a), so a colour never changes between sessions. */
export function nameHash(name: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** The home room of an agent type: its job title's room (a security type works at AUDIT, git and deploy at SERVER, ...); unknown types work in WORK. */
export function homeRoomOf(agentType: string): RoomCode {
	return titleOf(agentType.trim().toLowerCase())?.homeRoom ?? "WORK";
}

export function castOf(agentType: string): CastEntry {
	const type = agentType.trim().toLowerCase();
	const title = titleOf(type);
	if (title !== null) return { key: title.key, accessory: "none", color: title.color, homeRoom: title.homeRoom, model: title.model };
	const color = UNKNOWN_PALETTE[nameHash(type) % UNKNOWN_PALETTE.length] ?? FALLBACK_COLOR;
	return { key: null, accessory: "none", color, homeRoom: "WORK", model: FALLBACK_MODEL };
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

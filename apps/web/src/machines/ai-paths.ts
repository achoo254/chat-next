// Paths of AI Agent that only its own screens link to (the shared ones are
// in router.tsx, which loads at startup), and the move from /machines to
// /ai: the router still opens the old paths (links, bookmarks, pushes of
// older servers); the screen then replaces the address with the new one. A
// session's /office (the view Observe replaced) moves to its /observe.

/** A moment of an observed session to open at (`?at=<ms>`), and an event to point at (`&event=<id>`). */
export interface ObserveFocus {
	readonly at?: number;
	readonly event?: string;
}

function focusQuery(focus: ObserveFocus): string {
	const query = new URLSearchParams();
	if (focus.at !== undefined) query.set("at", String(focus.at));
	if (focus.event !== undefined && focus.event !== "") query.set("event", focus.event);
	const text = query.toString();
	return text === "" ? "" : `?${text}`;
}

/** The moment and event of an Observe address's query; an `at` that is not a whole number of milliseconds is left out. */
export function observeFocus(search: string): ObserveFocus {
	const query = new URLSearchParams(search);
	const at = Number(query.get("at") ?? "");
	const event = query.get("event") ?? "";
	return { ...(query.has("at") && Number.isSafeInteger(at) && at >= 0 ? { at } : {}), ...(event === "" ? {} : { event }) };
}

export const aiPaths = {
	/** The "Cần bạn" board of every machine. */
	need: "/ai/need",
	/** «Liên hệ»: Chat's people and groups, their sessions and the pushing of their new messages. */
	contacts: "/ai/contacts",
	/** The machines: list, adding, pairing, details. */
	manage: "/ai/machines",
	/** A session in its AI's own CLI, in the machine's terminal. */
	sessionTerminal: (machine: string, threadId: string) => `/ai/${machine}/s/${encodeURIComponent(threadId)}/terminal`,
	/** A session in the machine's terminal with one of its tabs in front (the dock's tab id). */
	sessionTab: (machine: string, threadId: string, tab: string) => `/ai/${machine}/s/${encodeURIComponent(threadId)}/terminal?tab=${encodeURIComponent(tab)}`,
	/** A session's "Quan sát": the Live Map of its Claude Code session (view only), optionally at a moment and an event. */
	sessionObserve: (machine: string, threadId: string, focus: ObserveFocus = {}) => `/ai/${machine}/s/${encodeURIComponent(threadId)}/observe${focusQuery(focus)}`,
	/** The Live Map of one of the machine's Claude Code sessions by its own id (a session no thread holds: the CLI, a terminal). */
	observeSession: (machine: string, sessionId: string, focus: ObserveFocus = {}) => `/ai/${machine}/observe/${encodeURIComponent(sessionId)}${focusQuery(focus)}`,
	/** The machine's terminal opening one more plain shell in `cwd` ("" for the home folder). */
	newShell: (machine: string, cwd: string) => `/ai/${machine}/terminal?new=${encodeURIComponent(cwd)}`,
	/** The machine's terminal showing one of its sessions (a plain shell no tab here shows). */
	showSession: (machine: string, session: number) => `/ai/${machine}/terminal?open=${session}`,
} as const;

/** A session's old office path (/ai or /machines): what follows the machine id. */
const OFFICE_PATH = /^\/(?:ai|machines)\/[^/]+\/s\/[^/]+\/office\/?$/;

/** The current path for an old one (with its query): /machines as /ai, a session's /office as its /observe; null for any other path. */
export function canonicalAiPath(pathname: string, search = ""): string | null {
	const office = OFFICE_PATH.test(pathname);
	if (!office && pathname !== "/machines" && !pathname.startsWith("/machines/")) return null;
	const ai = pathname.startsWith("/machines") ? `/ai${pathname.slice("/machines".length)}` : pathname;
	return `${office ? ai.replace(/\/office\/?$/, "/observe") : ai}${search}`;
}

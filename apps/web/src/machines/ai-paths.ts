// Paths of AI Agent that only its own screens link to (the shared ones are
// in router.tsx, which loads at startup), and the move from /machines to
// /ai: the router still opens the old paths (links, bookmarks, pushes of
// older servers); the screen then replaces the address with the new one.

export const aiPaths = {
	/** The "Cần bạn" board of every machine. */
	need: "/ai/need",
	/** The machines: list, adding, pairing, details. */
	manage: "/ai/machines",
} as const;

/** The /ai path for an old /machines one (with its query); null for any other path. */
export function canonicalAiPath(pathname: string, search = ""): string | null {
	if (pathname !== "/machines" && !pathname.startsWith("/machines/")) return null;
	return `/ai${pathname.slice("/machines".length)}${search}`;
}

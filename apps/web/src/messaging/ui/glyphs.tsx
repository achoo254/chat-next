// Icons only the messaging screens loaded on demand use (paths from
// mockups/assets/mock.js). Kept apart from components/icon.tsx so the R0
// entry chunk does not carry them; drawn the same way as <Icon>. The contacts
// icon is in contacts-glyph.tsx (first screen).
import type { ReactElement } from "react";

const PATHS = {
	"user-check": (
		<>
			<circle cx="9" cy="7" r="4" />
			<path d="M3 21v-2a4 4 0 0 1 4-4h4M15 19l2 2 4-4" />
		</>
	),
	"user-minus": (
		<>
			<circle cx="9" cy="7" r="4" />
			<path d="M3 21v-2a4 4 0 0 1 4-4h4M16 19h6" />
		</>
	),
	crown: <path d="M12 6l4 6 5-4-2 10H5L3 8l5 4z" />,
	/** A bot's Mini App (inline Mini App buttons). */
	apps: (
		<>
			<rect x="4" y="4" width="6" height="6" rx="1" />
			<rect x="14" y="4" width="6" height="6" rx="1" />
			<rect x="4" y="14" width="6" height="6" rx="1" />
			<path d="M14 17h6M17 14v6" />
		</>
	),
	refresh: <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" />,
	key: (
		<>
			<circle cx="8" cy="15" r="4" />
			<path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2" />
		</>
	),
} satisfies Record<string, ReactElement>;

export type GlyphName = keyof typeof PATHS;

/** Decorative icon; give the surrounding control its accessible name. */
export function Glyph({ name, small = false }: { name: GlyphName; small?: boolean }) {
	return (
		<svg className={small ? "icon icon-sm" : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}

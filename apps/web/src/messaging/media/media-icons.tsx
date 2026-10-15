// Icons only the media screens use (paths from mockups/media.html), kept
// out of the shared icon set so they load with those screens.
import type { ReactElement } from "react";

const PATHS = {
	play: <path d="M7 4v16l13-8z" />,
	pause: (
		<>
			<rect x="6" y="5" width="4" height="14" rx="1" />
			<rect x="14" y="5" width="4" height="14" rx="1" />
		</>
	),
	download: <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12" />,
	"zoom-in": (
		<>
			<circle cx="10" cy="10" r="7" />
			<path d="M7 10h6M10 7v6M21 21l-6-6" />
		</>
	),
	"zoom-out": (
		<>
			<circle cx="10" cy="10" r="7" />
			<path d="M7 10h6M21 21l-6-6" />
		</>
	),
	"chevron-left": <path d="M15 6l-6 6 6 6" />,
	"chevron-right": <path d="M9 6l6 6-6 6" />,
	video: (
		<>
			<path d="M15 10l4.6-2.3A1 1 0 0 1 21 8.6v6.8a1 1 0 0 1-1.4.9L15 14" />
			<rect x="3" y="6" width="12" height="12" rx="2" />
		</>
	),
	stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
} satisfies Record<string, ReactElement>;

export type MediaIconName = keyof typeof PATHS;

/** Decorative icon; the surrounding control carries the accessible name. */
export function MediaIcon({ name, small = false }: { name: MediaIconName; small?: boolean }) {
	return (
		<svg className={small ? "icon icon-sm" : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}

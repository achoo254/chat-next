// Every icon of the app, for screens loaded on demand: the first screen's set
// (icon.tsx) and the icons only these screens draw, which stay out of the
// first chunk. Same API as icon.tsx; code of the first screen imports that one.
import type { ReactElement } from "react";
import { iconSvg, PATHS as STARTUP_PATHS } from "./icon.tsx";

export const SCREEN_PATHS = {
	shield: <path d="M12 3a12 12 0 0 0 8.5 3A12 12 0 0 1 12 21 12 12 0 0 1 3.5 6 12 12 0 0 0 12 3" />,
	laptop: (
		<>
			<rect x="5" y="5" width="14" height="10" rx="1" />
			<path d="M3 19h18" />
		</>
	),
	mobile: (
		<>
			<rect x="6" y="3" width="12" height="18" rx="2" />
			<path d="M11 4h2M12 17h.01" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" />
		</>
	),
	external: <path d="M12 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M11 13l9-9M15 4h5v5" />,
	logout: <path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M9 12h12l-3-3M18 15l3-3" />,
	key: (
		<>
			<circle cx="15" cy="9" r="4" />
			<path d="M12 12l-8 8v2h3v-2h2v-2h2l1.5-1.5" />
		</>
	),
	download: <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12" />,
	trash: <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />,
	link: <path d="M9 15l6-6M11 6l.5-.5a5 5 0 0 1 7 7l-.5.5M13 18l-.4.5a5 5 0 0 1-7.1 0 5 5 0 0 1 0-7l.5-.5" />,
	"alert-triangle": <path d="M12 9v4M10.4 3.6L2.3 17.1A1.9 1.9 0 0 0 3.9 20h16.2a1.9 1.9 0 0 0 1.6-2.9L13.6 3.6a1.9 1.9 0 0 0-3.2 0zM12 16h.01" />,
	eye: (
		<>
			<circle cx="12" cy="12" r="2" />
			<path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6" />
		</>
	),
	"eye-off": <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8M16.7 16.7A8.7 8.7 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.3-2.1 2.7-3.7 4.3-4.7M10.2 6.2A9 9 0 0 1 12 6c3.6 0 6.6 2 9 6-.7 1.1-1.4 2.1-2.1 2.9M3 3l18 18" />,
	plug: <path d="M9.8 6L18 14.2l-2 2.1a5.8 5.8 0 1 1-8.3-8.3zM4 20l3.5-3.5M15 4l-3.5 3.5M20 9l-3.5 3.5" />,
	"chevron-right": <path d="M9 6l6 6-6 6" />,
	"chevron-down": <path d="M6 9l6 6 6-6" />,
	refresh: <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />,
	minimize: <path d="M5 18h14" />,
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M3 12h1M12 3v1M20 12h1M12 20v1M5.6 5.6l.7.7M18.4 5.6l-.7.7M17.7 17.7l.7.7M6.3 17.7l-.7.7" />
		</>
	),
	file: <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />,
	camera: (
		<>
			<path d="M5 7h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1h6a1 1 0 0 1 1 1 2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2" />
			<circle cx="12" cy="13" r="3" />
		</>
	),
	photo: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="3" />
			<path d="M15 8h.01M3 16l5-5c.9-.9 2.1-.9 3 0l5 5M14 14l1-1c.9-.9 2.1-.9 3 0l3 3" />
		</>
	),
} satisfies Record<string, ReactElement>;

const PATHS = { ...STARTUP_PATHS, ...SCREEN_PATHS };

export type IconName = keyof typeof PATHS;

/** Decorative icon; give the surrounding control its accessible name. */
export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
	return iconSvg(PATHS[name], small);
}

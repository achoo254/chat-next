// Tabler-style outline icons used by the app (paths from the approved mockups).
import type { ReactElement } from "react";

const PATHS = {
	message: <path d="M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12z" />,
	search: (
		<>
			<circle cx="10" cy="10" r="7" />
			<path d="M21 21l-6-6" />
		</>
	),
	settings: (
		<>
			<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h11M19 18h1" />
			<circle cx="14" cy="6" r="2" />
			<circle cx="8" cy="12" r="2" />
			<circle cx="17" cy="18" r="2" />
		</>
	),
	shield: <path d="M12 3a12 12 0 0 0 8.5 3A12 12 0 0 1 12 21 12 12 0 0 1 3.5 6 12 12 0 0 0 12 3" />,
	user: (
		<>
			<circle cx="12" cy="7" r="4" />
			<path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
		</>
	),
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
	alert: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 8v4M12 16h.01" />
		</>
	),
	check: <path d="M5 12l5 5L20 7" />,
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 9h.01M11 12h1v4h1" />
		</>
	),
	lock: (
		<>
			<rect x="5" y="11" width="14" height="10" rx="2" />
			<path d="M8 11V7a4 4 0 1 1 8 0v4" />
		</>
	),
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

/** Decorative icon; give the surrounding control its accessible name. */
export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
	return (
		<svg className={small ? "icon icon-sm" : "icon"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}

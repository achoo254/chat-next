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
	send: <path d="M10 14L21 3M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3" />,
	smile: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
		</>
	),
	dots: (
		<>
			<circle cx="12" cy="5" r="1" />
			<circle cx="12" cy="12" r="1" />
			<circle cx="12" cy="19" r="1" />
		</>
	),
	checks: <path d="M7 12l5 5L22 7M2 12l5 5m5-5l5-5" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 3" />
		</>
	),
	pin: <path d="M15 4.5l-4 4L7 10l-1.5 1.5 7 7L14 17l1.5-4 4-4M9 15l-4.5 4.5M14.5 4L20 9.5" />,
	bell: <path d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1" />,
	download: <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12" />,
	"bell-off": <path d="M9.3 5.2A2 2 0 0 1 14 5a7 7 0 0 1 4 6v3M17 17H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 1.4-4.2M9 17v1a3 3 0 0 0 6 0v-1M3 3l18 18" />,
	robot: (
		<>
			<rect x="6" y="4" width="12" height="8" rx="2" />
			<path d="M12 2v2M9 12v9M15 12v9M5 16l4-2M15 14l4 2M9 18h6M10 8h.01M14 8h.01" />
		</>
	),
	webhook: <path d="M4.9 13.6A4 4 0 1 0 11 17h6M15.1 20.5A4 4 0 1 0 17 13c-.7 0-1.4.2-2 .5l-3-5.5M16 8a4 4 0 1 0-8 0c0 1.5.8 2.8 2 3.5L7 17" />,
	back: <path d="M5 12h14M5 12l6 6M5 12l6-6" />,
	x: <path d="M18 6L6 18M6 6l12 12" />,
	plus: <path d="M12 5v14M5 12h14" />,
	reply: <path d="M9 14l-4-4 4-4M5 10h11a4 4 0 1 1 0 8h-1" />,
	forward: <path d="M15 14l4-4-4-4M19 10H8a4 4 0 1 0 0 8h1" />,
	copy: (
		<>
			<rect x="8" y="8" width="12" height="12" rx="2" />
			<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
		</>
	),
	edit: <path d="M7 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1M20.4 6.6a2.1 2.1 0 0 0-3-3L9 12v3h3l8.4-8.4zM16 5l3 3" />,
	trash: <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />,
	users: (
		<>
			<circle cx="9" cy="7" r="4" />
			<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9" />
		</>
	),
	"user-plus": (
		<>
			<circle cx="9" cy="7" r="4" />
			<path d="M3 21v-2a4 4 0 0 1 4-4h4M16 19h6M19 16v6" />
		</>
	),
	link: <path d="M9 15l6-6M11 6l.5-.5a5 5 0 0 1 7 7l-.5.5M13 18l-.4.5a5 5 0 0 1-7.1 0 5 5 0 0 1 0-7l.5-.5" />,
	code: <path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" />,
	"alert-triangle": <path d="M12 9v4M10.4 3.6L2.3 17.1A1.9 1.9 0 0 0 3.9 20h16.2a1.9 1.9 0 0 0 1.6-2.9L13.6 3.6a1.9 1.9 0 0 0-3.2 0zM12 16h.01" />,
	"wifi-off": <path d="M12 18h.01M9.2 15.2a4 4 0 0 1 5.6 0M6.3 12.3a8 8 0 0 1 3.9-2.1M14.4 10.4a8 8 0 0 1 3.3 2M3.5 9.5a12 12 0 0 1 3.5-2.4M10.2 6.1a12 12 0 0 1 10.3 3.4M3 3l18 18" />,
	flag: <path d="M5 5a5 5 0 0 1 7 0 5 5 0 0 0 7 0v9a5 5 0 0 1-7 0 5 5 0 0 0-7 0V5zM5 21v-7" />,
	ban: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M5.7 5.7l12.6 12.6" />
		</>
	),
	eye: (
		<>
			<circle cx="12" cy="12" r="2" />
			<path d="M21 12c-2.4 4-5.4 6-9 6s-6.6-2-9-6c2.4-4 5.4-6 9-6s6.6 2 9 6" />
		</>
	),
	"eye-off": <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8M16.7 16.7A8.7 8.7 0 0 1 12 18c-3.6 0-6.6-2-9-6 1.3-2.1 2.7-3.7 4.3-4.7M10.2 6.2A9 9 0 0 1 12 6c3.6 0 6.6 2 9 6-.7 1.1-1.4 2.1-2.1 2.9M3 3l18 18" />,
	inbox: (
		<>
			<rect x="4" y="4" width="16" height="16" rx="2" />
			<path d="M4 13h3l3 3h4l3-3h3" />
		</>
	),
	cloud: <path d="M7 18a4.6 4.4 0 0 1 0-8.8 5 4.5 0 0 1 9.8 1H18a3.5 3.5 0 0 1 0 7.8H7z" />,
	"chevron-right": <path d="M9 6l6 6-6 6" />,
	"chevron-down": <path d="M6 9l6 6 6-6" />,
	"message-dot": (
		<>
			<path d="M8 9h5M8 13h6M14 4H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h2v3l5-3h5a3 3 0 0 0 3-3v-4" />
			<circle cx="19" cy="5" r="2.5" />
		</>
	),
	sun: (
		<>
			<circle cx="12" cy="12" r="4" />
			<path d="M3 12h1M12 3v1M20 12h1M12 20v1M5.6 5.6l.7.7M18.4 5.6l-.7.7M17.7 17.7l.7.7M6.3 17.7l-.7.7" />
		</>
	),
	command: <path d="M7 9a2 2 0 1 1 2-2v10a2 2 0 1 1-2-2h10a2 2 0 1 1-2 2V7a2 2 0 1 1 2 2H7" />,
	megaphone: <path d="M18 8a3 3 0 0 1 0 6M10 8v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-5M12 8l4.5-3.8a.9.9 0 0 1 1.5.7v12.2a.9.9 0 0 1-1.5.7L12 14H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h8" />,
	hash: <path d="M5 9h14M5 15h14M11 4L7 20M17 4l-4 16" />,
	"arrow-down": <path d="M12 5v14M18 13l-6 6M6 13l6 6" />,
	file: <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />,
	database: (
		<>
			<ellipse cx="12" cy="6" rx="8" ry="3" />
			<path d="M4 6v6a8 3 0 0 0 16 0V6M4 12v6a8 3 0 0 0 16 0v-6" />
		</>
	),
	clip: <path d="M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3L18 10a3 3 0 0 0-6-6l-6.5 6.5a4.5 4.5 0 0 0 9 9L21 13" />,
	photo: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="3" />
			<path d="M15 8h.01M3 16l5-5c.9-.9 2.1-.9 3 0l5 5M14 14l1-1c.9-.9 2.1-.9 3 0l3 3" />
		</>
	),
	mic: (
		<>
			<rect x="9" y="2" width="6" height="11" rx="3" />
			<path d="M5 10a7 7 0 0 0 14 0M8 21h8M12 17v4" />
		</>
	),
	upload: <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 9l5-5 5 5M12 4v12" />,
	keyboard: (
		<>
			<rect x="2" y="6" width="20" height="12" rx="2" />
			<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4" />
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

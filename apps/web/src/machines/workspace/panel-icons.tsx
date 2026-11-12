// Icons only the workspace panel draws (Tabler-style outlines), kept in the
// panel's chunk. Shared shapes (folder, chevrons, branch, terminal, spark)
// come from MachineIcon.
import type { ReactElement } from "react";
import { iconSvg } from "../../components/icon.tsx";

const PATHS = {
	files: <path d="M15 3v4a1 1 0 0 0 1 1h4M18 17h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l5 5v7a2 2 0 0 1-2 2zM16 17v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2" />,
	git: (
		<>
			<circle cx="6" cy="6" r="2" />
			<circle cx="18" cy="18" r="2" />
			<circle cx="6" cy="18" r="2" />
			<path d="M6 8v8M8 6h5a5 5 0 0 1 5 5v5" />
		</>
	),
	refresh: <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" />,
	collapse: <path d="M4 4h16v16H4zM8 12h8" />,
	more: (
		<>
			<circle cx="5" cy="12" r="1" />
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
		</>
	),
	plus: <path d="M12 5v14M5 12h14" />,
	minus: <path d="M5 12h14" />,
	undo: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
	lock: (
		<>
			<rect x="5" y="11" width="14" height="10" rx="2" />
			<path d="M8 11V7a4 4 0 1 1 8 0v4" />
		</>
	),
	file: <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />,
	"file-code": <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM10 13l-1 2 1 2M14 13l1 2-1 2" />,
	"file-text": <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 9h1M9 13h6M9 17h6" />,
	"file-data": <path d="M14 3v4a1 1 0 0 0 1 1h4M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM9 12h.01M12 12h3M9 16h.01M12 16h3" />,
	photo: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<circle cx="9" cy="10" r="1.5" />
			<path d="M21 16l-5-5-9 9" />
		</>
	),
	"folder-open": <path d="M5 19l2.8-7.5A2 2 0 0 1 9.7 10H20a1 1 0 0 1 1 1.3L19 18a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2" />,
	link: <path d="M9 15l6-6M11 6l.5-.5a5 5 0 0 1 7 7l-.5.5M13 18l-.4.5a5 5 0 0 1-7-7l.4-.5" />,
	"pull-request": (
		<>
			<circle cx="6" cy="6" r="2" />
			<circle cx="6" cy="18" r="2" />
			<circle cx="18" cy="18" r="2" />
			<path d="M6 8v8M11 6h5a2 2 0 0 1 2 2v8M14 3l-3 3 3 3" />
		</>
	),
	fetch: <path d="M7 18a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7M12 13v9M9 19l3 3 3-3" />,
	"arrow-down": <path d="M12 5v14M18 13l-6 6-6-6" />,
	"arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
	x: <path d="M18 6L6 18M6 6l12 12" />,
	check: <path d="M5 12l5 5L20 7" />,
	search: (
		<>
			<circle cx="10" cy="10" r="7" />
			<path d="M21 21l-6-6" />
		</>
	),
	"case-sensitive": <path d="M3 18V9.5a3.5 3.5 0 0 1 7 0V18M3 13h7M17.5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20.5 12v6" />,
	"whole-word": <path d="M4 15v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2M7 13V8.5a2 2 0 0 1 4 0V13M7 11h4M15 13V6M15 11a2 2 0 1 0 4 0 2 2 0 0 0-4 0" />,
	regex: <path d="M4 15h5v5H4zM17 4v6M14.4 5.5l5.2 3M14.4 8.5l5.2-3" />,
	commit: (
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M12 3v6M12 15v6" />
		</>
	),
} satisfies Record<string, ReactElement>;

export type PanelIconName = keyof typeof PATHS;

/** Decorative icon; the surrounding control carries the accessible name. */
export function PanelIcon({ name, small = false }: { name: PanelIconName; small?: boolean }) {
	return iconSvg(PATHS[name], small);
}

// Icons only AI Agent draws (paths from the mock), kept out of the
// shared sets. The chat's startup draws only "cpu", from cpu-icon.tsx.
import type { ReactElement } from "react";
import { iconSvg } from "../components/icon.tsx";
import { CPU_PATH } from "./cpu-icon.tsx";

const PATHS = {
	cpu: CPU_PATH,
	monitor: (
		<>
			<rect x="3" y="4" width="18" height="12" rx="2" />
			<path d="M8 20h8M12 16v4" />
		</>
	),
	laptop: (
		<>
			<rect x="4" y="5" width="16" height="11" rx="1.5" />
			<path d="M2 19h20" />
		</>
	),
	terminal: (
		<>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M7 9l3 3-3 3M12 15h5" />
		</>
	),
	chat: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />,
	pencil: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />,
	folder: <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z" />,
	project: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9" />,
	stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
	help: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
		</>
	),
	star: <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z" />,
	"chevron-right": <path d="M9 6l6 6-6 6" />,
	"chevron-down": <path d="M6 9l6 6 6-6" />,
	"arrow-up": <path d="M12 19V5M6 11l6-6 6 6" />,
	globe: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" />
		</>
	),
	plug: <path d="M9.8 6L18 14.2l-2 2.1a5.8 5.8 0 1 1-8.3-8.3zM4 20l3.5-3.5M15 4l-3.5 3.5M20 9l-3.5 3.5" />,
	branch: (
		<>
			<circle cx="6" cy="6" r="2" />
			<circle cx="6" cy="18" r="2" />
			<circle cx="18" cy="8" r="2" />
			<path d="M6 8v8M18 10a6 6 0 0 1-6 6H8" />
		</>
	),
	list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
	user: (
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 20a8 8 0 0 1 16 0" />
		</>
	),
	gauge: <path d="M4 18a8 8 0 1 1 16 0M12 18l4-6" />,
	// A session's state in the AI Agent column (status-glyph): working, done, needs the user, failed, idle.
	spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
	"check-circle": (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M8 12.5l2.5 2.5L16 9.5" />
		</>
	),
	"alert-circle": (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7.5v5.5M12 16.5h.01" />
		</>
	),
	"x-circle": (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M9 9l6 6M15 9l-6 6" />
		</>
	),
	circle: <circle cx="12" cy="12" r="8" />,
	// The session's AI (any provider): a spark.
	spark: <path d="M12 3c.5 4.5 2 6.5 6.5 7-.1.1 0 0 0 0-4.5.5-6 2.5-6.5 7-.5-4.5-2-6.5-6.5-7 4.5-.5 6-2.5 6.5-7z" />,
	shield: <path d="M12 3a12 12 0 0 0 8.5 3A12 12 0 0 1 12 21 12 12 0 0 1 3.5 6 12 12 0 0 0 12 3" />,
} satisfies Record<string, ReactElement>;

export type MachineIconName = keyof typeof PATHS;

/** Decorative icon; the surrounding control carries the accessible name. */
export function MachineIcon({ name, small = false }: { name: MachineIconName; small?: boolean }) {
	return iconSvg(PATHS[name], small);
}

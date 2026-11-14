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
	// A project with a git repository.
	repo: (
		<>
			<path d="M5 19V5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2a2 2 0 0 0 2 2h12" />
			<path d="M9 7h6" />
		</>
	),
	// A project without one.
	box: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5" />,
	// A git worktree.
	worktree: (
		<>
			<circle cx="12" cy="18" r="2" />
			<circle cx="7" cy="6" r="2" />
			<circle cx="17" cy="6" r="2" />
			<path d="M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8M12 12v4" />
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
	// Each AI's own mark while it works (status-glyph; its motion is in machines.css): Claude's burst, Codex's ring of dots, and a star for
	// Antigravity that machines.css hides under its AI-drawn mark (run-antigravity.webp), kept for a browser without CSS masks.
	"run-claude": <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2L18 18M6 18l2.8-2.8M15.2 8.8L18 6" />,
	"run-antigravity": <path d="M12 3c.5 4.5 2 6.5 6.5 7-4.5.5-6 2.5-6.5 7-.5-4.5-2-6.5-6.5-7 4.5-.5 6-2.5 6.5-7z" />,
	"run-codex": (
		<>
			<circle cx="12" cy="4" r="1.6" fill="currentColor" stroke="none" />
			<circle cx="18.9" cy="8" r="1.6" fill="currentColor" stroke="none" opacity="0.8" />
			<circle cx="18.9" cy="16" r="1.6" fill="currentColor" stroke="none" opacity="0.6" />
			<circle cx="12" cy="20" r="1.6" fill="currentColor" stroke="none" opacity="0.45" />
			<circle cx="5.1" cy="16" r="1.6" fill="currentColor" stroke="none" opacity="0.3" />
			<circle cx="5.1" cy="8" r="1.6" fill="currentColor" stroke="none" opacity="0.18" />
		</>
	),
	shield: <path d="M12 3a12 12 0 0 0 8.5 3A12 12 0 0 1 12 21 12 12 0 0 1 3.5 6 12 12 0 0 0 12 3" />,
} satisfies Record<string, ReactElement>;

export type MachineIconName = keyof typeof PATHS;

/** Decorative icon; the surrounding control carries the accessible name. */
export function MachineIcon({ name, small = false }: { name: MachineIconName; small?: boolean }) {
	return iconSvg(PATHS[name], small);
}

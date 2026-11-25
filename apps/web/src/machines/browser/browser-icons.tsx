// Icons only the machine's browser cards and view draw, kept out of
// machine-icons.tsx (the app's navigation loads that one at startup).
import type { ReactElement } from "react";
import { iconSvg } from "../../components/icon.tsx";

const PATHS = {
	keyboard: (
		<>
			<rect x="3" y="6" width="18" height="12" rx="2" />
			<path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
		</>
	),
	"zoom-out": <path d="M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM7 10h6M21 21l-6-6" />,
	x: <path d="M6 6l12 12M18 6L6 18" />,
	pointer: <path d="M7 3l12 7-5 1.5L11 17z" />,
	back: <path d="M15 6l-6 6 6 6" />,
	forward: <path d="M9 6l6 6-6 6" />,
	reload: <path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />,
	plus: <path d="M12 5v14M5 12h14" />,
} satisfies Record<string, ReactElement>;

/** Decorative icon; the surrounding control carries the accessible name. */
export function BrowserIcon({ name, small = false }: { name: keyof typeof PATHS; small?: boolean }) {
	return iconSvg(PATHS[name], small);
}

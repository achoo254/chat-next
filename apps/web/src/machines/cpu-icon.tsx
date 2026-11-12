// The AI Agent's mark (a chip), on its own so the chat's startup bundle (the
// folder rail, the agent entry) does not carry every icon of AI Agent.
import { iconSvg } from "../components/icon.tsx";

export const CPU_PATH = (
	<>
		<rect x="6" y="6" width="12" height="12" rx="2" />
		<path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5" />
	</>
);

/** Decorative; the surrounding control carries the accessible name. */
export function CpuIcon({ small = false }: { small?: boolean }) {
	return iconSvg(CPU_PATH, small);
}

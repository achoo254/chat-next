import { AiMark } from "../machines/ai-mark.tsx";

/**
 * What the terminal pane shows while the machine opens it: the AI Agent's
 * mark breathing over a ghost of the terminal (prompt lines that shimmer and
 * a blinking cursor). Decorative parts are aria-hidden; the label is the
 * status text. Motion stops under prefers-reduced-motion (terminal.css).
 */
export function TerminalLoading({ label }: { label: string }) {
	return (
		<div className="tx-empty tx-loading" role="status" aria-live="polite">
			<span className="tx-loading-mark" aria-hidden="true">
				<AiMark name="agent" />
			</span>
			<div className="tx-loading-ghost" aria-hidden="true">
				<span className="tx-loading-line" style={{ width: "72%" }} />
				<span className="tx-loading-line" style={{ width: "54%" }} />
				<span className="tx-loading-line tx-loading-prompt">
					<i />
				</span>
			</div>
			<p className="tx-loading-label">{label}</p>
		</div>
	);
}

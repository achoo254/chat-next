import emptySession from "./assets/empty-session.webp";

/** Centered illustrated states for a session pane: opening the terminal, and a session with nothing in it yet. */

/** A small terminal window whose cursor blinks while the shell is opening. */
export function SessionLoading({ label }: { label: string }) {
	return (
		<div className="mx-scene" role="status">
			<svg className="mx-scene-art mx-scene-term" viewBox="0 0 120 84" aria-hidden="true">
				<rect x="4" y="4" width="112" height="76" rx="10" className="mx-scene-fill" />
				<path d="M4 24h112" className="mx-scene-line" />
				<circle cx="16" cy="14" r="3" className="mx-scene-dot" />
				<circle cx="27" cy="14" r="3" className="mx-scene-dot" />
				<circle cx="38" cy="14" r="3" className="mx-scene-dot" />
				<path d="M20 40l10 8-10 8" className="mx-scene-prompt" />
				<rect x="38" y="52" width="26" height="4" rx="2" className="mx-scene-cursor" />
				<rect x="20" y="64" width="44" height="3" rx="1.5" className="mx-scene-ghost" />
			</svg>
			<p className="mx-scene-label">
				{label}
			</p>
		</div>
	);
}

/** A friendly speech-bubble mascot floating above the "nothing here yet" line. */
export function SessionEmpty({ label }: { label: string }) {
	return (
		<div className="mx-scene mx-center">
			<img className="mx-scene-art mx-scene-mascot" src={emptySession} alt="" width={160} height={160} />
			<p className="mx-scene-label">{label}</p>
		</div>
	);
}

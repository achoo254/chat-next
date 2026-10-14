interface MiddleTruncateProps {
	text: string;
	/** Characters always kept at the end, after the "…". */
	tail?: number;
	className?: string;
}

/**
 * A one-line value (link, username, email) shown whole when it fits; when it
 * does not, the start and the end stay and "…" replaces the middle, e.g.
 * chat.hoandat.com/join/V-pu…kVUp. Only the look is cut: the text in the
 * DOM stays complete for screen readers and copying, and `title` shows it on
 * hover.
 */
export function MiddleTruncate({ text, tail = 6, className }: MiddleTruncateProps) {
	// Code points, so an emoji is never split in half.
	const chars = Array.from(text);
	const cut = Math.max(0, chars.length - tail);
	return (
		<span className={className === undefined ? "mid-trunc" : `mid-trunc ${className}`} title={text}>
			<span className="mid-head">{chars.slice(0, cut).join("")}</span>
			<span className="mid-tail">{chars.slice(cut).join("")}</span>
		</span>
	);
}

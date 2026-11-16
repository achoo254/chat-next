/**
 * A share drawn as a thin bar (usage windows, Advisor's options); the
 * number itself is written next to it, so the bar is hidden from readers.
 */
export function PercentBar({ pct }: { pct: number }) {
	return (
		<span className="mx-bar" aria-hidden="true">
			<i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
		</span>
	);
}

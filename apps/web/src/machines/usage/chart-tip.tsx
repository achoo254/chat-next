// Hover tooltip shared by the "Hiệu quả" charts (usage-chart.tsx bars,
// usage-habits.tsx sparklines). The pointer, a touch or the arrow keys pick one
// point of the series; the tip floats above the chart at that point and says its
// numbers, which the bars alone only hint at.
import { type KeyboardEvent, type PointerEvent, type ReactNode, useState } from "react";

export interface ChartHover {
	/** The picked point, or null when none is. */
	readonly index: number | null;
	readonly svgProps: {
		readonly tabIndex: 0;
		readonly onPointerMove: (e: PointerEvent<SVGSVGElement>) => void;
		readonly onPointerDown: (e: PointerEvent<SVGSVGElement>) => void;
		readonly onPointerLeave: () => void;
		readonly onBlur: () => void;
		readonly onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => void;
	};
}

/**
 * Tracks which of `count` points is picked. `indexAt` maps the pointer's
 * position across the chart (0 at its left edge, 1 at its right) to a point,
 * or null where there is none.
 */
export function useChartHover(count: number, indexAt: (fraction: number) => number | null): ChartHover {
	const [index, setIndex] = useState<number | null>(null);
	const pick = (e: PointerEvent<SVGSVGElement>) => {
		const box = e.currentTarget.getBoundingClientRect();
		if (box.width <= 0) return;
		setIndex(indexAt((e.clientX - box.left) / box.width));
	};
	const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
		if (count === 0) return;
		const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) {
			if (e.key === "Escape") setIndex(null);
			return;
		}
		e.preventDefault();
		setIndex((i) => (i === null ? (step > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, i + step))));
	};
	return {
		index: index !== null && index < count ? index : null,
		svgProps: { tabIndex: 0, onPointerMove: pick, onPointerDown: pick, onPointerLeave: () => setIndex(null), onBlur: () => setIndex(null), onKeyDown },
	};
}

/** The tip itself, placed over the point at `fraction` (0..1) across the chart; kept inside the chart near its edges. */
export function ChartTip({ fraction, children }: { fraction: number; children: ReactNode }) {
	const shift = fraction < 0.2 ? "0%" : fraction > 0.8 ? "-100%" : "-50%";
	return (
		<div className="mx-usage-tip" role="status" style={{ left: `${fraction * 100}%`, transform: `translateX(${shift})` }}>
			{children}
		</div>
	);
}

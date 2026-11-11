// A tab's panes laid out from its split tree. Every pane is placed absolutely
// in one box and keyed by its id, so splitting or closing a neighbour never
// remounts a terminal (its screen and scrollback stay). Dividers drag with a
// pointer or move with the arrow keys.
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { LayoutNode, PaneNode, SplitNode } from "./terminal-layout.ts";

/** A box as fractions of the tab's area. */
interface Box {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

interface Placed {
	readonly panes: { readonly pane: PaneNode; readonly box: Box }[];
	readonly dividers: { readonly split: SplitNode; readonly box: Box }[];
}

/** Where each pane and divider goes. */
export function place(node: LayoutNode, box: Box = { x: 0, y: 0, w: 1, h: 1 }, out: Placed = { panes: [], dividers: [] }): Placed {
	if (node.kind === "pane") {
		out.panes.push({ pane: node, box });
		return out;
	}
	const row = node.dir === "row";
	const first = row ? { ...box, w: box.w * node.ratio } : { ...box, h: box.h * node.ratio };
	const second = row ? { ...box, x: box.x + first.w, w: box.w - first.w } : { ...box, y: box.y + first.h, h: box.h - first.h };
	place(node.a, first, out);
	place(node.b, second, out);
	out.dividers.push({ split: node, box });
	return out;
}

const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
const STEP = 0.05;

interface SplitsProps {
	root: LayoutNode;
	label: (split: SplitNode) => string;
	renderPane(pane: PaneNode): ReactNode;
	onRatio(splitId: string, ratio: number): void;
}

export function TerminalSplits({ root, label, renderPane, onRatio }: SplitsProps) {
	const area = useRef<HTMLDivElement>(null);
	const { panes, dividers } = place(root);
	const drag = (split: SplitNode, box: Box) => (event: PointerEvent<HTMLDivElement>) => {
		const el = area.current;
		if (el === null) return;
		event.preventDefault();
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const move = (e: globalThis.PointerEvent) => {
			const rect = el.getBoundingClientRect();
			const ratio = split.dir === "row" ? ((e.clientX - rect.left) / rect.width - box.x) / box.w : ((e.clientY - rect.top) / rect.height - box.y) / box.h;
			if (Number.isFinite(ratio)) onRatio(split.id, ratio);
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			handle.removeEventListener("pointercancel", up);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
		handle.addEventListener("pointercancel", up);
	};
	const keys = (split: SplitNode) => (event: KeyboardEvent<HTMLDivElement>) => {
		const less = split.dir === "row" ? "ArrowLeft" : "ArrowUp";
		const more = split.dir === "row" ? "ArrowRight" : "ArrowDown";
		if (event.key !== less && event.key !== more) return;
		event.preventDefault();
		onRatio(split.id, split.ratio + (event.key === more ? STEP : -STEP));
	};
	return (
		<div className="tx-panes" ref={area}>
			{panes.map(({ pane, box }) => (
				<div key={pane.id} className="tx-pane" style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}>
					{renderPane(pane)}
				</div>
			))}
			{dividers.map(({ split, box }) => {
				const row = split.dir === "row";
				const at = row ? box.x + box.w * split.ratio : box.y + box.h * split.ratio;
				const style = row ? { left: pct(at), top: pct(box.y), height: pct(box.h) } : { top: pct(at), left: pct(box.x), width: pct(box.w) };
				return (
					<div
						key={split.id}
						className={`tx-divider ${split.dir}`}
						style={style}
						// A focusable splitter is a widget: a slider of the first pane's share.
						role="slider"
						tabIndex={0}
						aria-label={label(split)}
						aria-orientation={row ? "horizontal" : "vertical"}
						aria-valuemin={10}
						aria-valuemax={90}
						aria-valuenow={Math.round(split.ratio * 100)}
						onPointerDown={drag(split, box)}
						onKeyDown={keys(split)}
					/>
				);
			})}
		</div>
	);
}

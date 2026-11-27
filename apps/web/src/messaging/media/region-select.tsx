// Picking a region of the shared screen, over the whole page: the frame
// grabbed for a screenshot (or the live screen, for a recording) fills the
// page, a drag draws the region with its size in screen pixels, and the bar
// below takes that region, the whole screen, or cancels. Enter takes the
// region (the whole screen when none is drawn), Esc cancels. A new drag
// replaces the region.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { toSourceRect, type Rect } from "./screen-capture.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

interface Point {
	readonly x: number;
	readonly y: number;
}

interface RegionSelectProps {
	/** The grabbed frame, or a playing video of the shared screen. */
	media: HTMLCanvasElement | HTMLVideoElement;
	/** Size of the shared screen in pixels. */
	width: number;
	height: number;
	mode: "screenshot" | "record";
	/** The region in screen pixels; null for the whole screen. */
	onConfirm: (region: Rect | null) => void;
	onCancel: () => void;
}

function rectOf(element: Element): Rect {
	const box = element.getBoundingClientRect();
	return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export default function RegionSelect({ media, width, height, mode, onConfirm, onCancel }: RegionSelectProps) {
	const copy = useMediaCopy();
	const root = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<{ readonly region: Rect; readonly box: Rect } | null>(null);
	const from = useRef<Point | null>(null);

	// The frame or video is made outside React: shown here as it is.
	useEffect(() => {
		const host = stage.current;
		if (host === null) return;
		media.classList.add("region-media");
		host.prepend(media);
		root.current?.focus();
		return () => media.remove();
	}, [media]);

	/** The region from the drag's start to `to`, and where to draw it in the stage. */
	const select = (to: Point) => {
		const start = from.current;
		const host = stage.current;
		if (start === null || host === null) return;
		const shown = rectOf(media);
		const region = toSourceRect(start, to, shown, width, height);
		if (region === null) {
			setSelection(null);
			return;
		}
		const origin = rectOf(host);
		setSelection({
			region,
			box: {
				x: shown.x - origin.x + (region.x * shown.width) / width,
				y: shown.y - origin.y + (region.y * shown.height) / height,
				width: (region.width * shown.width) / width,
				height: (region.height * shown.height) / height,
			},
		});
	};
	const region = selection?.region ?? null;

	const point = (event: ReactPointerEvent): Point => ({ x: event.clientX, y: event.clientY });
	const title = mode === "screenshot" ? copy.region.shotTitle : copy.region.recordTitle;

	return createPortal(
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Enter and Esc anywhere in the picker take or cancel the region
		<div
			ref={root}
			className="region-select"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				} else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
					event.preventDefault();
					onConfirm(region);
				}
			}}
		>
			<p className="region-hint">{copy.region.hint}</p>
			<div
				ref={stage}
				className="region-stage"
				data-testid="region-stage"
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.currentTarget.setPointerCapture?.(event.pointerId);
					from.current = point(event);
					setSelection(null);
				}}
				onPointerMove={(event) => {
					if (from.current !== null) select(point(event));
				}}
				onPointerUp={(event) => {
					select(point(event));
					from.current = null;
				}}
			>
				{selection !== null && (
					<div
						className="region-box"
						style={{ left: selection.box.x, top: selection.box.y, width: selection.box.width, height: selection.box.height }}
					>
						<span className="region-size">{copy.region.size(selection.region.width, selection.region.height)}</span>
					</div>
				)}
			</div>
			<div className="region-bar">
				<button type="button" className="btn" onClick={onCancel}>
					{copy.region.cancel}
				</button>
				<button type="button" className="btn" onClick={() => onConfirm(null)}>
					{copy.region.whole}
				</button>
				<button type="button" className="btn btn-primary" disabled={region === null} onClick={() => onConfirm(region)}>
					{mode === "screenshot" ? copy.region.shoot : copy.region.record}
				</button>
			</div>
		</div>,
		document.body,
	);
}

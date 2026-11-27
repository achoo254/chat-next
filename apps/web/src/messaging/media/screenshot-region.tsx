// A screenshot from the attach menu or ⌥S: the share asked for in the click
// (screen-share.ts) gives one frame and stops at once; the frame then fills
// the page to drag the region to keep (region-select.tsx), and the region —
// or the whole screen — goes to the tray as a PNG. Closing the browser's
// picker or Esc leaves nothing behind.
import { lazy, Suspense, useEffect, useEffectEvent, useState } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { addAttachments } from "./media-state.ts";
import { grabFrame, screenshotFile, stopStream, type Rect } from "./screen-capture.ts";
import { refusedShare } from "./screen-share.ts";

const RegionSelect = lazy(() => import("./region-select.tsx"));

interface ScreenshotRegionProps {
	/** The share the attach menu (or the shortcut) asked for. */
	stream: Promise<MediaStream>;
	chatId: number;
	topicId: number;
	/** Called once the screenshot is in the tray, or abandoned. */
	onClose: () => void;
}

export default function ScreenshotRegion({ stream, chatId, topicId, onClose }: ScreenshotRegionProps) {
	const copy = useScreensCopy();
	const { toasts } = useServices();
	const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);

	const failed = (err: unknown) => {
		// Closing the picker is not an error.
		if (!refusedShare(err)) toasts.show(copy.composer.screenshotFailed);
		onClose();
	};
	const fail = useEffectEvent(failed);

	useEffect(() => {
		let active = true;
		stream.then(
			(shared) => {
				if (!active) {
					stopStream(shared);
					return;
				}
				grabFrame(shared).then(
					(grabbed) => {
						if (active) setFrame(grabbed);
					},
					(err: unknown) => {
						if (active) fail(err);
					},
				);
			},
			(err: unknown) => {
				if (active) fail(err);
			},
		);
		return () => {
			active = false;
		};
	}, [stream]);

	const keep = (region: Rect | null) => {
		if (frame === null) return;
		screenshotFile(frame, region).then(
			(file) => {
				addAttachments(chatId, topicId, [file]);
				onClose();
			},
			failed,
		);
	};

	if (frame === null) return null;
	return (
		<Suspense fallback={null}>
			<RegionSelect media={frame} width={frame.width} height={frame.height} mode="screenshot" onConfirm={keep} onCancel={onClose} />
		</Suspense>
	);
}

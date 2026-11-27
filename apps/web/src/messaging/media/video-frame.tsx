// A clip drawn inline, the way Telegram shows what it sends without a player:
// a still first frame where the server made no poster (videos the bridge
// copied from another app arrive without one), and a muted loop for video
// stickers. The file is fetched only once the clip is near the screen, and a
// loop plays only while it is on screen and for people who accept motion.
import type { MediaRef } from "@achoo254/chat-core";
import { useEffect, useRef } from "react";
import { useMediaFile } from "./use-media.ts";

interface Props {
	chatId: number;
	seq: number;
	media: MediaRef;
	/** Fetch and draw; false until the clip is near the screen. */
	enabled: boolean;
	/** Loop muted while visible; otherwise rest on the first frame. */
	loop: boolean;
	className: string;
	/** Called when the clip cannot be read, so the caller can show something else. */
	onFailed?: () => void;
}

/** Past this a clip is not fetched just to draw its first frame. */
export const FRAME_MAX_BYTES = 8 << 20;

function calmMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function VideoFrame({ chatId, seq, media, enabled, loop, className, onFailed }: Props) {
	const { state } = useMediaFile({ chatId, seq, fileId: media.fileId, kind: media.kind }, enabled);
	const video = useRef<HTMLVideoElement>(null);
	const failed = state.status === "failed";
	useEffect(() => {
		if (failed) onFailed?.();
	}, [failed, onFailed]);
	useEffect(() => {
		const element = video.current;
		if (element === null || !loop || state.status !== "ok") return;
		if (calmMotion() || typeof IntersectionObserver === "undefined") return;
		const watch = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) void element.play().catch(() => undefined);
			else element.pause();
		});
		watch.observe(element);
		return () => watch.disconnect();
	}, [loop, state.status]);
	if (state.status !== "ok") return null;
	return (
		<video
			ref={video}
			className={className}
			src={state.url}
			muted
			playsInline
			loop={loop}
			preload="auto"
			aria-hidden="true"
			tabIndex={-1}
			onLoadedData={(event) => {
				// A still frame: the first picture, nudged past a black opening frame.
				if (!loop) event.currentTarget.currentTime = 0.05;
			}}
			onError={() => onFailed?.()}
		/>
	);
}

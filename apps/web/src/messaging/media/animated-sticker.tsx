// Animated stickers: Telegram's .tgs files are gzipped Lottie animations. The
// player is fetched the first time one is about to show, and draws on a canvas
// (the light canvas build runs no expression code, which the page's content
// security policy would not allow anyway). A sticker plays while it is on
// screen and rests on its first frame for people who ask for less motion; one
// that cannot be read falls back to the file card, so it can still be saved.
import type { MediaRef } from "@achoo254/chat-core";
import type { AnimationItem } from "lottie-web";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServices } from "../data/services.tsx";
import { useMediaCopy } from "./use-media-copy.ts";

/** Telegram caps a .tgs at 64 KiB; anything much bigger is not a sticker. */
const STICKER_MAX_BYTES = 1 << 20;
/** What a sticker may unpack to: real ones are a few hundred KiB of JSON. */
const LOTTIE_MAX_BYTES = 8 << 20;

/** The Lottie document inside a .tgs; throws for what is not a small gzipped JSON. */
export async function readLottie(blob: Blob): Promise<unknown> {
	if (blob.size > STICKER_MAX_BYTES) throw new Error("sticker too large");
	const reader = blob.stream().pipeThrough(new DecompressionStream("gzip")).getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > LOTTIE_MAX_BYTES) {
			await reader.cancel();
			throw new Error("sticker unpacks too large");
		}
		parts.push(value);
	}
	return JSON.parse(await new Blob(parts as BlobPart[]).text());
}

interface Props {
	chatId: number;
	seq: number;
	media: MediaRef;
	/** Shown instead when the sticker cannot be played (the file card). */
	fallback: ReactNode;
}

export function AnimatedSticker({ chatId, seq, media, fallback }: Props) {
	const copy = useMediaCopy();
	const { source, store } = useServices();
	const host = useRef<HTMLDivElement>(null);
	const [failed, setFailed] = useState(false);
	const fileId = media.fileId;
	const kind = media.kind;
	useEffect(() => {
		const element = host.current;
		if (element === null) return;
		let active = true;
		let animation: AnimationItem | null = null;
		let visible = typeof IntersectionObserver === "undefined";
		let started = false;
		const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		const show = () => {
			if (animation === null) return;
			if (visible && !calm) animation.play();
			else animation.pause();
		};
		const start = async () => {
			started = true;
			try {
				const file = await source.mediaFile({ chatId, seq, fileId, kind });
				if (!active) return;
				if (file.status === "unavailable") {
					setFailed(true);
					return;
				}
				const data = await readLottie(file.blob);
				const { default: lottie } = await import("lottie-web/build/player/lottie_light_canvas");
				if (!active) return;
				animation = lottie.loadAnimation({
					container: element,
					renderer: "canvas",
					loop: true,
					autoplay: false,
					animationData: data,
					rendererSettings: { clearCanvas: true },
				});
				if (calm) animation.goToAndStop(0, true);
				show();
			} catch (err) {
				store.reportError(err, `sticker ${chatId}:${seq}`);
				if (active) setFailed(true);
			}
		};
		const watch =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(
						(entries) => {
							visible = entries.some((entry) => entry.isIntersecting);
							if (visible && !started) void start();
							show();
						},
						{ rootMargin: "200px 0px" },
					);
		if (watch === null) void start();
		else watch.observe(element);
		return () => {
			active = false;
			watch?.disconnect();
			animation?.destroy();
		};
	}, [source, store, chatId, seq, fileId, kind]);
	if (failed) return fallback;
	return <div ref={host} className="animated-sticker" role="img" aria-label={copy.media.sticker} />;
}

// Fixed boxes of photos and videos (mockups/media.html#message-media): a
// message carries the size of its file, so the box has the right shape
// before anything is downloaded and nothing moves when the image lands.
// Part of the first chunk (the bubble reserves the box while the media
// module loads), so it stays tiny.
import type { MediaRef } from "@achoo254/chat-core";

/** Widest photo or video in a bubble (mock .media-w). */
export const MEDIA_MAX_W = 300;
export const MEDIA_MAX_H = 360;
const MIN_W = 120;
const MIN_H = 90;

export interface Box {
	readonly width: number;
	readonly height: number;
}

/** The box of a picture of width × height; 4:3 at full width when its size is unknown. */
export function mediaBox(width: number, height: number, maxWidth = MEDIA_MAX_W, maxHeight = MEDIA_MAX_H): Box {
	if (!(width > 0) || !(height > 0)) return { width: maxWidth, height: Math.round((maxWidth * 3) / 4) };
	const scale = Math.min(maxWidth / width, maxHeight / height);
	return {
		width: Math.min(maxWidth, Math.max(MIN_W, Math.round(width * scale))),
		height: Math.min(maxHeight, Math.max(MIN_H, Math.round(height * scale))),
	};
}

/** Photos and videos show as a picture; every other kind as a card. */
export function isVisual(media: Pick<MediaRef, "kind">): boolean {
	return media.kind === "photo" || media.kind === "video";
}

/**
 * Inline style of a picture box: a fixed width that shrinks with the
 * bubble on narrow screens, the height following the aspect ratio.
 */
export function boxStyle(box: Box): { width: string; aspectRatio: string } {
	return { width: `${box.width}px`, aspectRatio: `${box.width} / ${box.height}` };
}

/** Rows × columns of an album grid (media.css .album.nN): squares, a wide first cell for three. */
export function albumBox(count: number): Box {
	const width = MEDIA_MAX_W;
	if (count <= 2) return { width, height: width / 2 };
	if (count <= 4) return { width, height: width };
	return { width, height: Math.ceil(count / 3) * (width / 3) };
}

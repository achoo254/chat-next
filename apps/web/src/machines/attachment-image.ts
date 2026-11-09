// Fits an image to what the AI takes (part of the AI Agent screens, which
// load on demand): an image of a type the AI reads, within the machine's byte limit and
// Claude's 8000-pixel side, goes as it is; any other is drawn smaller
// (longest side 2000 px, then less) and encoded as WebP, or JPEG where the
// browser cannot write WebP, until it fits. Undefined when the browser
// cannot read it: it then goes as a plain file.
import { IMAGE_TYPES } from "./attachments.ts";

/** Claude refuses an image with a side past this. */
const SIDE_MAX = 8000;
const SIDES = [2000, 1600, 1200, 800] as const;
const QUALITIES = [0.9, 0.8, 0.7] as const;

/** The scale that fits `width`×`height` within `side` on its longest side (never above 1). */
export function fitScale(width: number, height: number, side: number): number {
	return Math.min(1, side / Math.max(width, height, 1));
}

/** The file name for the new type: "shot.heic" → "shot.jpg". */
export function renamed(name: string, type: string): string {
	const ext = type === "image/webp" ? "webp" : type === "image/png" ? "png" : "jpg";
	const dot = name.lastIndexOf(".");
	return `${dot > 0 ? name.slice(0, dot) : name || "image"}.${ext}`;
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function fitImage(file: File, maxBytes: number): Promise<File | undefined> {
	if (typeof createImageBitmap !== "function") return IMAGE_TYPES.has(file.type) && file.size <= maxBytes ? file : undefined;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return undefined;
	}
	try {
		const { width, height } = bitmap;
		if (IMAGE_TYPES.has(file.type) && file.size <= maxBytes && Math.max(width, height) <= SIDE_MAX) return file;
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (context === null) return undefined;
		for (const side of SIDES) {
			const scale = fitScale(width, height, side);
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			// JPEG has no transparency: white shows where the image had none.
			context.fillStyle = "#fff";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			for (const quality of QUALITIES) {
				let blob = await encode(canvas, "image/webp", quality);
				// A browser that cannot write WebP gives PNG instead.
				if (blob !== null && blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", quality);
				if (blob !== null && blob.size <= maxBytes && IMAGE_TYPES.has(blob.type)) {
					return new File([blob], renamed(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
				}
			}
		}
		return undefined;
	} finally {
		bitmap.close();
	}
}

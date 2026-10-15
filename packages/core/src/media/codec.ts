// Local storage form of media: MediaRef as JSON, bytes (inline thumb,
// waveform) as base64. Rows are written only by this package but decoded
// defensively, like the other JSON columns.
import type { LinkPreview, MediaKind, MediaRef, MediaSize, MediaSizeType } from "../model/types.ts";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map<string, number>([...B64].map((c, i) => [c, i]));

export function toBase64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i] ?? 0;
		const b = bytes[i + 1] ?? 0;
		const c = bytes[i + 2] ?? 0;
		const n = (a << 16) | (b << 8) | c;
		out += B64[(n >> 18) & 63] ?? "";
		out += B64[(n >> 12) & 63] ?? "";
		out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? "") : "=";
		out += i + 2 < bytes.length ? (B64[n & 63] ?? "") : "=";
	}
	return out;
}

/** Decodes standard base64; null when the text is not base64. */
export function fromBase64(text: string): Uint8Array | null {
	const clean = text.replace(/=+$/, "");
	if (clean.length % 4 === 1) return null;
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let bits = 0;
	let value = 0;
	let o = 0;
	for (const c of clean) {
		const v = B64_INDEX.get(c);
		if (v === undefined) return null;
		value = (value << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (value >> bits) & 0xff;
		}
	}
	return out;
}

const KINDS = new Set<MediaKind>(["photo", "video", "audio", "voice", "document", "unknown"]);
const SIZE_TYPES = new Set<MediaSizeType>(["s", "m", "x"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(record: Record<string, unknown>, key: string): number {
	const v = record[key];
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function text(record: Record<string, unknown>, key: string): string {
	const v = record[key];
	return typeof v === "string" ? v : "";
}

function bytes(record: Record<string, unknown>, key: string): Uint8Array {
	return fromBase64(text(record, key)) ?? new Uint8Array();
}

/** JSON-ready form of a MediaRef. */
export function mediaRefJson(media: MediaRef): Record<string, unknown> {
	return {
		fileId: media.fileId,
		fileHash: media.fileHash,
		kind: media.kind,
		mimeType: media.mimeType,
		size: media.size,
		fileName: media.fileName,
		width: media.width,
		height: media.height,
		duration: media.duration,
		inlineThumb: toBase64(media.inlineThumb),
		sizes: media.sizes,
		waveform: toBase64(media.waveform),
	};
}

export function encodeMediaRef(media: MediaRef): string {
	return JSON.stringify(mediaRefJson(media));
}

export function encodeLinkPreview(preview: LinkPreview): string {
	const { photo, ...rest } = preview;
	return JSON.stringify(photo === undefined ? rest : { ...rest, photo: mediaRefJson(photo) });
}

/** A MediaRef from its JSON form (already parsed); null when absent or corrupt. */
export function decodeMediaRef(value: unknown): MediaRef | null {
	if (!isRecord(value)) return null;
	const fileId = text(value, "fileId");
	if (fileId === "") return null;
	const kind = text(value, "kind");
	const sizes: MediaSize[] = [];
	if (Array.isArray(value.sizes)) {
		for (const item of value.sizes) {
			if (!isRecord(item)) continue;
			const type = text(item, "type");
			if (!SIZE_TYPES.has(type as MediaSizeType)) continue;
			sizes.push({ type: type as MediaSizeType, width: int(item, "width"), height: int(item, "height"), size: int(item, "size") });
		}
	}
	return {
		fileId,
		fileHash: text(value, "fileHash"),
		kind: KINDS.has(kind as MediaKind) ? (kind as MediaKind) : "unknown",
		mimeType: text(value, "mimeType"),
		size: int(value, "size"),
		fileName: text(value, "fileName"),
		width: int(value, "width"),
		height: int(value, "height"),
		duration: int(value, "duration"),
		inlineThumb: bytes(value, "inlineThumb"),
		sizes,
		waveform: bytes(value, "waveform"),
	};
}

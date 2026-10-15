// Pure helpers of the media screens: sizes and durations as people read
// them, the type label of a file card, which files go as photos, videos or
// documents, how a selection splits into sends (albums of at most
// albumSizeMax), and voice waveforms.
import type { MediaInput, MediaKind, MediaLimits } from "@app/core";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** "2,4 MB" (vi) or "2.4 MB" (en); whole numbers past 100 ("310 MB"). */
export function formatBytes(bytes: number, locale: string): string {
	if (!(bytes > 0)) return `0 ${UNITS[0]}`;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = unit === 0 || value >= 100 ? 0 : 1;
	const text = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0, useGrouping: false }).format(value);
	return `${text} ${UNITS[unit] ?? "B"}`;
}

/** Bytes of `sent` and `total` in the unit of `total`: "2,1 / 3,3 MB". */
export function formatProgress(sent: number, total: number, locale: string): string {
	const totalText = formatBytes(total, locale);
	const unit = totalText.slice(totalText.lastIndexOf(" ") + 1);
	const power = Math.max(0, UNITS.indexOf(unit as (typeof UNITS)[number]));
	const scaled = sent / 1024 ** power;
	const digits = power === 0 || scaled >= 100 ? 0 : 1;
	const sentText = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled);
	return `${sentText} / ${totalText}`;
}

/** Whole percent done, 0 to 100. */
export function percent(sent: number, total: number): number {
	if (!(total > 0)) return 0;
	return Math.max(0, Math.min(100, Math.floor((sent * 100) / total)));
}

/** "0:27", "2:14", "1:02:03"; `padMinutes` gives "02:14" (video chips). */
export function formatDuration(ms: number, padMinutes = false): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
	return `${padMinutes ? String(minutes).padStart(2, "0") : minutes}:${seconds}`;
}

/** Type label of a file card ("PDF", "XLSX"); "FILE" when the name has no short extension. */
export function fileExt(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "FILE";
	const ext = name.slice(dot + 1);
	return ext.length <= 4 && /^[a-z0-9]+$/i.test(ext) ? ext.toUpperCase() : "FILE";
}

/** Raster images the browser shows and the server accepts as photos. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
/** Larger images go as files (server: photos are limited to 20 MiB). */
export const PHOTO_MAX_BYTES = 20 * 2 ** 20;

export type SendKind = Extract<MediaKind, "photo" | "video" | "document">;

/** How a picked file is sent: photo, video, or as a file (anything else, or "send as file"). */
export function sendKind(file: Pick<File, "type" | "size">, asFiles = false): SendKind {
	if (asFiles) return "document";
	if (PHOTO_TYPES.has(file.type) && file.size <= PHOTO_MAX_BYTES) return "photo";
	if (VIDEO_TYPES.has(file.type)) return "video";
	return "document";
}

export type FileProblem = "too_large" | "empty";

export interface PlannedItem {
	readonly file: File;
	readonly kind: SendKind;
}

export interface SendPlan {
	/** Each entry is one send: a single file, or an album (2 or more). */
	readonly groups: readonly (readonly PlannedItem[])[];
	readonly refused: readonly { readonly file: File; readonly problem: FileProblem }[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Splits picked files into sends: photos and videos together in albums,
 * other files in albums of their own (the server does not mix them), each
 * album at most `albumSizeMax`. Files over the upload limit or empty are
 * refused before anything is uploaded.
 */
export function planSends(files: readonly File[], limits: Pick<MediaLimits, "uploadSizeMax" | "albumSizeMax">, asFiles = false): SendPlan {
	const refused: { file: File; problem: FileProblem }[] = [];
	const visual: PlannedItem[] = [];
	const documents: PlannedItem[] = [];
	for (const file of files) {
		if (file.size === 0) refused.push({ file, problem: "empty" });
		else if (limits.uploadSizeMax > 0 && file.size > limits.uploadSizeMax) refused.push({ file, problem: "too_large" });
		else {
			const kind = sendKind(file, asFiles);
			(kind === "document" ? documents : visual).push({ file, kind });
		}
	}
	const size = Math.max(1, limits.albumSizeMax);
	return { groups: [...chunk(visual, size), ...chunk(documents, size)], refused };
}

/** The MediaInput of a picked file; photos are measured by the core, videos by the caller. */
export function mediaInput(item: PlannedItem, measured: Partial<Pick<MediaInput, "width" | "height" | "duration" | "inlineThumb">> = {}): MediaInput {
	return {
		kind: item.kind,
		fileName: item.file.name,
		mimeType: item.file.type,
		...measured,
	};
}

/**
 * `count` bar heights (0 to 1) of a voice waveform (one byte per sample,
 * 0 to 255); a flat line when the message has none.
 */
export function waveformBars(waveform: Uint8Array, count: number): number[] {
	if (waveform.length === 0) return Array.from({ length: count }, () => 0.15);
	const bars: number[] = [];
	for (let i = 0; i < count; i++) {
		const from = Math.floor((i * waveform.length) / count);
		const to = Math.max(from + 1, Math.floor(((i + 1) * waveform.length) / count));
		let peak = 0;
		for (let j = from; j < to && j < waveform.length; j++) peak = Math.max(peak, waveform[j] ?? 0);
		bars.push(Math.max(0.1, peak / 255));
	}
	return bars;
}

/** Levels measured while recording (0 to 1) reduced to `count` peaks scaled to 0..255, as the server stores them. */
export function encodeWaveform(levels: readonly number[], count = 100): Uint8Array {
	if (levels.length === 0) return new Uint8Array();
	const n = Math.min(count, levels.length);
	const peaks: number[] = [];
	for (let i = 0; i < n; i++) {
		const from = Math.floor((i * levels.length) / n);
		const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
		let peak = 0;
		for (let j = from; j < to; j++) peak = Math.max(peak, levels[j] ?? 0);
		peaks.push(peak);
	}
	const top = Math.max(...peaks);
	return Uint8Array.from(peaks, (peak) => (top > 0 ? Math.round((Math.min(1, peak) / top) * 255) : 0));
}

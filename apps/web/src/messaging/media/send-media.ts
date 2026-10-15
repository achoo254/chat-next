// Sending picked files and voice messages: the selection is split into
// sends (photos and videos as albums, other files as file albums, each at
// most albumSizeMax), refused files are reported before anything uploads,
// videos are measured and thumbnailed on the device (the server makes a
// poster only when it has ffmpeg), and each send goes to the outbox with a
// random_id chosen here, so a topic view can show it while it uploads.
// Photos are measured by the core (off the main thread).
import type { MediaInput, MediaLimits } from "@app/core";
import { cryptoRandomId } from "@app/platform";
import type { ChatSource } from "../data/source.ts";
import { encodeWaveform, mediaInput, planSends, type FileProblem, type PlannedItem } from "./media-format.ts";
import { pendingTopics } from "./media-state.ts";

/** Longest side of a client-made inline thumbnail; the server takes at most 2 KiB. */
const THUMB_SIDE = 40;
const THUMB_MAX_BYTES = 2048;
/** A video that does not report its size this fast is sent unmeasured. */
const PROBE_TIMEOUT_MS = 4000;

export interface SendTarget {
	readonly chatId: number;
	/** Forum topic; 0 elsewhere. */
	readonly topicId: number;
	readonly replyToSeq: number;
}

export interface SendOutcome {
	/** Files refused before upload (too large, empty), in the order picked. */
	readonly refused: readonly { readonly file: File; readonly problem: FileProblem }[];
	/** Sends handed to the outbox. */
	readonly sent: number;
}

async function jpegThumb(source: CanvasImageSource, width: number, height: number): Promise<Uint8Array | undefined> {
	if (!(width > 0) || !(height > 0)) return undefined;
	const scale = Math.min(1, THUMB_SIDE / Math.max(width, height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(width * scale));
	canvas.height = Math.max(1, Math.round(height * scale));
	const context = canvas.getContext("2d");
	if (context === null) return undefined;
	context.drawImage(source, 0, 0, canvas.width, canvas.height);
	for (const quality of [0.6, 0.3]) {
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
		if (blob === null) return undefined;
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (bytes.length <= THUMB_MAX_BYTES) return bytes;
	}
	return undefined;
}

/**
 * Size, duration and a first-frame thumbnail of a video, read by the
 * browser; empty when it cannot play the file (it still sends, unmeasured).
 */
export async function measureVideo(file: File): Promise<Partial<Pick<MediaInput, "width" | "height" | "duration" | "inlineThumb">>> {
	const video = document.createElement("video");
	if (video.canPlayType(file.type) === "") return {};
	const url = URL.createObjectURL(file);
	try {
		video.muted = true;
		video.preload = "metadata";
		const loaded = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
			video.addEventListener("loadeddata", () => {
				clearTimeout(timer);
				resolve(true);
			});
			video.addEventListener("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
		video.src = url;
		if (!(await loaded)) return {};
		const width = video.videoWidth;
		const height = video.videoHeight;
		const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
		const inlineThumb = await jpegThumb(video, width, height).catch(() => undefined);
		return { width, height, duration, ...(inlineThumb === undefined ? {} : { inlineThumb }) };
	} finally {
		video.removeAttribute("src");
		URL.revokeObjectURL(url);
	}
}

async function inputOf(item: PlannedItem): Promise<MediaInput> {
	return item.kind === "video" ? mediaInput(item, await measureVideo(item.file)) : mediaInput(item);
}

/** A random_id for a send, registered with its topic first so the topic view shows the pending message at once. */
function newRandomId(target: SendTarget): number {
	const randomId = cryptoRandomId();
	if (target.topicId !== 0) pendingTopics.set(randomId, target.topicId);
	return randomId;
}

/**
 * Sends picked files with a caption (on the first send). `asFiles` sends
 * photos and videos as plain files. Rejects when the outbox refused a
 * send; the sends before it stay queued.
 */
export async function sendFiles(
	source: ChatSource,
	target: SendTarget,
	files: readonly File[],
	caption: string,
	limits: Pick<MediaLimits, "uploadSizeMax" | "albumSizeMax">,
	asFiles = false,
): Promise<SendOutcome> {
	const plan = planSends(files, limits, asFiles);
	let text = caption;
	let replyToSeq = target.replyToSeq;
	let sent = 0;
	for (const group of plan.groups) {
		const common = {
			...(replyToSeq === 0 ? {} : { replyToSeq }),
			...(target.topicId === 0 ? {} : { topicId: target.topicId }),
		};
		const first = group[0];
		if (first === undefined) continue;
		if (group.length === 1) {
			await source.sendMedia(target.chatId, first.file, await inputOf(first), {
				...common,
				randomId: newRandomId(target),
				...(text === "" ? {} : { text }),
			});
		} else {
			const items = [];
			for (const [index, item] of group.entries()) {
				items.push({ file: item.file, media: await inputOf(item), randomId: newRandomId(target), ...(index === 0 && text !== "" ? { text } : {}) });
			}
			await source.sendAlbum(target.chatId, items, common);
		}
		sent++;
		// The caption and the reply go with the first send only.
		text = "";
		replyToSeq = 0;
	}
	return { refused: plan.refused, sent };
}

/** File name of a recorded voice message, by container. */
function voiceName(type: string): string {
	if (type.includes("ogg")) return "voice.ogg";
	if (type.includes("mp4") || type.includes("aac")) return "voice.m4a";
	return "voice.webm";
}

/** Sends a recorded voice message with its duration and the levels measured while recording. */
export async function sendVoice(source: ChatSource, target: SendTarget, blob: Blob, durationMs: number, levels: readonly number[]): Promise<void> {
	const type = blob.type.split(";")[0] ?? "";
	await source.sendMedia(
		target.chatId,
		blob,
		{ kind: "voice", fileName: voiceName(type), mimeType: type, duration: Math.round(durationMs), waveform: encodeWaveform(levels) },
		{
			randomId: newRandomId(target),
			...(target.replyToSeq === 0 ? {} : { replyToSeq: target.replyToSeq }),
			...(target.topicId === 0 ? {} : { topicId: target.topicId }),
		},
	);
}

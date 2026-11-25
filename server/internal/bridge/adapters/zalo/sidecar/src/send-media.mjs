// Sending one photo or one file to one person (protocol 8), and why it failed, as a code. Like
// send.mjs, neither the file, its name, the caption nor the recipient is ever written to stderr,
// and the library's messages never leave the process.
//
// The engine streams the bytes in `file_chunk` lines (base64), then asks with `send_media`. They
// are kept in memory only: zca-js 2.3.0 `api.sendMessage({ msg, attachments }, to, ThreadType.User)`
// takes an attachment as `{ data: Buffer, filename, metadata: { totalSize, width, height } }`, so no
// file is written. With one attachment it makes these requests, all to the file service of Zalo's
// service map (`zpwServiceMap.file[0]`, given by Zalo at login):
//   - upload, in chunks of `settings.features.sharefile.chunk_size_file`:
//     POST <file>/api/message/photo_original/upload (a photo: jpg, jpeg, png, webp by name) or
//     POST <file>/api/message/asyncfile/upload (any other file), then, for a file only, the listener's
//     `file_done` control on the websocket says where it went;
//   - post: POST <file>/api/message/photo_original/send or <file>/api/message/asyncfile/msg.
// A caption goes in the same message only for a single photo (`desc`); for a file the library would
// post the text as a message of its own first, so a file with a caption is refused here.
//
// Nothing is posted before the upload ends, and the upload of a file waits for the listener with no
// time limit of its own, so the upload is wrapped (guardUploads): it fails after UPLOAD_TIMEOUT_MS,
// and any failure up to there is an UploadError, which says no message was created.
import { setTimeout, clearTimeout } from "node:timers";
import { ThreadType } from "zca-js";
import { RATE_LIMITED, REFUSED, SESSION_REJECTED, sendFailure } from "./send.mjs";

/** The largest file sent, as the engine's limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The longest base64 text of one file_chunk line. */
export const MAX_CHUNK_TEXT = 1024 * 1024;
/** How long an upload may take before the send gives up (the engine waits 3 minutes). */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** Zalo refused the file as too large: nothing was created. */
export const TOO_LARGE = "too_large";
/** The library or Zalo refused this file (type, count): nothing was created. */
export const FILE_REFUSED = "file_refused";
/** The upload failed or took too long: no message was posted. */
export const UPLOAD_FAILED = "upload_failed";

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
/** Sent by the library as a video or an animation, not as a file. */
const REFUSED_EXTENSIONS = new Set(["mp4", "gif"]);
/** Characters a file name may not hold: a path, a quote that would end a multipart header value. */
const UNSAFE_IN_NAME = new Set(["/", "\\", '"']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HTTP_FAILED = "Request failed with status code ";
/** The library's refusals of a file, before or during the upload. */
const FILE_MESSAGES = ["File extension ", "Exceed maximum file", "Missing filename", "Invalid source type", "Missing sources", "File not found"];

/** A file name of 1 to 255 characters with no path, no control character and no quote. */
function isSafeName(name) {
	if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
	for (const char of name) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || UNSAFE_IN_NAME.has(char)) return false;
	}
	return true;
}

/** The lower-case extension of a file name, "" when it has none. */
function extensionOf(name) {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isDimension(value) {
	return Number.isInteger(value) && value > 0 && value <= 65_535;
}

/**
 * The bytes of the file being streamed: one at a time (the engine sends one file at a time per
 * account). A chunk of another id starts over; a file over MAX_FILE_BYTES or a bad chunk spoils it.
 */
export function createUploads() {
	let current = null;
	return {
		chunk(id, text) {
			if (current === null || current.id !== id) current = { id, parts: [], size: 0, spoiled: false };
			if (current.spoiled) return;
			if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHUNK_TEXT || text.length % 4 !== 0 || !BASE64.test(text)) {
				current = { id, parts: [], size: 0, spoiled: true };
				return;
			}
			const bytes = Buffer.from(text, "base64");
			if (current.size + bytes.length > MAX_FILE_BYTES) {
				current = { id, parts: [], size: 0, spoiled: true };
				return;
			}
			current.parts.push(bytes);
			current.size += bytes.length;
		},
		/** The bytes streamed under id, and forgets them; null when there are none or they are spoiled. */
		take(id) {
			const taken = current;
			current = null;
			if (taken === null || taken.id !== id || taken.spoiled) return null;
			return Buffer.concat(taken.parts, taken.size);
		},
	};
}

/** The file a send_media command describes, or null when it is not one this sidecar sends. */
export function fileOf(command) {
	const { kind, name, size, width, height } = command;
	const text = command.text ?? "";
	if (!isSafeName(name) || typeof text !== "string" || text.length > 8000) return null;
	if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) return null;
	const extension = extensionOf(name);
	if (REFUSED_EXTENSIONS.has(extension)) return null;
	if (kind === "photo") {
		if (!PHOTO_EXTENSIONS.has(extension) || !isDimension(width) || !isDimension(height)) return null;
		return { kind, name, size, width, height, text };
	}
	if (kind !== "file" || PHOTO_EXTENSIONS.has(extension) || text !== "") return null;
	return { kind, name, size, width: 0, height: 0, text: "" };
}

/** An upload that failed: no message was created. */
export class UploadError extends Error {
	constructor(code, zaloCode) {
		super("upload failed");
		this.name = "UploadError";
		this.code = code;
		this.zaloCode = zaloCode;
	}
}

/** The code for an error of the upload. */
function uploadFailure(error) {
	if (error === null || typeof error !== "object" || error.name !== "ZcaApiError") return new UploadError(UPLOAD_FAILED);
	const message = typeof error.message === "string" ? error.message : "";
	if (message.startsWith(HTTP_FAILED)) {
		const status = Number(message.slice(HTTP_FAILED.length));
		if (status === 429) return new UploadError(RATE_LIMITED);
		if (status === 401 || status === 403) return new UploadError(SESSION_REJECTED);
		return new UploadError(UPLOAD_FAILED);
	}
	if (message.includes(" size exceed maximum size of ")) return new UploadError(TOO_LARGE);
	if (FILE_MESSAGES.some((start) => message.startsWith(start))) return new UploadError(FILE_REFUSED);
	const zaloCode = Number(error.code);
	if (error.code !== null && Number.isInteger(zaloCode)) return new UploadError(REFUSED, zaloCode);
	return new UploadError(UPLOAD_FAILED);
}

/**
 * Wraps the API's uploadAttachment, which sendMessage calls through the API object: it fails with
 * an UploadError after timeoutMs, on any error, and when it does not return one result per source.
 * An upload that ends after the time limit is dropped; sendMessage has already failed, so nothing
 * is posted.
 */
export function guardUploads(api, timeoutMs = UPLOAD_TIMEOUT_MS) {
	const upload = api.uploadAttachment;
	api.uploadAttachment = (sources, ...rest) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new UploadError(UPLOAD_FAILED)), timeoutMs);
			const count = Array.isArray(sources) ? sources.length : 1;
			Promise.resolve()
				.then(() => upload(sources, ...rest))
				.then(
					(results) => {
						clearTimeout(timer);
						const complete = Array.isArray(results) && results.length === count && results.every((r) => r !== null && typeof r === "object");
						if (complete) resolve(results);
						else reject(new UploadError(UPLOAD_FAILED));
					},
					(error) => {
						clearTimeout(timer);
						reject(uploadFailure(error));
					},
				);
		});
}

/** Thrown when Zalo took the file but named no message: it may exist. */
class NoMessageIdError extends Error {
	constructor() {
		super("no message id");
		this.name = "NoMessageIdError";
	}
}

/** Sends one photo or file, `data` being its bytes, to the user `to`; returns the id Zalo gave the message. */
export async function sendMedia(api, to, file, data) {
	const attachment = { data, filename: file.name, metadata: { totalSize: data.length, width: file.width, height: file.height } };
	const result = await api.sendMessage({ msg: file.text, attachments: [attachment] }, to, ThreadType.User);
	const id = result?.attachment?.[0]?.msgId;
	const msgId = typeof id === "number" || typeof id === "string" ? String(id) : "";
	if (!/^[0-9]{1,30}$/.test(msgId)) throw new NoMessageIdError();
	return { msgId, ts: Date.now() };
}

/** The code (and Zalo's own numeric code, when it gave one) for an error thrown by sendMedia. */
export function sendMediaFailure(error) {
	if (error instanceof UploadError) return error.zaloCode === undefined ? { code: error.code } : { code: error.code, zaloCode: error.zaloCode };
	return sendFailure(error);
}


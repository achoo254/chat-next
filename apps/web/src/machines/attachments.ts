// Files sent with a message to the AI on a machine (tunelo 2.0.5+): checked
// against the machine's limits, uploaded in pieces over the machine's
// end-to-end encrypted link (never through the chat server), then named by
// the message. Images the AI takes as images keep a local preview, and
// images shown again from a thread's history are fetched over the same link
// and kept as object URLs while the page lives.
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { AttachmentLimits, Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";

type AttachmentRequest = Extract<NonNullable<MessageInitShape<typeof FrameSchema>["body"]>, { case: "attachmentUpload" | "attachmentCancel" | "attachmentFetch" }>;

/** What the composer needs of the machine's link. */
export interface UploadLink {
	request(body: AttachmentRequest): Promise<Frame>;
}

/** Limits as plain numbers (AttachmentLimits carries bigints). */
export interface Limits {
	readonly fileMaxBytes: number;
	readonly messageMaxBytes: number;
	readonly messageMaxFiles: number;
	readonly imageMaxBytes: number;
	readonly pieceMaxBytes: number;
}

export function limitsOf(l: AttachmentLimits | undefined): Limits | null {
	if (l === undefined) return null;
	return {
		fileMaxBytes: Number(l.fileMaxBytes),
		messageMaxBytes: Number(l.messageMaxBytes),
		messageMaxFiles: l.messageMaxFiles,
		imageMaxBytes: Number(l.imageMaxBytes),
		pieceMaxBytes: l.pieceMaxBytes,
	};
}

/** Image types an AI takes as images (the machine checks the bytes again). */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A file the browser may turn into one of IMAGE_TYPES (a phone photo in HEIC, say). */
export function looksLikeImage(file: Pick<File, "type">): boolean {
	return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

export type Refusal =
	| { readonly kind: "too-large"; readonly name: string }
	| { readonly kind: "too-many" }
	| { readonly kind: "total-too-large" };

/**
 * Which of `added` fit next to `held` (sizes in bytes, as they will be
 * sent): files over the per-file limit are refused by name, and once the
 * count or the total of a message is reached the rest are refused.
 */
export function admit<T extends { readonly name: string; readonly size: number }>(
	held: readonly { readonly size: number }[],
	added: readonly T[],
	limits: Limits,
): { accepted: T[]; refused: Refusal[] } {
	const accepted: T[] = [];
	const refused: Refusal[] = [];
	let count = held.length;
	let total = held.reduce((sum, f) => sum + f.size, 0);
	for (const file of added) {
		if (file.size > limits.fileMaxBytes) {
			refused.push({ kind: "too-large", name: file.name });
			continue;
		}
		if (count >= limits.messageMaxFiles) {
			if (!refused.some((r) => r.kind === "too-many")) refused.push({ kind: "too-many" });
			continue;
		}
		if (total + file.size > limits.messageMaxBytes) {
			if (!refused.some((r) => r.kind === "total-too-large")) refused.push({ kind: "total-too-large" });
			continue;
		}
		accepted.push(file);
		count += 1;
		total += file.size;
	}
	return { accepted, refused };
}

/** An upload id the machine accepts (letters, digits and "-"). */
export function newUploadId(): string {
	return crypto.randomUUID();
}

/** Pieces in flight at once: the machine handles them in order, so a few keep the link busy without waiting. */
const IN_FLIGHT = 4;

export class UploadCancelled extends Error {
	constructor() {
		super("upload cancelled");
	}
}

/**
 * Uploads `file` as `uploadId` for `threadId`, in pieces; `onProgress` gets
 * the bytes the machine acknowledged. Aborting stops sending and drops what
 * the machine got (AttachmentCancel). Rejects with the machine's error.
 */
export async function uploadFile(
	link: UploadLink,
	opts: { threadId: string; uploadId: string; file: Blob & { readonly name: string }; pieceBytes: number; signal: AbortSignal; onProgress: (sent: number) => void },
): Promise<void> {
	const { file, uploadId, threadId, signal } = opts;
	const size = file.size;
	const piece = Math.max(1, opts.pieceBytes);
	const offsets: number[] = [];
	for (let at = 0; at < size; at += piece) offsets.push(at);
	if (offsets.length === 0) offsets.push(0);
	let sent = 0;
	const inFlight = new Set<Promise<void>>();
	try {
		for (const offset of offsets) {
			const data = new Uint8Array(await file.slice(offset, Math.min(size, offset + piece)).arrayBuffer());
			if (signal.aborted) throw new UploadCancelled();
			const first = offset === 0;
			// Requests go on the wire in the order they are made: pieces arrive in order.
			const answer = link
				.request({
					case: "attachmentUpload",
					value: {
						uploadId,
						threadId: first ? threadId : "",
						name: first ? file.name : "",
						mimeType: first ? file.type : "",
						size: first ? BigInt(size) : 0n,
						offset: BigInt(offset),
						data,
					},
				})
				.then(() => {
					sent += data.length;
					if (!signal.aborted) opts.onProgress(sent);
				});
			// A failure is seen where it is awaited; never left unhandled meanwhile.
			answer.catch(() => undefined);
			// The first piece opens the upload on the machine before any other goes.
			if (first) {
				await answer;
				continue;
			}
			inFlight.add(answer);
			void answer.finally(() => inFlight.delete(answer)).catch(() => undefined);
			if (inFlight.size >= IN_FLIGHT) await Promise.race(inFlight);
		}
		await Promise.all(inFlight);
		if (signal.aborted) throw new UploadCancelled();
	} catch (err) {
		if (signal.aborted) {
			link.request({ case: "attachmentCancel", value: { uploadId } }).catch(() => undefined);
			throw new UploadCancelled();
		}
		throw err;
	}
}

/** Previews of images by thread and attachment id: local ones from the upload, others fetched from the machine. */
const previews = new Map<string, string>();
const fetching = new Map<string, Promise<string>>();
/** Object URLs kept at most; the oldest go first. */
const PREVIEWS_MAX = 200;

const previewKey = (threadId: string, id: string) => `${threadId}\u0000${id}`;

function keep(key: string, url: string): void {
	previews.delete(key);
	previews.set(key, url);
	while (previews.size > PREVIEWS_MAX) {
		const [oldest, old] = previews.entries().next().value ?? [];
		if (oldest === undefined || old === undefined) break;
		previews.delete(oldest);
		URL.revokeObjectURL(old);
	}
}

/** Remembers the preview of an image just sent, so the thread shows it without asking the machine. */
export function rememberPreview(threadId: string, id: string, url: string): void {
	keep(previewKey(threadId, id), url);
}

export function knownPreview(threadId: string, id: string): string | undefined {
	return previews.get(previewKey(threadId, id));
}

/** The image as an object URL: kept, or fetched once from the machine (end-to-end encrypted). */
export function fetchPreview(link: UploadLink, threadId: string, id: string): Promise<string> {
	const key = previewKey(threadId, id);
	const known = previews.get(key);
	if (known !== undefined) return Promise.resolve(known);
	let pending = fetching.get(key);
	if (pending === undefined) {
		pending = link
			.request({ case: "attachmentFetch", value: { threadId, attachmentId: id } })
			.then((frame) => {
				if (frame.body.case !== "attachmentData") throw new Error("no image");
				const { data, mimeType } = frame.body.value;
				const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mimeType }));
				keep(key, url);
				return url;
			})
			.finally(() => fetching.delete(key));
		fetching.set(key, pending);
	}
	return pending;
}

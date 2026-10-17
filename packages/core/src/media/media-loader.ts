// Download URLs and downloads of media. URLs are signed per (file,
// rendition, viewer, message) and short-lived: they are asked for in
// batches (GetFileUrls, up to 100, coalesced within a tick), reused until
// shortly before they expire, and asked for again by (chat_id, seq) when the
// media host answers 401/403 (expired) — once, without bothering the user.
// A 404 or an "unavailable" answer means the message is gone or no longer
// visible: its cached files are dropped.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Http } from "@app/platform";
import type { GetFileUrlRequestSchema } from "@app/proto-ts/media";
import type { MediaKind, MediaSizeType } from "../model/types.ts";
import type { RemoteApi } from "../protocol/api.ts";
import { toSizeType, toWireId, toWireSizeType } from "../protocol/map.ts";
import { cacheKey, LARGE_FILE_BYTES, type MediaCache } from "./media-cache.ts";

/** A file of a message to fetch, of an inline query's results or a profile photo (chatId and seq 0). */
export interface MediaRequest {
	readonly chatId: number;
	readonly seq: number;
	readonly fileId: string;
	/** A result of the caller's inline query: the file's context instead of a message. */
	readonly inlineQueryId?: string;
	/** The profile photo of this user (User.photoId): the file's context instead of a message. */
	readonly userPhotoOf?: number;
	/** The photo of this group or channel (Chat.photoId): the file's context instead of a message. */
	readonly chatPhotoOf?: number;
	/** Rendition wanted; the original when absent. */
	readonly size?: MediaSizeType;
	/** Video counts against the large-file cache budget whatever its size. */
	readonly kind?: MediaKind;
}

export interface MediaUrl {
	readonly url: string;
	/** Unix seconds. */
	readonly expiresAt: number;
	/** Rendition the URL serves (the original when the wanted one does not exist). */
	readonly size: MediaSizeType;
}

export type MediaFile =
	| { readonly status: "ok"; readonly blob: Blob; readonly size: MediaSizeType }
	/** The message was deleted or is no longer visible. */
	| { readonly status: "unavailable" };

export interface MediaLoaderOptions {
	readonly api: NonNullable<RemoteApi["media"]>;
	readonly http: Http;
	readonly cache: MediaCache;
	/** Milliseconds. */
	readonly now: () => number;
}

/** Most requests per GetFileUrls call. */
export const URLS_PER_CALL = 100;
/** Ask again this long before a URL expires. */
const EXPIRY_MARGIN_S = 30;

interface Pending {
	readonly request: MediaRequest;
	resolve(url: MediaUrl | null): void;
	reject(error: unknown): void;
}

function urlKey(r: MediaRequest): string {
	return `${r.fileId}:${r.size ?? "original"}:${r.chatId}:${r.seq}:${r.inlineQueryId ?? ""}:${r.userPhotoOf ?? 0}:${r.chatPhotoOf ?? 0}`;
}

export class MediaLoader {
	private readonly urls = new Map<string, MediaUrl>();
	private batch: Pending[] = [];
	private readonly downloads = new Map<string, Promise<MediaFile>>();

	constructor(private readonly options: MediaLoaderOptions) {}

	/**
	 * A signed URL for the file (for streaming video, or the UI's own
	 * fetch); null when the message is gone. `refresh` skips the reused URL
	 * (the media host answered 401/403).
	 */
	async url(request: MediaRequest, refresh = false): Promise<MediaUrl | null> {
		const key = urlKey(request);
		const known = this.urls.get(key);
		if (!refresh && known !== undefined && this.options.now() / 1000 < known.expiresAt - EXPIRY_MARGIN_S) return known;
		this.urls.delete(key);
		const url = await new Promise<MediaUrl | null>((resolve, reject) => {
			this.batch.push({ request, resolve, reject });
			if (this.batch.length === 1) queueMicrotask(() => void this.flush());
		});
		if (url === null) {
			await this.options.cache.dropMessage(request.chatId, request.seq);
			return null;
		}
		this.urls.set(key, url);
		return url;
	}

	/** The file from the cache, or downloaded (and cached within the budgets). */
	async file(request: MediaRequest): Promise<MediaFile> {
		const key = cacheKey(request.fileId, request.size ?? "original");
		const cached = await this.options.cache.get(key);
		if (cached !== null) {
			await this.options.cache.addRef(key, request.chatId, request.seq);
			return { status: "ok", blob: cached, size: request.size ?? "original" };
		}
		const flight = `${key}:${request.chatId}:${request.seq}`;
		let download = this.downloads.get(flight);
		if (download === undefined) {
			download = this.download(request, key).finally(() => this.downloads.delete(flight));
			this.downloads.set(flight, download);
		}
		return download;
	}

	private async download(request: MediaRequest, key: string): Promise<MediaFile> {
		let url = await this.url(request);
		for (let attempt = 0; ; attempt++) {
			if (url === null) return { status: "unavailable" };
			const response = await this.options.http.get(url.url);
			if (response.status >= 200 && response.status < 300 && response.body !== null) {
				const blob = response.body;
				const large = blob.size > LARGE_FILE_BYTES || request.kind === "video";
				await this.options.cache.put(key, blob, request.chatId, request.seq, large);
				return { status: "ok", blob, size: url.size };
			}
			if ((response.status === 401 || response.status === 403) && attempt === 0) {
				url = await this.url(request, true);
				continue;
			}
			if (response.status === 404 || response.status === 410) {
				this.urls.delete(urlKey(request));
				await this.options.cache.dropMessage(request.chatId, request.seq);
				return { status: "unavailable" };
			}
			throw new ConnectError(`media download failed (HTTP ${response.status})`, Code.Unavailable);
		}
	}

	private async flush(): Promise<void> {
		const batch = this.batch;
		this.batch = [];
		for (let i = 0; i < batch.length; i += URLS_PER_CALL) {
			const chunk = batch.slice(i, i + URLS_PER_CALL);
			try {
				const response = await this.options.api.getFileUrls({
					requests: chunk.map(({ request }) => ({
						fileId: request.fileId,
						size: toWireSizeType(request.size ?? "original"),
						context: fileContext(request),
					})),
				});
				chunk.forEach((pending, index) => {
					const result = response.results[index];
					if (result === undefined || result.unavailable || result.url === "") {
						pending.resolve(null);
						return;
					}
					pending.resolve({ url: result.url, expiresAt: Number(result.expiresAt), size: toSizeType(result.size) });
				});
			} catch (err) {
				for (const pending of chunk) pending.reject(err);
			}
		}
	}
}

/** Where the file is seen: a message, an inline query's results, a profile photo or a chat's photo. */
function fileContext(request: MediaRequest): NonNullable<MessageInitShape<typeof GetFileUrlRequestSchema>["context"]> {
	if (request.userPhotoOf !== undefined) return { case: "userPhotoOf", value: toWireId(request.userPhotoOf) };
	if (request.chatPhotoOf !== undefined) return { case: "chatPhotoOf", value: toWireId(request.chatPhotoOf) };
	if (request.inlineQueryId !== undefined) return { case: "inlineQueryId", value: request.inlineQueryId };
	return { case: "message", value: { chatId: toWireId(request.chatId), seq: toWireId(request.seq) } };
}

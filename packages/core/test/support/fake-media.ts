// In-memory MediaService plus the HTTP side of uploads (presigned part
// PUTs) and downloads (signed media URLs), close enough to the server
// contract to test the client: multipart sessions with ETags, resume that
// lists no parts (the storage cannot be listed), URL expiry (403), revoked
// messages (404), owner dedupe and refused content.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { BlobStore, BlobStoreFactory, Http, HttpGetResult, HttpPutResult } from "@app/platform";
import {
	AbortUploadResponseSchema,
	CompleteUploadResponseSchema,
	CreateUploadResponseSchema,
	GetFileUrlsResponseSchema,
	MediaKind,
	MediaRefSchema,
	MediaSizeType,
	type MediaRef as WireMediaRef,
} from "@app/proto-ts/media";
import { AppConfigSchema, GetAppConfigResponseSchema } from "@app/proto-ts/config";
import type { RemoteApi } from "../../src/protocol/api.ts";

interface UploadSessionRecord {
	readonly id: string;
	readonly owner: number;
	readonly kind: MediaKind;
	readonly fileName: string;
	readonly mimeType: string;
	readonly size: number;
	readonly fileHash: string;
	readonly width: number;
	readonly height: number;
	readonly inlineThumb: Uint8Array;
	readonly parts: Map<number, { etag: string; bytes: Uint8Array }>;
	urlGeneration: number;
	result: WireMediaRef | null;
}

interface FileRecord {
	readonly ref: WireMediaRef;
	readonly bytes: Uint8Array;
	readonly owner: number;
}

/** Memory BlobStore factory; stores survive reopening until destroyed. */
export class MemoryBlobs implements BlobStoreFactory {
	readonly stores = new Map<string, Map<string, Blob>>();

	async open(name: string): Promise<BlobStore> {
		const map = (): Map<string, Blob> => {
			let m = this.stores.get(name);
			if (m === undefined) {
				m = new Map();
				this.stores.set(name, m);
			}
			return m;
		};
		return {
			get: async (key) => map().get(key) ?? null,
			put: async (key, blob) => {
				map().set(key, blob);
			},
			delete: async (key) => {
				map().delete(key);
			},
			destroy: async () => {
				this.stores.delete(name);
			},
		};
	}
}

export class FakeMedia {
	partSize = 4;
	/** Seconds the part and download URLs live. */
	urlTtl = 3600;
	/** Server clock (unix seconds), adjustable to expire URLs. */
	clock = (): number => Math.floor(Date.now() / 1000);
	readonly calls = new Map<string, number>();
	/** Called before every part PUT; a returned status is answered instead of storing. */
	putFault: ((part: number, attempt: number) => number | null) | null = null;
	/** CompleteUpload answers once with this code before working (or after, when lostResponse). */
	completeFault: { code: Code; lostResponse: boolean } | null = null;
	/** Kinds refused at completion (content does not match). */
	readonly refuse = new Set<MediaKind>();
	/** Messages deleted for everyone: their URLs answer 404. */
	readonly revoked = new Set<string>();
	/** Profile photos by user (user_photo_of context). */
	readonly photos = new Map<number, string>();
	/** Groups' and channels' photos by chat (chat_photo_of context). */
	readonly chatPhotos = new Map<number, string>();
	/** Upload ids the server forgot (expired). */
	readonly expired = new Set<string>();
	inFlight = 0;
	maxInFlight = 0;
	putDelayMs = 2;
	readonly puts: number[] = [];
	readonly gets: string[] = [];

	private readonly sessions = new Map<string, UploadSessionRecord>();
	readonly files = new Map<string, FileRecord>();
	private readonly attempts = new Map<string, number>();
	private nextId = 1;

	private count(method: string): void {
		this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
	}

	/** Bytes the server stored for a file id. */
	bytesOf(fileId: string): Uint8Array | undefined {
		return this.files.get(fileId)?.bytes;
	}

	file(fileId: string): WireMediaRef {
		const file = this.files.get(fileId);
		if (file === undefined) throw new ConnectError("file not found", Code.NotFound);
		return file.ref;
	}

	private session(owner: number, uploadId: string): UploadSessionRecord {
		const session = this.sessions.get(uploadId);
		if (session === undefined || session.owner !== owner || this.expired.has(uploadId)) {
			throw new ConnectError("upload not found", Code.NotFound);
		}
		return session;
	}

	private sessionResponse(session: UploadSessionRecord): ReturnType<typeof create<typeof CreateUploadResponseSchema>> {
		const count = Math.max(1, Math.ceil(session.size / this.partSize));
		const parts = [];
		for (let part = 1; part <= count; part++) {
			parts.push({ partNumber: part, url: `https://s3.test/${session.id}/${part}?g=${session.urlGeneration}` });
		}
		return create(CreateUploadResponseSchema, {
			result: {
				case: "upload",
				value: {
					uploadId: session.id,
					partSize: BigInt(this.partSize),
					parts,
					// The storage cannot be listed: never reports stored parts.
					completedParts: [],
					urlsExpireAt: BigInt(this.clock() + this.urlTtl),
				},
			},
		});
	}

	apiFor(owner: number): NonNullable<RemoteApi["media"]> {
		return {
			createUpload: async (request) => {
				await Promise.resolve();
				this.count("createUpload");
				if (request.uploadId !== undefined && request.uploadId !== "") {
					const session = this.session(owner, request.uploadId);
					session.urlGeneration++;
					return this.sessionResponse(session);
				}
				const hash = request.fileHash ?? "";
				for (const file of this.files.values()) {
					if (file.owner === owner && file.ref.fileHash === hash && Number(file.ref.size) === Number(request.size ?? 0n)) {
						return create(CreateUploadResponseSchema, { result: { case: "existing", value: file.ref } });
					}
				}
				const id = `up${this.nextId++}`;
				const session: UploadSessionRecord = {
					id,
					owner,
					kind: request.kind ?? MediaKind.UNSPECIFIED,
					fileName: request.fileName ?? "",
					mimeType: request.mimeType ?? "",
					size: Number(request.size ?? 0n),
					fileHash: hash,
					width: request.width ?? 0,
					height: request.height ?? 0,
					inlineThumb: request.inlineThumb ?? new Uint8Array(),
					parts: new Map(),
					urlGeneration: 1,
					result: null,
				};
				this.sessions.set(id, session);
				return this.sessionResponse(session);
			},
			completeUpload: async (request) => {
				await Promise.resolve();
				this.count("completeUpload");
				const fault = this.completeFault;
				if (fault !== null && !fault.lostResponse) {
					this.completeFault = null;
					throw new ConnectError("injected", fault.code);
				}
				const session = this.session(owner, request.uploadId ?? "");
				if (session.result === null) {
					const count = Math.max(1, Math.ceil(session.size / this.partSize));
					const given = new Map((request.parts ?? []).map((p) => [p.partNumber ?? 0, p.etag ?? ""]));
					const chunks: Uint8Array[] = [];
					for (let part = 1; part <= count; part++) {
						const stored = session.parts.get(part);
						if (stored === undefined || given.get(part) !== stored.etag) {
							throw new ConnectError(`part ${part} missing`, Code.FailedPrecondition);
						}
						chunks.push(stored.bytes);
					}
					const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
					let offset = 0;
					for (const c of chunks) {
						bytes.set(c, offset);
						offset += c.length;
					}
					if (bytes.length !== session.size) throw new ConnectError("size mismatch", Code.FailedPrecondition);
					if (this.refuse.has(session.kind)) throw new ConnectError("content does not match the kind", Code.InvalidArgument);
					const fileId = `f${this.nextId++}`;
					const ref = create(MediaRefSchema, {
						fileId,
						fileHash: session.fileHash,
						kind: session.kind,
						mimeType: session.mimeType,
						size: BigInt(session.size),
						fileName: session.fileName,
						width: session.width,
						height: session.height,
						inlineThumb: session.inlineThumb,
						sizes: session.kind === MediaKind.PHOTO ? [{ type: MediaSizeType.S, width: 1, height: 1, size: 1n }] : [],
					});
					this.files.set(fileId, { ref, bytes, owner });
					session.result = ref;
				}
				if (fault !== null && fault.lostResponse) {
					this.completeFault = null;
					throw new ConnectError("injected lost response", fault.code);
				}
				return create(CompleteUploadResponseSchema, { media: session.result });
			},
			abortUpload: async (request) => {
				await Promise.resolve();
				this.count("abortUpload");
				this.sessions.delete(request.uploadId ?? "");
				return create(AbortUploadResponseSchema, {});
			},
			getFileUrls: async (request) => {
				await Promise.resolve();
				this.count("getFileUrls");
				const results = (request.requests ?? []).map((r) => {
					const context = r.context;
					if (context?.case === "userPhotoOf" || context?.case === "chatPhotoOf") {
						const owner = Number(context.value);
						const photos = context.case === "userPhotoOf" ? this.photos : this.chatPhotos;
						if (photos.get(owner) !== r.fileId) return { unavailable: true };
						const expires = this.clock() + this.urlTtl;
						const path = context.case === "userPhotoOf" ? "photo" : "chatphoto";
						return { url: `https://media.test/f/${r.fileId ?? ""}/${path}/${owner}/${expires}`, expiresAt: BigInt(expires), size: r.size ?? MediaSizeType.UNSPECIFIED };
					}
					if (context?.case !== "message" || !this.files.has(r.fileId ?? "")) return { unavailable: true };
					const chatId = Number(context.value.chatId ?? 0n);
					const seq = Number(context.value.seq ?? 0n);
					if (this.revoked.has(`${chatId}:${seq}`)) return { unavailable: true };
					const expires = this.clock() + this.urlTtl;
					const size = r.size ?? MediaSizeType.UNSPECIFIED;
					return {
						url: `https://media.test/f/${r.fileId ?? ""}/${size}/${chatId}/${seq}/${expires}`,
						expiresAt: BigInt(expires),
						size,
					};
				});
				return create(GetFileUrlsResponseSchema, { results });
			},
		};
	}

	configApi(uploadSizeMax: number, cache: { size: number; large: number; ageSeconds: number }): NonNullable<RemoteApi["config"]> {
		return {
			getAppConfig: async () =>
				create(GetAppConfigResponseSchema, {
					result: {
						case: "config",
						value: create(AppConfigSchema, {
							hash: "h1",
							captionLengthMax: 1024,
							albumSizeMax: 10,
							uploadSizeMaxBytes: BigInt(uploadSizeMax),
							mediaCacheSizeBytes: BigInt(cache.size),
							mediaCacheLargeFilesBytes: BigInt(cache.large),
							mediaCacheMaxAgeSeconds: cache.ageSeconds,
						}),
					},
				}),
		};
	}

	readonly http: Http = {
		put: async (url, body, signal): Promise<HttpPutResult> => {
			const match = /^https:\/\/s3\.test\/([^/]+)\/(\d+)\?g=(\d+)$/.exec(url);
			if (match === null) return { status: 404, etag: "" };
			const [, id = "", partText = "0", generation = "0"] = match;
			const part = Number(partText);
			this.inFlight++;
			this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, this.putDelayMs));
				signal?.throwIfAborted();
				const attemptKey = `${id}:${part}`;
				const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
				this.attempts.set(attemptKey, attempt);
				const injected = this.putFault?.(part, attempt) ?? null;
				if (injected !== null) return { status: injected, etag: "" };
				const session = this.sessions.get(id);
				if (session === undefined) return { status: 404, etag: "" };
				if (Number(generation) !== session.urlGeneration) return { status: 403, etag: "" };
				const bytes = new Uint8Array(await body.arrayBuffer());
				const etag = `"${id}-${part}-${bytes.length}-${attempt}"`;
				session.parts.set(part, { etag, bytes });
				this.puts.push(part);
				return { status: 200, etag };
			} finally {
				this.inFlight--;
			}
		},
		get: async (url): Promise<HttpGetResult> => {
			await Promise.resolve();
			this.gets.push(url);
			const photo = /^https:\/\/media\.test\/f\/([^/]+)\/(photo|chatphoto)\/(\d+)\/(\d+)$/.exec(url);
			if (photo !== null) {
				const [, fileId = "", path = "", owner = "", expires = "0"] = photo;
				const file = this.files.get(fileId);
				const photos = path === "photo" ? this.photos : this.chatPhotos;
				if (file === undefined || photos.get(Number(owner)) !== fileId) return { status: 404, body: null };
				if (Number(expires) < this.clock()) return { status: 403, body: null };
				return { status: 200, body: new Blob([file.bytes.slice()], { type: file.ref.mimeType }) };
			}
			const match = /^https:\/\/media\.test\/f\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
			if (match === null) return { status: 404, body: null };
			const [, fileId = "", , chatId = "", seq = "", expires = "0"] = match;
			if (this.revoked.has(`${chatId}:${seq}`)) return { status: 404, body: null };
			if (Number(expires) < this.clock()) return { status: 403, body: null };
			const file = this.files.get(fileId);
			if (file === undefined) return { status: 404, body: null };
			return { status: 200, body: new Blob([file.bytes.slice()], { type: file.ref.mimeType }) };
		},
	};
}

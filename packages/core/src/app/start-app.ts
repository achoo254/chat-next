// startApp is the DI point of the client (ADR 0007): it takes the platform
// implementations and returns the core the UI talks to. The same function
// runs in the web worker and, later, on the native main thread.
import type { BlobStore, Platform, SqlDriver } from "@app/platform";
import { ClientPlatform } from "@app/proto-ts/auth";
import { databaseName, type SessionEndReason } from "../auth/web.ts";
import { EventBus, EventKeys } from "../events/bus.ts";
import { assertSafeId } from "../ids/index.ts";
import type { Chat, Message, MessageEntity, NotificationSettings, PinnedMessagesPage, User } from "../model/types.ts";
import {
	Outbox,
	OutboxError,
	type AlbumItemInput,
	type MediaInput,
	type PendingMessage,
	type SendAlbumOptions,
	type SendMediaOptions,
	type SendTextOptions,
} from "../outbox/outbox.ts";
import { DEFAULT_MEDIA_LIMITS, MediaLimitsSource, type MediaLimits } from "../media/limits.ts";
import { cacheKey, LARGE_FILE_BYTES, MediaCache } from "../media/media-cache.ts";
import { MediaLoader, type MediaFile, type MediaRequest, type MediaUrl } from "../media/media-loader.ts";
import { UploadQueue, type UploadProgress } from "../media/upload-queue.ts";
import { classifyFailure, SessionEndedError, type FailureKind, type RemoteApi } from "../protocol/api.ts";
import { toUser } from "../protocol/map.ts";
import { migrate } from "../repo/migrations.ts";
import { Repository, type DialogView, type StoredMessage } from "../repo/repository.ts";
import { searchLocal, type SearchOptions } from "../search/index.ts";
import { buildSnapshot, type ScreenSnapshot } from "../snapshot/snapshot.ts";
import { SyncEngine, type HistoryDirectionName } from "../sync/engine.ts";
import { RealtimeConnection, type ConnectionState } from "../transport/realtime.ts";
import { DirectActions, UnsupportedApiError, type PinnedMessagesRequest } from "./direct-actions.ts";

export type ClientKind = "web" | "ios" | "android" | "desktop";

const CLIENT_PLATFORMS: Record<ClientKind, ClientPlatform> = {
	web: ClientPlatform.WEB,
	ios: ClientPlatform.IOS,
	android: ClientPlatform.ANDROID,
	desktop: ClientPlatform.DESKTOP,
};

export interface StartOptions {
	readonly api: RemoteApi;
	/**
	 * WebSocket endpoint of the realtime gateway; on the web
	 * realtimeUrlFor(location.origin), i.e. wss://<host>/ws.
	 */
	readonly realtimeUrl: string;
	readonly appVersion: string;
	readonly client: ClientKind;
	/** Tenant host or domain; part of the local database name. */
	readonly tenant: string;
	/** The user of the last session on this device; skips GetSelf on a warm start. */
	readonly userIdHint?: number;
	/** Upper bound on message text in code points (AppConfig). */
	readonly maxTextLength?: number;
	readonly onSessionEnded?: (reason: SessionEndReason) => void;
	readonly onError?: (error: unknown, context: string) => void;
}

export interface HistoryRequest {
	readonly direction?: HistoryDirectionName;
	/** 0 with "older" = from the newest message. */
	readonly offsetSeq?: number;
	readonly limit?: number;
}

export interface HistoryView {
	/** Ascending by seq. */
	readonly messages: readonly StoredMessage[];
	/** Unconfirmed sends, shown after the newest message (only on the newest page). */
	readonly pending: readonly PendingMessage[];
	readonly hasOlder: boolean;
	readonly hasNewer: boolean;
	/** Set when the server could not be asked; the page is what the cache has. */
	readonly failure: FailureKind | null;
}

export interface ChatCore {
	readonly userId: number;
	readonly events: EventBus;
	connectionState(): ConnectionState;
	sessionEnded(): SessionEndReason | null;
	dialogs(limit?: number): Promise<DialogView[]>;
	history(chatId: number, request?: HistoryRequest): Promise<HistoryView>;
	users(ids: readonly number[]): Promise<User[]>;
	chat(chatId: number): Promise<Chat | null>;
	/**
	 * Queues a message and returns it as pending. Pass `randomId` when the
	 * request may be repeated; null then means it was already confirmed.
	 */
	sendText(
		chatId: number,
		text: string,
		options?: SendTextOptions,
	): Promise<PendingMessage | null>;
	editText(chatId: number, seq: number, text: string, entities?: readonly MessageEntity[]): Promise<void>;
	deleteMessages(chatId: number, seqs: readonly number[], forEveryone: boolean): Promise<void>;
	/** Marks the chat read up to maxSeq; also clears a "marked as unread". */
	markRead(chatId: number, maxSeq: number): Promise<void>;
	/** Marks a chat as unread, or clears the mark, on every session (online only). */
	setDialogUnreadMark(chatId: number, unread: boolean): Promise<void>;
	/** The user's notification settings, synced from the server. */
	notificationSettings(): Promise<NotificationSettings>;
	/** Changes some notification settings (online only); returns all of them. */
	setNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationSettings>;
	/** A page of the chat's (or a topic's) pinned messages, newest first (online only). */
	pinnedMessages(chatId: number, request?: PinnedMessagesRequest): Promise<PinnedMessagesPage>;
	/** Unpins every pinned message of the chat, or of one forum topic (online only). */
	unpinAllMessages(chatId: number, topicId?: number): Promise<void>;
	/** Members of a group online now, counted by the server (online only). */
	onlineCount(chatId: number): Promise<number>;
	/** The app badge: unread messages and chats, muted chats per the user's setting. */
	unreadTotals(): Promise<{ readonly messages: number; readonly chats: number }>;
	/**
	 * Queues a file (photo, video, file, voice) with an optional caption.
	 * The pending message (with `media`) shows at once; the upload runs in
	 * the background and survives reloads. Photos without width/height or
	 * thumbnail are measured on the device when the platform can.
	 */
	sendMedia(chatId: number, file: Blob, media: MediaInput, options?: SendMediaOptions): Promise<PendingMessage | null>;
	/** Queues 2 to MediaLimits.albumSizeMax files as one album. */
	sendAlbum(chatId: number, items: readonly AlbumItemInput[], options?: SendAlbumOptions): Promise<PendingMessage[]>;
	/** State of a pending media send's upload (PendingMedia.uploadKey); events: EventKeys.upload(key). */
	uploadProgress(uploadKey: string): Promise<UploadProgress | null>;
	/** The local file of a pending media send, to show it before the upload ends. */
	pendingFile(uploadKey: string): Promise<Blob | null>;
	/** A message's file (or one rendition), from the media cache or downloaded into it. */
	mediaFile(request: MediaRequest): Promise<MediaFile>;
	/**
	 * A signed URL of a message's file, for streaming (video, large files);
	 * pass refresh when the media host answered 401/403. null: the message
	 * is gone.
	 */
	mediaUrl(request: MediaRequest, refresh?: boolean): Promise<MediaUrl | null>;
	/** Upload and cache limits from the server (defaults until fetched). */
	mediaLimits(): Promise<MediaLimits>;
	/** Bytes and files in the media cache. */
	mediaCacheUsage(): Promise<{ readonly bytes: number; readonly largeBytes: number; readonly files: number }>;
	/** Empties the media cache. */
	clearMediaCache(): Promise<void>;
	retryOutbox(outboxId: number): Promise<void>;
	discardOutbox(outboxId: number): Promise<void>;
	search(query: string, options?: SearchOptions): Promise<StoredMessage[]>;
	/** The chat on screen (0 = none), the seq being viewed and the large chats visible in the list. */
	openChat(chatId: number, anchorSeq?: number, visibleChatIds?: readonly number[]): void;
	snapshot(): Promise<ScreenSnapshot>;
	/** Wipes local data; the web app then posts the sign-out form. */
	signOut(): Promise<void>;
	/** Closes without wiping (another tab takes over the database). */
	close(): Promise<void>;
	/** True while sync or the outbox has work in flight. */
	readonly busy: boolean;
}

export type StartResult =
	| { readonly status: "active"; readonly core: ChatCore }
	| { readonly status: "signed_out"; readonly reason: SessionEndReason };

async function resolveUserId(options: StartOptions): Promise<number | SessionEndReason> {
	if (options.userIdHint !== undefined) return assertSafeId(options.userIdHint);
	try {
		const response = await options.api.users.getSelf({});
		if (response.user === undefined) throw new Error("GetSelf returned no user");
		return toUser(response.user).id;
	} catch (err) {
		if (classifyFailure(err) === "unauthenticated") return "unauthenticated";
		throw err;
	}
}

async function openDatabase(platform: Platform, name: string): Promise<SqlDriver> {
	let driver = await platform.sql.open(name);
	if ((await migrate(driver)) === "reset_required") {
		// Written by a newer build: the cache is disposable, the server is not.
		await driver.destroy();
		driver = await platform.sql.open(name);
		await migrate(driver);
	}
	return driver;
}

/** Notification preview of a message: its text, or the file name of a file without caption. */
function preview(message: Message): string {
	if (message.text !== "") return message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text;
	return message.media?.fileName ?? "";
}

function checkMediaRequest(request: MediaRequest): MediaRequest {
	assertSafeId(request.chatId);
	assertSafeId(request.seq);
	if (request.fileId === "") throw new RangeError("fileId is required");
	return request;
}

export async function startApp(platform: Platform, options: StartOptions): Promise<StartResult> {
	const resolved = await resolveUserId(options);
	if (typeof resolved === "string") return { status: "signed_out", reason: resolved };
	const userId = resolved;
	const driver = await openDatabase(platform, databaseName(options.tenant, userId));
	const report = (err: unknown, context: string): void => options.onError?.(err, context);
	const bus = new EventBus(platform.frame, (err) => report(err, "event listener"));
	const repo = new Repository(driver, bus);

	let ended: SessionEndReason | null = null;
	let openChatId = 0;
	// Media cache sweep after purges (set up once the cache exists).
	let sweepTimer: unknown = null;
	let unsubscribeSweep: () => void = () => undefined;

	const endSession = async (reason: SessionEndReason, wipe: boolean): Promise<void> => {
		if (ended !== null) return;
		ended = reason;
		for (const unsubscribe of unsubscribeLifecycle) unsubscribe();
		connection.stop();
		outbox.stop();
		uploads?.stop();
		engine.stop();
		if (sweepTimer !== null) platform.timers.clearTimeout(sweepTimer);
		unsubscribeSweep();
		try {
			if (wipe) await driver.destroy();
			else await driver.close();
		} catch (err) {
			report(err, "close local database");
		}
		if (wipe && blobStore !== null) {
			try {
				await blobStore.destroy();
			} catch (err) {
				report(err, "wipe media storage");
			}
		}
		bus.emit(EventKeys.session);
		bus.flush();
		if (wipe) options.onSessionEnded?.(reason);
	};
	const sessionEnded = (reason: SessionEndReason): void => {
		void endSession(reason, true);
	};

	const notifyIncoming = async (messages: readonly Message[]): Promise<void> => {
		const latest = new Map<number, Message>();
		for (const message of messages) {
			if (message.action === null) latest.set(message.chatId, message);
		}
		for (const message of latest.values()) {
			if (platform.lifecycle.isForeground() && message.chatId === openChatId) continue;
			const [chat, sender] = await Promise.all([repo.chat(message.chatId), repo.user(message.fromId)]);
			// Incoming webhooks post with from_id 0 under their own label.
			const senderName = message.integrationLabel !== "" ? message.integrationLabel : (sender?.name ?? "");
			const title = chat !== null && chat.title !== "" ? chat.title : senderName;
			const body = chat !== null && chat.type !== "private" && senderName !== "" ? `${senderName}: ${preview(message)}` : preview(message);
			platform.notify.show({ title, body, tag: `chat:${message.chatId}`, chatId: message.chatId });
		}
	};

	const engine = new SyncEngine({
		repo,
		api: options.api,
		timers: platform.timers,
		selfId: userId,
		onSessionEnded: (reason) => sessionEnded(reason === "unknown" ? "unauthenticated" : reason),
		onIncoming: (messages) => {
			notifyIncoming(messages).catch((err: unknown) => report(err, "notify"));
		},
		onReadElsewhere: (chatIds) => {
			for (const chatId of chatIds) platform.notify.clear(`chat:${chatId}`);
		},
		onError: report,
	});
	await engine.load();

	const actions = new DirectActions({ api: options.api, repo, engine, now: () => platform.timers.now() });

	// Media (R3): needs the platform's HTTP and blob storage and the server's
	// MediaService; without them the media methods are unsupported.
	const limits = new MediaLimitsSource(options.api.config);
	const mediaApi = options.api.media;
	const blobStore: BlobStore | null =
		platform.blobs === undefined ? null : await platform.blobs.open(databaseName(options.tenant, userId));
	const mediaDb = { query: driver.query.bind(driver), commit: (build: Parameters<typeof engine.commitLocal>[0]) => engine.commitLocal(build) };
	const cache =
		blobStore === null
			? null
			: new MediaCache({
					db: mediaDb,
					store: blobStore,
					now: () => platform.timers.now(),
					limits: () => limits.current.cache,
					onError: report,
				});
	const uploads =
		blobStore === null || platform.http === undefined || mediaApi === undefined
			? null
			: new UploadQueue({
					api: mediaApi,
					http: platform.http,
					store: blobStore,
					db: mediaDb,
					timers: platform.timers,
					emit: (key) => bus.emit(EventKeys.upload(key)),
					onSessionEnded: () => sessionEnded("unauthenticated"),
					onError: report,
				});
	const loader =
		cache === null || platform.http === undefined || mediaApi === undefined
			? null
			: new MediaLoader({ api: mediaApi, http: platform.http, cache, now: () => platform.timers.now() });

	const outbox = new Outbox({
		repo,
		api: options.api,
		engine,
		timers: platform.timers,
		selfId: userId,
		randomId: platform.randomId,
		...(options.maxTextLength === undefined ? {} : { maxTextLength: options.maxTextLength }),
		maxCaptionLength: DEFAULT_MEDIA_LIMITS.captionLengthMax,
		...(uploads === null ? {} : { uploads }),
		afterMediaSent: async (uploadKey, message) => {
			// The sender's own file becomes the cached original: no download to see it.
			const media = message.media;
			if (cache === null || uploads === null || media === undefined) return;
			const file = await uploads.file(uploadKey);
			if (file === null) return;
			const large = file.size > LARGE_FILE_BYTES || media.kind === "video";
			await cache.put(cacheKey(media.fileId, "original"), file, message.chatId, message.seq, large);
		},
		onSessionEnded: () => sessionEnded("unauthenticated"),
		onError: report,
	});

	let probing = false;
	const probeSession = async (): Promise<void> => {
		// A WebSocket handshake rejected with 401 looks like any other failed
		// connection in the browser; ask the RPC endpoint which one it was.
		if (probing) return;
		probing = true;
		try {
			await options.api.updates.getState({});
		} catch (err) {
			if (classifyFailure(err) === "unauthenticated") sessionEnded("unauthenticated");
		} finally {
			probing = false;
		}
	};

	const connection = new RealtimeConnection(
		{
			url: options.realtimeUrl,
			socket: platform.socket,
			timers: platform.timers,
			platform: CLIENT_PLATFORMS[options.client],
			appVersion: options.appVersion,
		},
		{
			onHello: (hello) => {
				if (hello.userId !== userId) {
					// The session cookie now belongs to another account.
					sessionEnded("user_changed");
					return;
				}
				engine.onConnected(hello);
				outbox.retryNow().catch((err: unknown) => report(err, "outbox retry"));
			},
			onUpdates: (batch) => engine.ingest(batch),
			onSessionEnded: (reason) => sessionEnded(reason),
			onHandshakeFailed: () => {
				void probeSession();
			},
			onStateChange: () => bus.emit(EventKeys.connection),
		},
	);

	const unsubscribeLifecycle = [
		platform.lifecycle.onForegroundChange((foreground) => connection.setForeground(foreground)),
		platform.lifecycle.onOnline(() => {
			connection.reconnectNow();
			outbox.retryNow().catch((err: unknown) => report(err, "outbox retry"));
		}),
	];
	connection.setForeground(platform.lifecycle.isForeground());

	const active = (): void => {
		if (ended !== null) throw new SessionEndedError(`session ended: ${ended}`);
	};

	// Purges (deleted, recalled, hidden messages, chats left) drop cache refs
	// through triggers; evict the files left without messages soon after.
	if (cache !== null) {
		unsubscribeSweep = bus.subscribeBatches((keys) => {
					if (sweepTimer !== null || !keys.some((key) => key.startsWith("history:"))) return;
					sweepTimer = platform.timers.setTimeout(() => {
						sweepTimer = null;
						if (ended === null) cache.evict().catch((err: unknown) => report(err, "media cache sweep"));
					}, 1000);
				});
	}

	const requireMedia = <T>(value: T | null): T => {
		if (value === null) throw new UnsupportedApiError("media");
		return value;
	};

	/** Fills in what the caller did not measure of a photo, and checks the server's limits. */
	const prepareMedia = async (file: Blob, media: MediaInput): Promise<MediaInput> => {
		const current = limits.current.fromServer ? limits.current : await limits.load().catch(() => limits.current);
		if (current.fromServer && current.uploadSizeMax === 0) throw new OutboxError("media is not available on this server");
		if (current.uploadSizeMax > 0 && file.size > current.uploadSizeMax) {
			throw new OutboxError(`the file is larger than ${current.uploadSizeMax} bytes`);
		}
		if (media.kind !== "photo" || platform.imageProbe === undefined) return media;
		if ((media.width ?? 0) > 0 && (media.height ?? 0) > 0 && (media.inlineThumb?.length ?? 0) > 0) return media;
		let info = null;
		try {
			info = await platform.imageProbe.probe(file);
		} catch (err) {
			report(err, "measure photo");
		}
		if (info === null) return media;
		return {
			...media,
			width: (media.width ?? 0) > 0 ? (media.width ?? 0) : info.width,
			height: (media.height ?? 0) > 0 ? (media.height ?? 0) : info.height,
			...((media.inlineThumb?.length ?? 0) === 0 && info.thumb !== null ? { inlineThumb: info.thumb } : {}),
		};
	};

	async function history(chatId: number, request: HistoryRequest = {}): Promise<HistoryView> {
		active();
		assertSafeId(chatId);
		const direction = request.direction ?? "older";
		const offsetSeq = assertSafeId(request.offsetSeq ?? 0);
		const limit = Math.max(1, Math.min(request.limit ?? 50, 200));
		const read = async (): Promise<StoredMessage[]> => {
			switch (direction) {
				case "older":
					return repo.messagesBefore(chatId, offsetSeq, limit);
				case "newer":
					return repo.messagesAfter(chatId, offsetSeq, limit);
				case "around": {
					const half = Math.ceil(limit / 2);
					return [
						...(await repo.messagesBefore(chatId, offsetSeq + 1, half)),
						...(await repo.messagesAfter(chatId, offsetSeq, limit - half)),
					];
				}
			}
		};
		let messages = await read();
		const dialog = await repo.dialog(chatId);
		const topSeq = dialog?.topSeq ?? 0;
		const newestLocal = messages[messages.length - 1]?.seq ?? offsetSeq;
		const reachesTop = direction !== "newer" ? offsetSeq === 0 || direction === "around" : true;
		const needsServer =
			messages.some((m) => m.stale) ||
			(direction !== "newer" && messages.length < limit && dialog?.historyStart !== true) ||
			(reachesTop && newestLocal < topSeq) ||
			(direction === "newer" && messages.length < limit && newestLocal < topSeq);
		let failure: FailureKind | null = null;
		let hasOlder = messages.length === limit || dialog?.historyStart !== true;
		let hasNewer = newestLocal < topSeq;
		if (needsServer) {
			try {
				const page = await engine.fetchHistory(chatId, direction, offsetSeq, limit);
				messages = await read();
				hasOlder = page.hasOlder || (direction === "newer" && messages.length > 0);
				hasNewer = page.hasNewer;
			} catch (err) {
				failure = classifyFailure(err);
				if (failure === "unauthenticated") sessionEnded("unauthenticated");
				else report(err, `history ${chatId}`);
			}
		}
		if (direction === "older" && offsetSeq === 0) hasNewer = false;
		// The session may have ended meanwhile: the database is gone.
		const pending = !hasNewer && ended === null ? await outbox.pendingMessages(chatId) : [];
		return { messages, pending, hasOlder, hasNewer, failure };
	}

	const core: ChatCore = {
		userId,
		events: bus,
		connectionState: () => connection.connectionState,
		sessionEnded: () => ended,
		dialogs: async (limit = 100) => {
			active();
			return repo.dialogViews(Math.max(1, Math.min(limit, 1000)));
		},
		history,
		users: async (ids) => {
			active();
			return repo.users(ids.map(assertSafeId));
		},
		chat: async (chatId) => {
			active();
			return repo.chat(assertSafeId(chatId));
		},
		sendText: async (chatId, text, sendOptions) => {
			active();
			return outbox.sendText(chatId, text, sendOptions);
		},
		editText: async (chatId, seq, text, entities) => {
			active();
			await outbox.editText(chatId, seq, text, entities);
		},
		deleteMessages: async (chatId, seqs, forEveryone) => {
			active();
			await outbox.deleteMessages(chatId, seqs, forEveryone);
		},
		markRead: async (chatId, maxSeq) => {
			active();
			await outbox.markRead(chatId, maxSeq);
			platform.notify.clear(`chat:${chatId}`);
		},
		setDialogUnreadMark: async (chatId, unread) => {
			active();
			await actions.setDialogUnreadMark(assertSafeId(chatId), unread);
		},
		notificationSettings: async () => {
			active();
			return actions.notificationSettings();
		},
		setNotificationSettings: async (change) => {
			active();
			return actions.setNotificationSettings(change);
		},
		pinnedMessages: async (chatId, request) => {
			active();
			return actions.pinnedMessages(assertSafeId(chatId), request);
		},
		unpinAllMessages: async (chatId, topicId = 0) => {
			active();
			await actions.unpinAllMessages(assertSafeId(chatId), assertSafeId(topicId));
		},
		onlineCount: async (chatId) => {
			active();
			return actions.onlineCount(assertSafeId(chatId));
		},
		unreadTotals: async () => {
			active();
			return actions.unreadTotals();
		},
		sendMedia: async (chatId, file, media, sendOptions) => {
			active();
			requireMedia(uploads);
			return outbox.sendMedia(chatId, file, await prepareMedia(file, media), sendOptions);
		},
		sendAlbum: async (chatId, items, albumOptions) => {
			active();
			requireMedia(uploads);
			const max = (limits.current.fromServer ? limits.current : await limits.load().catch(() => limits.current)).albumSizeMax;
			if (items.length > max) throw new OutboxError(`an album holds at most ${max} files`);
			const prepared = [];
			for (const item of items) prepared.push({ ...item, media: await prepareMedia(item.file, item.media) });
			return outbox.sendAlbum(chatId, prepared, albumOptions);
		},
		uploadProgress: async (uploadKey) => {
			active();
			return requireMedia(uploads).progress(uploadKey);
		},
		pendingFile: async (uploadKey) => {
			active();
			return requireMedia(uploads).file(uploadKey);
		},
		mediaFile: async (request) => {
			active();
			return requireMedia(loader).file(checkMediaRequest(request));
		},
		mediaUrl: async (request, refresh = false) => {
			active();
			return requireMedia(loader).url(checkMediaRequest(request), refresh);
		},
		mediaLimits: async () => {
			active();
			return limits.load().catch(() => limits.current);
		},
		mediaCacheUsage: async () => {
			active();
			return requireMedia(cache).usage();
		},
		clearMediaCache: async () => {
			active();
			await requireMedia(cache).clear();
		},
		retryOutbox: async (outboxId) => {
			active();
			await outbox.retry(outboxId);
		},
		discardOutbox: async (outboxId) => {
			active();
			await outbox.discard(outboxId);
		},
		search: async (query, searchOptions) => {
			active();
			return searchLocal(repo, query, searchOptions);
		},
		openChat: (chatId, anchorSeq = 0, visibleChatIds = []) => {
			openChatId = assertSafeId(chatId);
			engine.setOpenChat(openChatId, assertSafeId(anchorSeq));
			connection.setOpenChat(openChatId, visibleChatIds.map(assertSafeId));
			if (openChatId !== 0) platform.notify.clear(`chat:${openChatId}`);
		},
		snapshot: async () => {
			active();
			return buildSnapshot(repo, userId, openChatId, platform.timers.now());
		},
		signOut: async () => endSession("local_sign_out", true),
		close: async () => endSession("local_sign_out", false),
		get busy() {
			return engine.busy || outbox.busy || (uploads?.busy ?? false);
		},
	};

	if (uploads !== null) {
		await uploads.dropOrphans(await outbox.uploadKeys());
		await uploads.start();
	}
	void limits.load().catch((err: unknown) => report(err, "app config"));
	await outbox.start();
	connection.start();
	return { status: "active", core };
}

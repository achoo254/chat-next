// startApp is the DI point of the client (ADR 0007): it takes the platform
// implementations and returns the core the UI talks to. The same function
// runs in the web worker and, later, on the native main thread.
import type { Platform, SqlDriver } from "@app/platform";
import { ClientPlatform } from "@app/proto-ts/auth";
import { databaseName, type SessionEndReason } from "../auth/web.ts";
import { EventBus, EventKeys } from "../events/bus.ts";
import { assertSafeId } from "../ids/index.ts";
import type { Chat, Message, MessageEntity, NotificationSettings, PinnedMessagesPage, User } from "../model/types.ts";
import { Outbox, type PendingMessage, type SendTextOptions } from "../outbox/outbox.ts";
import { classifyFailure, SessionEndedError, type FailureKind, type RemoteApi } from "../protocol/api.ts";
import { toUser } from "../protocol/map.ts";
import { migrate } from "../repo/migrations.ts";
import { Repository, type DialogView, type StoredMessage } from "../repo/repository.ts";
import { searchLocal, type SearchOptions } from "../search/index.ts";
import { buildSnapshot, type ScreenSnapshot } from "../snapshot/snapshot.ts";
import { SyncEngine, type HistoryDirectionName } from "../sync/engine.ts";
import { RealtimeConnection, type ConnectionState } from "../transport/realtime.ts";
import { DirectActions, type PinnedMessagesRequest } from "./direct-actions.ts";

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

/** Notification preview of a message (text only until media lands in R3). */
function preview(message: Message): string {
	if (message.text !== "") return message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text;
	return "";
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

	const endSession = async (reason: SessionEndReason, wipe: boolean): Promise<void> => {
		if (ended !== null) return;
		ended = reason;
		for (const unsubscribe of unsubscribeLifecycle) unsubscribe();
		connection.stop();
		outbox.stop();
		engine.stop();
		try {
			if (wipe) await driver.destroy();
			else await driver.close();
		} catch (err) {
			report(err, "close local database");
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
			const senderName = sender?.name ?? "";
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

	const outbox = new Outbox({
		repo,
		api: options.api,
		engine,
		timers: platform.timers,
		selfId: userId,
		randomId: platform.randomId,
		...(options.maxTextLength === undefined ? {} : { maxTextLength: options.maxTextLength }),
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
			return engine.busy || outbox.busy;
		},
	};

	await outbox.start();
	connection.start();
	return { status: "active", core };
}

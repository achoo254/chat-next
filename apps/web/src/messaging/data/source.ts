// The part of the client core the messaging UI reads and writes. The web
// build gets it from @app/platform-web (the core runs in a worker, every call
// is asynchronous); tests wrap an in-process ChatCore. Fast-changing data is
// never passed through React context: components subscribe to ChatStore.
import type {
	Chat,
	ConnectionState,
	DialogView,
	EventBus,
	HistoryRequest,
	HistoryView,
	MessageEntity,
	NotificationSettings,
	PendingMessage,
	PinnedMessagesPage,
	PinnedMessagesRequest,
	SearchOptions,
	ScreenSnapshot,
	SendTextOptions,
	StoredMessage,
	User,
} from "@app/core";

export interface ChatSource {
	/** Change notifications, one batch per animation frame. */
	readonly events: EventBus;
	dialogs(limit?: number): Promise<DialogView[]>;
	history(chatId: number, request?: HistoryRequest): Promise<HistoryView>;
	users(ids: readonly number[]): Promise<User[]>;
	chat(chatId: number): Promise<Chat | null>;
	sendText(chatId: number, text: string, options?: SendTextOptions): Promise<PendingMessage | null>;
	editText(chatId: number, seq: number, text: string, entities?: readonly MessageEntity[]): Promise<void>;
	deleteMessages(chatId: number, seqs: readonly number[], forEveryone: boolean): Promise<void>;
	markRead(chatId: number, maxSeq: number): Promise<void>;
	/** "Đánh dấu chưa đọc", synced to the user's other sessions (online only). */
	setDialogUnreadMark(chatId: number, unread: boolean): Promise<void>;
	notificationSettings(): Promise<NotificationSettings>;
	setNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationSettings>;
	/** Pinned messages of a chat or forum topic, newest first (online only). */
	pinnedMessages(chatId: number, request?: PinnedMessagesRequest): Promise<PinnedMessagesPage>;
	unpinAllMessages(chatId: number, topicId?: number): Promise<void>;
	/** Members of a group online now, counted by the server (online only). */
	onlineCount(chatId: number): Promise<number>;
	/** The app badge: unread messages and chats, muted chats per the user's setting. */
	unreadTotals(): Promise<{ readonly messages: number; readonly chats: number }>;
	retryOutbox(outboxId: number): Promise<void>;
	discardOutbox(outboxId: number): Promise<void>;
	search(query: string, options?: SearchOptions): Promise<StoredMessage[]>;
	openChat(chatId: number, anchorSeq?: number, visibleChatIds?: readonly number[]): Promise<void>;
	connectionState(): Promise<ConnectionState>;
}

/** Extras of the web client: cold-start snapshot and the sign-out route. */
export interface WebExtras {
	coldSnapshot(): ScreenSnapshot | null;
	saveSnapshot(): Promise<void>;
	signOutAndLeave(): Promise<void>;
	dispose(): void;
}

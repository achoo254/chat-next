// The part of the client core the messaging UI reads and writes. The web
// build gets it from @app/platform-web (the core runs in a worker, every call
// is asynchronous); tests wrap an in-process ChatCore. Fast-changing data is
// never passed through React context: components subscribe to ChatStore.
import type {
	AlbumItemInput,
	Chat,
	ChatTyping,
	ConnectionState,
	DialogView,
	EventBus,
	HistoryRequest,
	HistoryView,
	MediaFile,
	MediaInput,
	MediaLimits,
	MediaRequest,
	MediaUrl,
	MessageEntity,
	NotificationSettings,
	PendingMessage,
	PinnedMessagesPage,
	PinnedMessagesRequest,
	SearchOptions,
	ScreenSnapshot,
	ServerSearchRequest,
	ServerSearchResult,
	SendAlbumOptions,
	SendMediaOptions,
	SendTextOptions,
	StoredMessage,
	TypingAction,
	UploadProgress,
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
	/** Hides or shows a bot message's reply keyboard on this device (kept locally). */
	setKeyboardHidden(chatId: number, seq: number, hidden: boolean): Promise<void>;
	/** The bot's newest message in the chat that sets or removes a reply keyboard (local database); null for none. */
	botKeyboard(chatId: number, botId: number): Promise<StoredMessage | null>;
	notificationSettings(): Promise<NotificationSettings>;
	setNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationSettings>;
	/** Pinned messages of a chat or forum topic, newest first (online only). */
	pinnedMessages(chatId: number, request?: PinnedMessagesRequest): Promise<PinnedMessagesPage>;
	unpinAllMessages(chatId: number, topicId?: number): Promise<void>;
	/** Members of a group online now, counted by the server (online only). */
	onlineCount(chatId: number): Promise<number>;
	/** Who is typing in which chat; changes arrive as EventKeys.typing. */
	typing(): Promise<ChatTyping[]>;
	/** Tells the open chat the user types ("cancel": the draft was cleared); repeats are throttled. */
	sendTyping(chatId: number, topicId: number, action: TypingAction | "cancel"): Promise<void>;
	/** Queues a file with an optional caption; the pending message shows at once and uploads in the background. */
	sendMedia(chatId: number, file: Blob, media: MediaInput, options?: SendMediaOptions): Promise<PendingMessage | null>;
	/** Queues 2 to MediaLimits.albumSizeMax files as one album. */
	sendAlbum(chatId: number, items: readonly AlbumItemInput[], options?: SendAlbumOptions): Promise<PendingMessage[]>;
	/** Upload state of a pending media send; changes arrive as EventKeys.upload(uploadKey). */
	uploadProgress(uploadKey: string): Promise<UploadProgress | null>;
	/** The local file of a pending media send (shown before the upload ends). */
	pendingFile(uploadKey: string): Promise<Blob | null>;
	/** A message's file or rendition, from the media cache or downloaded into it. */
	mediaFile(request: MediaRequest): Promise<MediaFile>;
	/** A short-lived URL of a message's file (video, downloads); `refresh` after a 401/403. null: the message is gone. */
	mediaUrl(request: MediaRequest, refresh?: boolean): Promise<MediaUrl | null>;
	/** Upload limits from AppConfig; uploadSizeMax 0 means media is off on the server. */
	mediaLimits(): Promise<MediaLimits>;
	retryOutbox(outboxId: number): Promise<void>;
	discardOutbox(outboxId: number): Promise<void>;
	search(query: string, options?: SearchOptions): Promise<StoredMessage[]>;
	/** One page of the server's message search; failures come back as a result, not thrown. */
	searchServer(request: ServerSearchRequest): Promise<ServerSearchResult>;
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

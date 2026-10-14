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
	PendingMessage,
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

// Chat Bridge on the client side (BridgeService, ADR 0022): the user
// connects an account of another app (Telegram first) and chooses which of
// its conversations Chat copies in. Types only; the Connect client
// (bridge-client.ts) loads with the settings tab, so none of it ships with the
// messaging chunk. Nothing here carries a message, a phone number or a code
// past the call that needs it.

export type BridgeAccountStatus = "active" | "needs_login" | "stopped";

/** `in`: the other app is the source and Chat sends nothing back. `both`: what is written in the chat is sent on too. */
export type BridgeDirection = "in" | "both";

/** A conversation of the other app that Chat copies. */
export interface BridgeChat {
	/** The conversation's id in the other app (opaque). */
	readonly conversationId: string;
	readonly chatId: number;
	/** The first import has reached the newest message. */
	readonly caughtUp: boolean;
	readonly historyWindow: number;
	/** The conversation's name in the other app. */
	readonly title: string;
	readonly direction: BridgeDirection;
	/** The chat is split into topics like the conversation it copies. */
	readonly topicsSplit: boolean;
}

export interface BridgeAccount {
	readonly id: number;
	readonly source: string;
	readonly status: BridgeAccountStatus;
	/** Why the connection last failed; "" when fine. */
	readonly lastError: string;
	readonly chats: readonly BridgeChat[];
}

export interface BridgeStatus {
	/** The apps the server can connect. */
	readonly apps: readonly string[];
	readonly accounts: readonly BridgeAccount[];
}

export interface LoginField {
	readonly name: string;
	readonly label: string;
	/** A phone number, code or password: not shown back, never stored. */
	readonly secret: boolean;
}

/** The next thing a login asks of the user. */
export type LoginStep =
	| { readonly kind: "input"; readonly loginId: string; readonly fields: readonly LoginField[]; readonly prompt: string }
	| { readonly kind: "qr" | "confirm"; readonly loginId: string; readonly prompt: string }
	| { readonly kind: "done"; readonly account: BridgeAccount | null };

export type ConversationKind = "private" | "bot" | "group" | "channel";

export interface BridgeConversation {
	readonly id: string;
	readonly kind: ConversationKind;
	readonly title: string;
	/** The synced chat; 0 when not synced. */
	readonly chatId: number;
	/** The conversation is split into topics in the app (a forum). */
	readonly forum: boolean;
	/** Its synced chat is split into topics too; false for a forum copied before topics were read (remove it and enable it again to split it). */
	readonly topicsSplit: boolean;
}

export type BridgeErrorKind =
	| "disabled"
	| "reauth"
	| "wrong_input"
	| "rate_limited"
	| "account_taken"
	| "not_found"
	| "send_unsupported"
	| "other";

/** A failed call. `detail` is the machine code of a wrong answer (wrong_code, wrong_password…). */
export class BridgeError extends Error {
	constructor(
		readonly kind: BridgeErrorKind,
		readonly detail: string = "",
	) {
		super(`${kind}${detail === "" ? "" : `: ${detail}`}`);
	}
}

/** What a chat has queued for the other app and not finished (a message that is not listed was sent). */
export interface BridgeOutboxItem {
	readonly seq: number;
	readonly op: "send" | "edit" | "delete";
	/** `pending`: waiting; `sending`: on its way; `failed`: refused or given up; `unknown`: may or may not have arrived. */
	readonly status: "pending" | "sending" | "failed" | "unknown";
	/** Why it failed or waits; a short machine-ish text, shown only as a detail. */
	readonly lastError: string;
	readonly attempts: number;
}

export interface BridgeApi {
	status(): Promise<BridgeStatus>;
	startLogin(source: string): Promise<LoginStep>;
	continueLogin(loginId: string, input: Readonly<Record<string, string>>): Promise<LoginStep>;
	conversations(accountId: number): Promise<readonly BridgeConversation[]>;
	/** Starts copying; returns the chat. `historyWindow` is how many of the newest messages to import. The chat sends both ways unless `direction` says `in` (an app that cannot be written to is always `in`). */
	enable(accountId: number, conversationId: string, historyWindow: number, direction?: BridgeDirection): Promise<number>;
	/** Switches a copy between receiving only and also sending on what is written in Chat. */
	setDirection(accountId: number, conversationId: string, direction: BridgeDirection): Promise<void>;
	/** What the chat has queued and not finished. */
	outbox(chatId: number): Promise<readonly BridgeOutboxItem[]>;
	/** Tries a failed or unknown message again. */
	retry(chatId: number, seq: number): Promise<void>;
	/** Gives up a failed edit or delete (a failed send is given up by deleting the message). */
	dismiss(chatId: number, seq: number): Promise<void>;
	/** Stops syncing and deletes the copy. */
	remove(accountId: number, conversationId: string): Promise<void>;
	/** Signs out of the app; with `deleteChats` the copies go too, otherwise they stay read-only. */
	disconnect(accountId: number, deleteChats: boolean): Promise<void>;
}

/** The sizes of history offered when a chat is enabled; it cannot be extended later (seq only grows at the end). */
export const HISTORY_WINDOWS: readonly number[] = [200, 500, 2000, 10000];
export const DEFAULT_HISTORY_WINDOW = 2000;

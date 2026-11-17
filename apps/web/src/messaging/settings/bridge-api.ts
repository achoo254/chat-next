// Chat Bridge on the client side (BridgeService, ADR 0022): the user
// connects an account of another app (Telegram first) and chooses which of
// its conversations Chat copies in. Types only; the Connect client
// (bridge-client.ts) loads with the settings tab, so none of it ships with the
// messaging chunk. Nothing here carries a message, a phone number or a code
// past the call that needs it.

export type BridgeAccountStatus = "active" | "needs_login" | "stopped";

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
}

export type BridgeErrorKind =
	| "disabled"
	| "reauth"
	| "wrong_input"
	| "rate_limited"
	| "account_taken"
	| "not_found"
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

export interface BridgeApi {
	status(): Promise<BridgeStatus>;
	startLogin(source: string): Promise<LoginStep>;
	continueLogin(loginId: string, input: Readonly<Record<string, string>>): Promise<LoginStep>;
	conversations(accountId: number): Promise<readonly BridgeConversation[]>;
	/** Starts copying; returns the chat. `historyWindow` is how many of the newest messages to import. */
	enable(accountId: number, conversationId: string, historyWindow: number): Promise<number>;
	/** Stops syncing and deletes the copy. */
	remove(accountId: number, conversationId: string): Promise<void>;
	/** Signs out of the app; with `deleteChats` the copies go too, otherwise they stay read-only. */
	disconnect(accountId: number, deleteChats: boolean): Promise<void>;
}

/** The sizes of history offered when a chat is enabled; it cannot be extended later (seq only grows at the end). */
export const HISTORY_WINDOWS: readonly number[] = [200, 500, 2000, 10000];
export const DEFAULT_HISTORY_WINDOW = 2000;

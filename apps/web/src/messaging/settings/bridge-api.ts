// Chat Bridge on the client side (BridgeService, ADR 0022): the user
// connects an account of another app (Telegram first) and chooses which of
// its conversations Chat copies in. Types only; the Connect client
// (bridge-client.ts) loads with the settings tab, so none of it ships with the
// messaging chunk. Nothing here carries a message, a phone number or a code
// past the call that needs it.

import type { BridgeFeatureView } from "./bridge-features-model.ts";

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

/** The account's one switch (ADR 0024): not synced yet, first import running, everything live. */
export type BridgeSyncState = "off" | "syncing" | "live";

/** How far the first import went. */
export interface BridgeSyncProgress {
	readonly conversations: number;
	readonly conversationsDone: number;
	readonly messages: number;
	readonly messagesExpected: number;
}

export interface BridgeAccount {
	readonly id: number;
	readonly source: string;
	readonly status: BridgeAccountStatus;
	/** Why the connection last failed; "" when fine. */
	readonly lastError: string;
	readonly chats: readonly BridgeChat[];
	readonly syncState: BridgeSyncState;
	readonly progress: BridgeSyncProgress;
	/** The app sends only once the owner switches sending on for the account (Zalo); `sendEnabled` is that switch. */
	readonly sendGated: boolean;
	readonly sendEnabled: boolean;
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

/** How a login call may be stopped: `signal` aborts it (the server then ends the login), `timeoutMs` gives up on a call that hangs. */
export interface LoginCallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export type BridgeErrorKind =
	| "disabled"
	| "reauth"
	| "wrong_input"
	| "rate_limited"
	| "account_taken"
	| "not_found"
	| "send_unsupported"
	| "feature_unsupported"
	| "feature_off"
	| "confirmation_wrong"
	/** The server could not be reached (offline, a gateway error, a call that timed out). */
	| "network"
	/** The call was aborted by the page itself. */
	| "canceled"
	| "other";

/** A failed call. `detail` is the machine code of a wrong answer (wrong_code, wrong_password…), or for `rate_limited` the seconds to wait when the server says. */
export class BridgeError extends Error {
	constructor(
		readonly kind: BridgeErrorKind,
		readonly detail: string = "",
	) {
		super(`${kind}${detail === "" ? "" : `: ${detail}`}`);
	}
}

/** A change of state the other app refused (already put back in Chat), told once: a pin, a topic, the info of the group, the state of the chat in the list. */
export type StateOp = "pin_message" | "pin_topic" | "set_topic" | "set_info" | "set_mute" | "set_dialog_pin" | "set_unread_mark";
export const STATE_OPS: readonly StateOp[] = ["pin_message", "pin_topic", "set_topic", "set_info", "set_mute", "set_dialog_pin", "set_unread_mark"];

/** What a chat has queued for the other app and not finished (a message that is not listed was sent). */
export interface BridgeOutboxItem {
	readonly seq: number;
	/** `pin_message` and `pin_topic` are a pin the app refused (already put back in Chat), told once; for a topic `seq` is its id in the chat. */
	readonly op: "send" | "edit" | "delete" | StateOp;
	/** `pending`: waiting; `sending`: on its way; `failed`: refused or given up; `unknown`: may or may not have arrived. */
	readonly status: "pending" | "sending" | "failed" | "unknown";
	/** Why it failed or waits; a short machine-ish text, shown only as a detail. */
	readonly lastError: string;
	readonly attempts: number;
}

/** An invite link of a group in the other app (not a Chat invite link). */
export interface BridgeInviteView {
	readonly link: string;
	readonly title: string;
	readonly revoked: boolean;
	readonly usage: number;
}

/** A person of the other app who is not in the group yet. */
export interface BridgeCandidate {
	readonly participantId: string;
	readonly name: string;
}

/** The second step of deleting a group: a token good from `usableFrom` until `expires` (Unix seconds). */
export interface GroupDeleteToken {
	readonly token: string;
	readonly usableFrom: number;
	readonly expires: number;
}


/** Something Chat queued for the other app that did not go through, of any feature. */
export interface BridgeProblem {
	readonly id: number;
	readonly chatId: number;
	readonly chatTitle: string;
	readonly feature: string;
	readonly op: string;
	readonly status: "failed" | "unknown";
	readonly lastError: string;
	readonly attempts: number;
	/** Unix seconds. */
	readonly at: number;
}

export interface BridgeApi {
	status(): Promise<BridgeStatus>;
	/** Turns the account's one switch on: every conversation syncs, both ways, live. */
	startSync(accountId: number): Promise<void>;
	/** Turns the account's sending switch on or off (only for an account with `sendGated`). Off makes every chat read-only and drops what is queued. */
	setSendEnabled(accountId: number, enabled: boolean): Promise<void>;
	problems(accountId: number): Promise<readonly BridgeProblem[]>;
	retryProblem(accountId: number, id: number): Promise<void>;
	/** Gives up a problem that is not a send. */
	dismissProblem(accountId: number, id: number): Promise<void>;
	/** The invite links the account made for the group in the other app. */
	invites(accountId: number, conversationId: string): Promise<readonly BridgeInviteView[]>;
	createInvite(accountId: number, conversationId: string, title: string): Promise<void>;
	revokeInvite(accountId: number, conversationId: string, link: string): Promise<void>;
	/** People of the account who are not in the group. */
	candidates(accountId: number, conversationId: string): Promise<readonly BridgeCandidate[]>;
	addMember(accountId: number, conversationId: string, participantId: string): Promise<void>;
	/** Leaves the group in the other app; `confirmName` must be the name of the chat. */
	leaveGroup(accountId: number, conversationId: string, confirmName: string): Promise<void>;
	/** First step of deleting the group for everybody in the other app. */
	requestGroupDelete(accountId: number, conversationId: string, confirmName: string): Promise<GroupDeleteToken>;
	/** Second step: deletes the group, history included. Cannot be undone. */
	deleteGroup(accountId: number, conversationId: string, confirmName: string, token: string): Promise<void>;
	/** What a synced chat can sync, feature by feature: only what the app supports, with the direction now in effect. */
	features(accountId: number, conversationId: string): Promise<readonly BridgeFeatureView[]>;
	startLogin(source: string, options?: LoginCallOptions): Promise<LoginStep>;
	/** With no input on a QR or confirm step: waits (on the server, up to about 20 s) for news of the login. */
	continueLogin(loginId: string, input: Readonly<Record<string, string>>, options?: LoginCallOptions): Promise<LoginStep>;
	/** What the chat has queued and not finished. */
	outbox(chatId: number): Promise<readonly BridgeOutboxItem[]>;
	/** Tries a failed or unknown message again. */
	retry(chatId: number, seq: number): Promise<void>;
	/** Gives up a failed edit or delete (a failed send is given up by deleting the message). */
	dismiss(chatId: number, seq: number): Promise<void>;
	/** Signs out of the app; with `deleteChats` the copies go too, otherwise they stay read-only. */
	disconnect(accountId: number, deleteChats: boolean): Promise<void>;
}

/** What every sign-in card (by fields or by QR code) is given by the settings page. */
export interface BridgeLoginProps {
	api: BridgeApi;
	source: string;
	appName: string;
	onDone: () => void;
	onCancel: () => void;
	onError: (err: unknown) => BridgeError;
}


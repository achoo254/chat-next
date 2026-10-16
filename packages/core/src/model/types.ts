// Client models. Every id is a number below 2^53 (ADR 0001); the protocol
// mapping in ../protocol/map.ts is the only code that sees bigint.

export type ChatType = "private" | "group" | "channel" | "secret" | "unknown";
export type SyncMode = "small" | "large";
export type MemberRole = "member" | "admin" | "owner" | "unknown";

export interface User {
	readonly id: number;
	readonly username: string;
	readonly name: string;
	readonly bio: string;
	readonly isBot: boolean;
	readonly isSelf: boolean;
	readonly isBlocked: boolean;
	/** The account was deleted (or waits for deletion): username, name and bio are empty; show it as a deleted account. */
	readonly deleted?: boolean;
}

export interface Chat {
	readonly id: number;
	readonly type: ChatType;
	readonly title: string;
	readonly about: string;
	/** Private and secret chats: the other participant; 0 otherwise. */
	readonly peerUserId: number;
	readonly syncMode: SyncMode;
	/** true: new members read history from before they joined. */
	readonly historyShared: boolean;
	readonly memberCount: number;
	readonly defaultPermissions: number;
	readonly pinnedSeq: number;
	readonly createdAt: number;
	readonly myRole: MemberRole;
	readonly myPermissions: number;
	/** The user is no longer a member. */
	readonly left: boolean;
	/**
	 * Left because someone else (an admin) removed the user, as told by
	 * member_removed; false when the user left or the cause is unknown.
	 */
	readonly removed: boolean;
	/** Groups only: messages are organised in forum topics. */
	readonly forum: boolean;
}

/** Topic of a forum group; topic 1 is the default "General" topic. */
export interface ForumTopic {
	readonly chatId: number;
	readonly id: number;
	readonly title: string;
	/** 0xRRGGBB. */
	readonly iconColor: number;
	readonly creatorId: number;
	readonly createdAt: number;
	readonly pinned: boolean;
	readonly closed: boolean;
	readonly hidden: boolean;
	readonly topSeq: number;
}

/** Text-only preview of the first web link of a message. */
/**
 * A button under a message (inline keyboard). Incoming webhooks and bots post
 * URL buttons; bots also post callback buttons, whose data goes back to the
 * bot through PressInlineButton. url is null and callbackData absent for
 * kinds this client does not handle yet (Mini Apps, inline queries).
 */
export interface MessageButton {
	readonly text: string;
	readonly url: string | null;
	/** Bot callback button: its callback_data as standard base64 (1 to 64 bytes). */
	readonly callbackData?: string;
}

/**
 * The reply keyboard a bot message sets for the chat (Telegram's reply
 * markup): rows of button texts that replace the composer's keyboard, or the
 * request to remove the one shown. Tapping a button sends its text as the
 * user's own message.
 */
export type ReplyKeyboard =
	| {
			readonly kind: "keyboard";
			readonly rows: readonly (readonly string[])[];
			/** Hide the keyboard after one tap. */
			readonly oneTime: boolean;
			/** Placeholder for the composer while the keyboard shows; "" for the default. */
			readonly placeholder: string;
			/**
			 * Hidden on this device (a one-time keyboard after its tap, or the
			 * user's toggle); kept locally, never from the server.
			 */
			readonly hidden: boolean;
			/** Only for users mentioned in the text or the replied-to message's author. */
			readonly selective: boolean;
	  }
	| { readonly kind: "remove"; readonly selective: boolean };

export interface LinkPreview {
	readonly url: string;
	readonly siteName: string;
	readonly title: string;
	readonly description: string;
	/** The page's image, a server-owned photo fetched in the message's context. */
	readonly photo?: MediaRef;
}

export interface Dialog {
	readonly chatId: number;
	readonly topSeq: number;
	readonly readInboxMaxSeq: number;
	readonly readOutboxMaxSeq: number;
	readonly unreadCount: number;
	readonly unreadMentionsCount: number;
	/** sync_mode=large only: position in the chat's log; 0 otherwise. */
	readonly chatPts: number;
	/**
	 * Notifications muted until this unix second; 0 when not muted.
	 * MUTE_FOREVER means until unmuted. See isMuted.
	 */
	readonly muteUntil: number;
	/** Pinned on top of the user's list (order: pinnedChatIds). */
	readonly pinned: boolean;
	/** Pinned messages of the chat the user can see, and the newest of them (0 = none). */
	readonly pinnedMessageCount: number;
	readonly pinnedMessageSeq: number;
	/** The user marked the chat as unread; reading it clears the mark. */
	readonly unreadMark: boolean;
	/**
	 * Unix second the list orders the chat by: its newest message. Kept by
	 * the server when the user clears "Cloud của tôi", so the empty chat
	 * keeps its place; 0 when unknown.
	 */
	readonly sortDate: number;
}

/** Dialog.muteUntil of a chat muted until unmuted. */
export const MUTE_FOREVER = 2147483647;

/** Most chats one user can pin (SetDialogPinned refuses more). */
export const PINNED_DIALOGS_MAX = 5;

/** Whether the dialog's notifications are muted at `nowSeconds`. */
export function isMuted(dialog: Pick<Dialog, "muteUntil">, nowSeconds: number): boolean {
	return dialog.muteUntil > nowSeconds;
}

/**
 * Totals for the app's unread badge: unread messages and chats with unread
 * messages. A chat marked as unread counts as one unread message. Muted
 * chats are left out unless includeMuted (NotificationSettings.badgeMuted).
 */
export function unreadTotals(
	dialogs: Iterable<Pick<Dialog, "unreadCount" | "muteUntil"> & Partial<Pick<Dialog, "unreadMark">>>,
	nowSeconds: number,
	includeMuted = false,
): { readonly messages: number; readonly chats: number } {
	let messages = 0;
	let chats = 0;
	for (const dialog of dialogs) {
		const unread = dialog.unreadCount > 0 ? dialog.unreadCount : dialog.unreadMark === true ? 1 : 0;
		if (unread === 0 || (!includeMuted && isMuted(dialog, nowSeconds))) continue;
		messages += unread;
		chats += 1;
	}
	return { messages, chats };
}

export type NotificationSound = "default" | "soft" | "off";

/** The user's notification settings, kept on the server and synced to every session. */
export interface NotificationSettings {
	readonly privateEnabled: boolean;
	readonly privatePreview: boolean;
	readonly groupsEnabled: boolean;
	readonly groupsPreview: boolean;
	readonly channelsEnabled: boolean;
	readonly channelsPreview: boolean;
	readonly sound: NotificationSound;
	/** Count muted chats in the unread badge. */
	readonly badgeMuted: boolean;
}

/** Settings of a user who never changed them (the server's defaults). */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
	privateEnabled: true,
	privatePreview: true,
	groupsEnabled: true,
	groupsPreview: true,
	channelsEnabled: true,
	channelsPreview: true,
	sound: "default",
	badgeMuted: false,
};

export type EntityType =
	| "bold"
	| "italic"
	| "underline"
	| "strike"
	| "spoiler"
	| "code"
	| "pre"
	| "text_link"
	| "mention"
	| "mention_name"
	| "hashtag"
	| "url"
	| "email"
	| "bot_command"
	| "unknown";

export interface MessageEntity {
	readonly type: EntityType;
	/** UTF-16 code units (ADR 0004). */
	readonly offset: number;
	readonly length: number;
	/** text_link only. */
	readonly url?: string;
	/** mention_name only. */
	readonly userId?: number;
	/** pre only. */
	readonly language?: string;
}

export interface ReactionCount {
	readonly emoji: string;
	readonly count: number;
	readonly chosen: boolean;
	/** Up to 3 users who reacted with it most recently, newest first (empty in channels for non-admins). */
	readonly recentUserIds: readonly number[];
}

export interface ForwardHeader {
	readonly fromUserId: number;
	readonly fromChatId: number;
	readonly fromSeq: number;
	readonly fromName: string;
	readonly date: number;
}

/**
 * Why an incoming webhook stopped: an admin turned it off or deleted it, or
 * the server turned it off because its creator lost admin rights or left.
 */
export type HookStopReason = "disabled" | "deleted" | "creator_not_admin" | "creator_left" | "by_moderator" | "unknown";

/** System message shown inline in the history. */
export type MessageAction =
	| { readonly kind: "chat_created"; readonly title: string }
	| { readonly kind: "members_added"; readonly userIds: readonly number[] }
	| { readonly kind: "member_left" }
	| { readonly kind: "member_removed"; readonly userId: number; readonly by: number }
	| { readonly kind: "title_changed"; readonly title: string }
	| { readonly kind: "photo_changed" }
	| { readonly kind: "photo_removed" }
	| { readonly kind: "message_pinned"; readonly seq: number }
	| { readonly kind: "history_visibility_changed"; readonly visible: boolean }
	| { readonly kind: "chat_mode_changed" }
	| { readonly kind: "joined_by_invite" }
	/** An incoming webhook stopped posting; fromId is the admin, or 0 when the server turned it off. */
	| { readonly kind: "incoming_hook_stopped"; readonly hookName: string; readonly reason: HookStopReason }
	/** A kind this client does not know yet: rendered as "unsupported". */
	| { readonly kind: "unsupported" };

export type MediaKind = "photo" | "video" | "audio" | "voice" | "document" | "unknown";

/** Rendition of a file: the stored original, or a size made by the server (longest side S 320, M 800, X 1280). */
export type MediaSizeType = "original" | "s" | "m" | "x";

export interface MediaSize {
	readonly type: MediaSizeType;
	readonly width: number;
	readonly height: number;
	/** Bytes. */
	readonly size: number;
}

/** A file attached to a message: everything to lay it out and fetch it. */
export interface MediaRef {
	/** Opaque id bound to the owner and source chat; the cache key. */
	readonly fileId: string;
	/** Hex SHA-256 of the content. */
	readonly fileHash: string;
	readonly kind: MediaKind;
	readonly mimeType: string;
	/** Bytes of the original. */
	readonly size: number;
	readonly fileName: string;
	readonly width: number;
	readonly height: number;
	/** Milliseconds (video, audio, voice). */
	readonly duration: number;
	/** Tiny thumbnail rendered before anything is downloaded; empty when none. */
	readonly inlineThumb: Uint8Array;
	/** Renditions besides the original. */
	readonly sizes: readonly MediaSize[];
	/** Voice waveform, one byte per sample; empty when none. */
	readonly waveform: Uint8Array;
}

export interface Message {
	readonly chatId: number;
	readonly seq: number;
	readonly fromId: number;
	readonly date: number;
	readonly text: string;
	readonly entities: readonly MessageEntity[];
	/** Kind of the attached file, null for text; same as media.kind. */
	readonly mediaKind: MediaKind | null;
	/** The attached file (photo, video, file, voice); absent for text. */
	readonly media?: MediaRef;
	readonly replyToSeq: number;
	readonly forward: ForwardHeader | null;
	readonly editDate: number;
	readonly editVersion: number;
	/** Echoed only to the sender; 0 otherwise. */
	readonly randomId: number;
	readonly groupedId: number;
	readonly viaBotId: number;
	readonly reactions: readonly ReactionCount[];
	/** Label of the incoming webhook that posted it (shown as "Integration: <label>"); from_id is then 0. */
	readonly integrationLabel: string;
	/** Rows of inline buttons; empty when none. */
	readonly buttons: readonly (readonly MessageButton[])[];
	/** Bot messages: the reply keyboard they set or remove; absent otherwise. */
	readonly keyboard?: ReplyKeyboard;
	readonly action: MessageAction | null;
	/** Forum groups: the message's topic; 0 elsewhere. */
	readonly topicId: number;
	readonly linkPreview: LinkPreview | null;
	/**
	 * Deleted for everyone (recalled): a placeholder that keeps
	 * the message's place, with no content, reactions or reply.
	 */
	readonly recalled: boolean;
	/** Posted without a notification (silent incoming webhooks): no notification, no sound. */
	readonly silent: boolean;
}

export type SessionRevokeReason =
	| "signed_out"
	| "revoked_by_user"
	| "idp_grant_ended"
	| "expired"
	| "admin"
	/** The browser signed in again and holds the new session: reconnect, keep local data. */
	| "replaced"
	| "unknown";

/** Position of an update in the per-user log (pts) or a per-chat log (chatPts). */
export interface UpdatePosition {
	readonly pts: number;
	readonly ptsCount: number;
	readonly chatPts: number;
	readonly chatPtsCount: number;
	/** Chat whose per-chat log chatPts belongs to. */
	readonly chatId: number;
	readonly serverEpoch: number;
	readonly date: number;
}

export type UpdateBody =
	/**
	 * notify: whether this message may raise a notification (false for
	 * silent messages); an edit notifies only when an integration alert
	 * changed state (firing to resolved).
	 */
	| { readonly kind: "message_new"; readonly message: Message; readonly notify: boolean }
	| { readonly kind: "message_edit"; readonly message: Message; readonly notify: boolean }
	/** recalled: keep a placeholder in place of each message (older servers: remove them). */
	| {
			readonly kind: "message_delete";
			readonly chatId: number;
			readonly seqs: readonly number[];
			readonly recalled: boolean;
	  }
	| { readonly kind: "message_hidden"; readonly chatId: number; readonly seqs: readonly number[] }
	| {
			readonly kind: "reaction";
			readonly chatId: number;
			readonly seq: number;
			readonly reactions: readonly ReactionCount[];
	  }
	| {
			readonly kind: "read";
			readonly chatId: number;
			readonly maxSeq: number;
			readonly outbox: boolean;
			/** Inbox: unread messages of the whole chat after the read. */
			readonly unreadCount: number;
			/** Forum topic read (0 = the whole chat). */
			readonly topicId: number;
			/** Inbox, topicId != 0: unread messages left in the topic. */
			readonly topicUnreadCount: number;
			/** Inbox: the chat's newest seq when the counts were taken. */
			readonly topSeq: number;
			/** Inbox, sync_mode=large: the chat log position of the counts. */
			readonly chatPts: number;
			/** Inbox: unread messages that mention the user or reply to them, after the read. */
			readonly unreadMentionsCount: number;
	  }
	/** seqs: unpin all (pinned false, seq 0); otherwise empty. */
	| {
			readonly kind: "pin";
			readonly chatId: number;
			readonly seq: number;
			readonly pinned: boolean;
			readonly seqs: readonly number[];
	  }
	| {
			readonly kind: "member_added";
			readonly chatId: number;
			readonly userIds: readonly number[];
			readonly inviterId: number;
	  }
	| {
			readonly kind: "member_removed";
			readonly chatId: number;
			readonly userId: number;
			readonly actorId: number;
	  }
	| {
			readonly kind: "member_permissions";
			readonly chatId: number;
			readonly userId: number;
			readonly role: MemberRole;
			readonly permissions: number;
	  }
	| {
			readonly kind: "chat_mode_changed";
			readonly chatId: number;
			readonly syncMode: SyncMode;
			readonly chatPts: number;
	  }
	| { readonly kind: "chat_updated"; readonly chat: Chat }
	| { readonly kind: "topic_changed"; readonly topic: ForumTopic }
	| {
			readonly kind: "chat_activity";
			readonly chatId: number;
			readonly chatPts: number;
			readonly topSeq: number;
	  }
	| {
			readonly kind: "session_revoked";
			readonly sessionId: number;
			readonly reason: SessionRevokeReason;
	  }
	/** The user muted or unmuted a chat (another session or this one). */
	| { readonly kind: "dialog_mute"; readonly chatId: number; readonly muteUntil: number }
	/** The user's pinned chats, top first, after a change. */
	| { readonly kind: "pinned_dialogs"; readonly chatIds: readonly number[] }
	/**
	 * The chat left the user's list: deleted by its owner (forEveryone) or a
	 * private chat the user deleted for themselves. Purge it locally.
	 */
	| { readonly kind: "chat_deleted"; readonly chatId: number; readonly forEveryone: boolean }
	/** The user marked a chat as unread or the mark went away. */
	| { readonly kind: "dialog_unread_mark"; readonly chatId: number; readonly unread: boolean }
	/** The user's notification settings after a change. */
	| { readonly kind: "notification_settings"; readonly settings: NotificationSettings }
	/** A kind added to the protocol after this client was built. */
	| { readonly kind: "unknown" };

export type Update = UpdatePosition & { readonly body: UpdateBody };

/** Updates plus the users and chats they reference. */
export interface UpdateBatch {
	readonly updates: readonly Update[];
	readonly users: readonly User[];
	readonly chats: readonly Chat[];
}

export interface SyncState {
	readonly pts: number;
	readonly serverEpoch: number;
	readonly date: number;
}

export interface ChatSyncState {
	readonly chatId: number;
	readonly chatPts: number;
	readonly serverEpoch: number;
}

export interface LargeChatState {
	readonly chatId: number;
	readonly chatPts: number;
	readonly topSeq: number;
}

export type DifferenceResult =
	| { readonly kind: "empty" }
	| { readonly kind: "slice"; readonly batch: UpdateBatch; readonly largeChats: readonly LargeChatState[] }
	| { readonly kind: "full"; readonly batch: UpdateBatch; readonly largeChats: readonly LargeChatState[] }
	| { readonly kind: "too_long" };

export interface Difference {
	readonly state: SyncState;
	readonly result: DifferenceResult;
}

export interface ChatDifference {
	readonly state: ChatSyncState;
	readonly result: DifferenceResult;
}

/** Position of the caller's logs right after a mutation (SyncAck). */
export interface SyncAck {
	readonly pts: number;
	readonly ptsCount: number;
	readonly chatPts: number;
	readonly chatPtsCount: number;
	readonly serverEpoch: number;
}

export interface HistoryPage {
	/** Ascending by seq. */
	readonly messages: readonly Message[];
	readonly users: readonly User[];
	readonly hasOlder: boolean;
	readonly hasNewer: boolean;
}

export interface DialogsPage {
	readonly dialogs: readonly Dialog[];
	readonly messages: readonly Message[];
	readonly chats: readonly Chat[];
	readonly users: readonly User[];
	readonly nextCursor: string;
	/** First page of GetDialogs only: the pinned chats, top first; empty otherwise. */
	readonly pinnedChatIds: readonly number[];
}

/** A page of GetPinnedMessages: newest first, with the total the user can see. */
export interface PinnedMessagesPage {
	readonly messages: readonly Message[];
	readonly users: readonly User[];
	readonly count: number;
	readonly hasMore: boolean;
}

/** Narrows a message search, locally and on the server. Unset fields do not filter. */
export interface SearchFilters {
	/** Only messages from this sender; 0 = anyone. */
	readonly fromId?: number;
	/** Only messages carrying this kind of file. */
	readonly mediaKind?: MediaKind;
	/** Only messages with a link (URL, text link or link preview). */
	readonly hasLink?: boolean;
	/** Message date bounds in unix seconds, both inclusive; 0 = unbounded. */
	readonly since?: number;
	readonly until?: number;
}

/** Realtime HelloFrame. */
export interface Hello {
	readonly userId: number;
	readonly sessionId: number;
	readonly serverEpoch: number;
	readonly heartbeatIntervalMs: number;
	readonly serverTime: number;
}

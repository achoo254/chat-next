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
}

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
}

export interface ForwardHeader {
	readonly fromUserId: number;
	readonly fromChatId: number;
	readonly fromSeq: number;
	readonly fromName: string;
	readonly date: number;
}

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
	/** A kind this client does not know yet: rendered as "unsupported". */
	| { readonly kind: "unsupported" };

export type MediaKind = "photo" | "video" | "audio" | "voice" | "document" | "unknown";

export interface Message {
	readonly chatId: number;
	readonly seq: number;
	readonly fromId: number;
	readonly date: number;
	readonly text: string;
	readonly entities: readonly MessageEntity[];
	/** Media arrives with release R3; until then only its kind is kept. */
	readonly mediaKind: MediaKind | null;
	readonly replyToSeq: number;
	readonly forward: ForwardHeader | null;
	readonly editDate: number;
	readonly editVersion: number;
	/** Echoed only to the sender; 0 otherwise. */
	readonly randomId: number;
	readonly groupedId: number;
	readonly viaBotId: number;
	readonly reactions: readonly ReactionCount[];
	readonly integrationLabel: string;
	readonly action: MessageAction | null;
}

export type SessionRevokeReason =
	| "signed_out"
	| "revoked_by_user"
	| "idp_grant_ended"
	| "expired"
	| "admin"
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
	| { readonly kind: "message_new"; readonly message: Message }
	| { readonly kind: "message_edit"; readonly message: Message }
	| { readonly kind: "message_delete"; readonly chatId: number; readonly seqs: readonly number[] }
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
			readonly unreadCount: number;
	  }
	| { readonly kind: "pin"; readonly chatId: number; readonly seq: number; readonly pinned: boolean }
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
}

/** Realtime HelloFrame. */
export interface Hello {
	readonly userId: number;
	readonly sessionId: number;
	readonly serverEpoch: number;
	readonly heartbeatIntervalMs: number;
	readonly serverTime: number;
}

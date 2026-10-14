// The one place where protocol messages become client models (ADR 0001).
// protobuf-es decodes every int64 to bigint even with jstype = JS_NUMBER;
// each one passes assertSafeId here and leaves as a number, so the rest of
// the client never sees a bigint. toWireId is the reverse direction.
import type {
	Chat as WireChat,
	Dialog as WireDialog,
	ForumTopic as WireForumTopic,
	GetDialogsResponse,
	GetPeerDialogsResponse,
} from "@app/proto-ts/chats";
import { ChatType as WireChatType, HistoryVisibility, MemberRole as WireRole, SyncMode as WireSyncMode } from "@app/proto-ts/chats";
import { SessionRevokeReason as WireRevokeReason } from "@app/proto-ts/auth";
import { MediaKind as WireMediaKind } from "@app/proto-ts/media";
import type {
	GetHistoryResponse,
	ForwardHeader as WireForward,
	LinkPreview as WireLinkPreview,
	Message as WireMessage,
	MessageAction as WireAction,
	MessageEntity as WireEntity,
	ReactionCount as WireReaction,
	SyncAck as WireSyncAck,
} from "@app/proto-ts/messages";
import { EntityType as WireEntityType } from "@app/proto-ts/messages";
import type { HelloFrame, UpdateFrame } from "@app/proto-ts/realtime";
import type {
	ChatState as WireChatState,
	DifferenceUpdates,
	GetChatDifferenceResponse,
	GetDifferenceResponse,
	LargeChatState as WireLargeChatState,
	State as WireState,
	Update as WireUpdate,
} from "@app/proto-ts/updates";
import type { User as WireUser } from "@app/proto-ts/users";
import { assertSafeId } from "../ids/index.ts";
import type {
	Chat,
	ChatDifference,
	ChatSyncState,
	ChatType,
	Dialog,
	DialogsPage,
	Difference,
	DifferenceResult,
	EntityType,
	ForumTopic,
	ForwardHeader,
	Hello,
	HistoryPage,
	LargeChatState,
	LinkPreview,
	MediaKind,
	MemberRole,
	Message,
	MessageAction,
	MessageEntity,
	ReactionCount,
	SessionRevokeReason,
	SyncAck,
	SyncMode,
	SyncState,
	Update,
	UpdateBatch,
	UpdateBody,
	User,
} from "../model/types.ts";

/** Wire id from a client id; throws a RangeError outside [0, 2^53). */
export function toWireId(id: number): bigint {
	return BigInt(assertSafeId(id));
}

const id = assertSafeId;

const CHAT_TYPES: Record<number, ChatType> = {
	[WireChatType.PRIVATE]: "private",
	[WireChatType.GROUP]: "group",
	[WireChatType.CHANNEL]: "channel",
	[WireChatType.SECRET]: "secret",
};

const ROLES: Record<number, MemberRole> = {
	[WireRole.MEMBER]: "member",
	[WireRole.ADMIN]: "admin",
	[WireRole.OWNER]: "owner",
};

const ENTITY_TYPES: Record<number, EntityType> = {
	[WireEntityType.BOLD]: "bold",
	[WireEntityType.ITALIC]: "italic",
	[WireEntityType.UNDERLINE]: "underline",
	[WireEntityType.STRIKE]: "strike",
	[WireEntityType.SPOILER]: "spoiler",
	[WireEntityType.CODE]: "code",
	[WireEntityType.PRE]: "pre",
	[WireEntityType.TEXT_LINK]: "text_link",
	[WireEntityType.MENTION]: "mention",
	[WireEntityType.MENTION_NAME]: "mention_name",
	[WireEntityType.HASHTAG]: "hashtag",
	[WireEntityType.URL]: "url",
	[WireEntityType.EMAIL]: "email",
	[WireEntityType.BOT_COMMAND]: "bot_command",
};

const WIRE_ENTITY_TYPES = new Map<EntityType, WireEntityType>(
	Object.entries(ENTITY_TYPES).map(([wire, local]) => [local, Number(wire) as WireEntityType]),
);

const MEDIA_KINDS: Record<number, MediaKind> = {
	[WireMediaKind.PHOTO]: "photo",
	[WireMediaKind.VIDEO]: "video",
	[WireMediaKind.AUDIO]: "audio",
	[WireMediaKind.VOICE]: "voice",
	[WireMediaKind.DOCUMENT]: "document",
};

const REVOKE_REASONS: Record<number, SessionRevokeReason> = {
	[WireRevokeReason.SIGNED_OUT]: "signed_out",
	[WireRevokeReason.REVOKED_BY_USER]: "revoked_by_user",
	[WireRevokeReason.IDP_GRANT_ENDED]: "idp_grant_ended",
	[WireRevokeReason.EXPIRED]: "expired",
	[WireRevokeReason.ADMIN]: "admin",
};

function syncMode(mode: WireSyncMode): SyncMode {
	return mode === WireSyncMode.LARGE ? "large" : "small";
}

export function toRevokeReason(reason: WireRevokeReason): SessionRevokeReason {
	return REVOKE_REASONS[reason] ?? "unknown";
}

export function toUser(user: WireUser): User {
	return {
		id: id(user.id),
		username: user.username,
		name: user.name,
		bio: user.bio,
		isBot: user.isBot,
		isSelf: user.isSelf,
		isBlocked: user.isBlocked,
	};
}

export function toChat(chat: WireChat): Chat {
	return {
		id: id(chat.id),
		type: CHAT_TYPES[chat.type] ?? "unknown",
		title: chat.title,
		about: chat.about,
		peerUserId: id(chat.peerUserId),
		syncMode: syncMode(chat.syncMode),
		historyShared: chat.historyVisibility !== HistoryVisibility.SINCE_JOIN,
		memberCount: chat.memberCount,
		defaultPermissions: chat.defaultPermissions,
		pinnedSeq: id(chat.pinnedSeq),
		createdAt: id(chat.createdAt),
		myRole: ROLES[chat.myRole] ?? "unknown",
		myPermissions: chat.myPermissions,
		left: chat.left,
		forum: chat.forum,
	};
}

export function toForumTopic(topic: WireForumTopic): ForumTopic {
	return {
		chatId: id(topic.chatId),
		id: id(topic.id),
		title: topic.title,
		iconColor: topic.iconColor,
		creatorId: id(topic.creatorId),
		createdAt: id(topic.createdAt),
		pinned: topic.pinned,
		closed: topic.closed,
		hidden: topic.hidden,
		topSeq: id(topic.topSeq),
	};
}

function toLinkPreview(preview: WireLinkPreview | undefined): LinkPreview | null {
	if (preview === undefined) return null;
	return { url: preview.url, siteName: preview.siteName, title: preview.title, description: preview.description };
}

export function toDialog(dialog: WireDialog): Dialog {
	return {
		chatId: id(dialog.chatId),
		topSeq: id(dialog.topSeq),
		readInboxMaxSeq: id(dialog.readInboxMaxSeq),
		readOutboxMaxSeq: id(dialog.readOutboxMaxSeq),
		unreadCount: dialog.unreadCount,
		unreadMentionsCount: dialog.unreadMentionsCount,
		chatPts: id(dialog.chatPts),
	};
}

function toEntity(entity: WireEntity): MessageEntity {
	const type = ENTITY_TYPES[entity.type] ?? "unknown";
	return {
		type,
		offset: entity.offset,
		length: entity.length,
		...(type === "text_link" ? { url: entity.url } : {}),
		...(type === "mention_name" ? { userId: id(entity.userId) } : {}),
		...(type === "pre" && entity.language !== "" ? { language: entity.language } : {}),
	};
}

/** Protocol entity from a client entity; unknown types are dropped. */
export function toWireEntity(entity: MessageEntity): {
	type: WireEntityType;
	offset: number;
	length: number;
	url: string;
	userId: bigint;
	language: string;
} | null {
	const type = WIRE_ENTITY_TYPES.get(entity.type);
	if (type === undefined) return null;
	return {
		type,
		offset: entity.offset,
		length: entity.length,
		url: entity.url ?? "",
		userId: toWireId(entity.userId ?? 0),
		language: entity.language ?? "",
	};
}

function toReaction(reaction: WireReaction): ReactionCount {
	return { emoji: reaction.emoji, count: reaction.count, chosen: reaction.chosen };
}

function toForward(forward: WireForward | undefined): ForwardHeader | null {
	if (forward === undefined) return null;
	return {
		fromUserId: id(forward.fromUserId),
		fromChatId: id(forward.fromChatId),
		fromSeq: id(forward.fromSeq),
		fromName: forward.fromName,
		date: id(forward.date),
	};
}

function toAction(action: WireAction | undefined): MessageAction | null {
	if (action === undefined) return null;
	const kind = action.kind;
	switch (kind.case) {
		case "chatCreated":
			return { kind: "chat_created", title: kind.value.title };
		case "membersAdded":
			return { kind: "members_added", userIds: kind.value.userIds.map(id) };
		case "memberLeft":
			return { kind: "member_left" };
		case "memberRemoved":
			return { kind: "member_removed", userId: id(kind.value.userId), by: id(kind.value.by) };
		case "titleChanged":
			return { kind: "title_changed", title: kind.value.title };
		case "photoChanged":
			return { kind: "photo_changed" };
		case "photoRemoved":
			return { kind: "photo_removed" };
		case "messagePinned":
			return { kind: "message_pinned", seq: id(kind.value.seq) };
		case "historyVisibilityChanged":
			return { kind: "history_visibility_changed", visible: kind.value.visible };
		case "chatModeChanged":
			return { kind: "chat_mode_changed" };
		case "joinedByInvite":
			return { kind: "joined_by_invite" };
		case undefined:
			return { kind: "unsupported" };
	}
}

export function toMessage(message: WireMessage): Message {
	return {
		chatId: id(message.chatId),
		seq: id(message.seq),
		fromId: id(message.fromId),
		date: id(message.date),
		text: message.text,
		entities: message.entities.map(toEntity),
		mediaKind: message.media === undefined ? null : (MEDIA_KINDS[message.media.kind] ?? "unknown"),
		replyToSeq: id(message.replyToSeq),
		forward: toForward(message.forwardFrom),
		editDate: id(message.editDate),
		editVersion: message.editVersion,
		randomId: id(message.randomId),
		groupedId: id(message.groupedId),
		viaBotId: id(message.viaBotId),
		reactions: message.reactions.map(toReaction),
		integrationLabel: message.integrationLabel,
		action: toAction(message.action),
		topicId: id(message.topicId),
		linkPreview: toLinkPreview(message.linkPreview),
	};
}

function toBody(update: WireUpdate): UpdateBody {
	const kind = update.kind;
	switch (kind.case) {
		case "messageNew":
		case "messageEdit": {
			const message = kind.value.message;
			if (message === undefined) return { kind: "unknown" };
			return {
				kind: kind.case === "messageNew" ? "message_new" : "message_edit",
				message: toMessage(message),
			};
		}
		case "messageDelete":
			return { kind: "message_delete", chatId: id(kind.value.chatId), seqs: kind.value.seqs.map(id) };
		case "messageHidden":
			return { kind: "message_hidden", chatId: id(kind.value.chatId), seqs: kind.value.seqs.map(id) };
		case "reaction":
			return {
				kind: "reaction",
				chatId: id(kind.value.chatId),
				seq: id(kind.value.seq),
				reactions: kind.value.reactions.map(toReaction),
			};
		case "read":
			return {
				kind: "read",
				chatId: id(kind.value.chatId),
				maxSeq: id(kind.value.maxSeq),
				outbox: kind.value.outbox,
				unreadCount: kind.value.unreadCount,
				topicId: id(kind.value.topicId),
				topicUnreadCount: kind.value.topicUnreadCount,
				topSeq: id(kind.value.topSeq),
				chatPts: id(kind.value.chatPts),
			};
		case "pin":
			return { kind: "pin", chatId: id(kind.value.chatId), seq: id(kind.value.seq), pinned: kind.value.pinned };
		case "memberAdded":
			return {
				kind: "member_added",
				chatId: id(kind.value.chatId),
				userIds: kind.value.userIds.map(id),
				inviterId: id(kind.value.inviterId),
			};
		case "memberRemoved":
			return {
				kind: "member_removed",
				chatId: id(kind.value.chatId),
				userId: id(kind.value.userId),
				actorId: id(kind.value.actorId),
			};
		case "memberPermissions":
			return {
				kind: "member_permissions",
				chatId: id(kind.value.chatId),
				userId: id(kind.value.userId),
				role: ROLES[kind.value.role] ?? "unknown",
				permissions: kind.value.permissions,
			};
		case "chatModeChanged":
			return {
				kind: "chat_mode_changed",
				chatId: id(kind.value.chatId),
				syncMode: syncMode(kind.value.syncMode),
				chatPts: id(kind.value.chatPts),
			};
		case "chatUpdated": {
			const chat = kind.value.chat;
			return chat === undefined ? { kind: "unknown" } : { kind: "chat_updated", chat: toChat(chat) };
		}
		case "topicChanged": {
			const topic = kind.value.topic;
			return topic === undefined ? { kind: "unknown" } : { kind: "topic_changed", topic: toForumTopic(topic) };
		}
		case "chatActivity":
			return {
				kind: "chat_activity",
				chatId: id(kind.value.chatId),
				chatPts: id(kind.value.chatPts),
				topSeq: id(kind.value.topSeq),
			};
		case "sessionRevoked":
			return {
				kind: "session_revoked",
				sessionId: id(kind.value.sessionId),
				reason: toRevokeReason(kind.value.reason),
			};
		case undefined:
			return { kind: "unknown" };
	}
}

export function toUpdate(update: WireUpdate): Update {
	return {
		pts: id(update.pts),
		ptsCount: update.ptsCount,
		chatPts: id(update.chatPts),
		chatPtsCount: update.chatPtsCount,
		chatId: id(update.chatId),
		serverEpoch: id(update.serverEpoch),
		date: id(update.date),
		body: toBody(update),
	};
}

function toBatch(source: { updates: WireUpdate[]; users: WireUser[]; chats: WireChat[] }): UpdateBatch {
	return {
		updates: source.updates.map(toUpdate),
		users: source.users.map(toUser),
		chats: source.chats.map(toChat),
	};
}

export function toUpdateBatch(frame: UpdateFrame): UpdateBatch {
	return toBatch(frame);
}

function toSyncState(state: WireState | undefined): SyncState {
	if (state === undefined) throw new TypeError("difference response has no state");
	return { pts: id(state.pts), serverEpoch: id(state.serverEpoch), date: id(state.date) };
}

export function toState(state: WireState | undefined): SyncState {
	return toSyncState(state);
}

function toChatSyncState(state: WireChatState | undefined): ChatSyncState {
	if (state === undefined) throw new TypeError("chat difference response has no state");
	return { chatId: id(state.chatId), chatPts: id(state.chatPts), serverEpoch: id(state.serverEpoch) };
}

function toLargeChat(state: WireLargeChatState): LargeChatState {
	return { chatId: id(state.chatId), chatPts: id(state.chatPts), topSeq: id(state.topSeq) };
}

function toResult(
	result: GetDifferenceResponse["result"] | GetChatDifferenceResponse["result"],
): DifferenceResult {
	const updates = (value: DifferenceUpdates): { batch: UpdateBatch; largeChats: LargeChatState[] } => ({
		batch: toBatch(value),
		largeChats: value.largeChats.map(toLargeChat),
	});
	switch (result.case) {
		case "empty":
			return { kind: "empty" };
		case "slice":
			return { kind: "slice", ...updates(result.value) };
		case "full":
			return { kind: "full", ...updates(result.value) };
		case "tooLong":
			return { kind: "too_long" };
		case undefined:
			throw new TypeError("difference response has no result");
	}
}

export function toDifference(response: GetDifferenceResponse): Difference {
	return { state: toSyncState(response.state), result: toResult(response.result) };
}

export function toChatDifference(response: GetChatDifferenceResponse): ChatDifference {
	return { state: toChatSyncState(response.state), result: toResult(response.result) };
}

export function toSyncAck(ack: WireSyncAck | undefined): SyncAck | null {
	if (ack === undefined) return null;
	return {
		pts: id(ack.pts),
		ptsCount: ack.ptsCount,
		chatPts: id(ack.chatPts),
		chatPtsCount: ack.chatPtsCount,
		serverEpoch: id(ack.serverEpoch),
	};
}

export function toHello(hello: HelloFrame): Hello {
	return {
		userId: id(hello.userId),
		sessionId: id(hello.sessionId),
		serverEpoch: id(hello.serverEpoch),
		heartbeatIntervalMs: hello.heartbeatIntervalMs,
		serverTime: id(hello.serverTime),
	};
}

export function toHistoryPage(response: GetHistoryResponse): HistoryPage {
	return {
		messages: response.messages.map(toMessage),
		users: response.users.map(toUser),
		hasOlder: response.hasOlder,
		hasNewer: response.hasNewer,
	};
}

/** GetPeerDialogs has the dialog page shape without a cursor. */
export function toPeerDialogs(response: GetPeerDialogsResponse): DialogsPage {
	return toDialogsPage({
		dialogs: response.dialogs,
		messages: response.messages,
		chats: response.chats,
		users: response.users,
		nextCursor: "",
	});
}

export function toDialogsPage(
	response: Pick<GetDialogsResponse, "dialogs" | "messages" | "chats" | "users" | "nextCursor">,
): DialogsPage {
	return {
		dialogs: response.dialogs.map(toDialog),
		messages: response.messages.map(toMessage),
		chats: response.chats.map(toChat),
		users: response.users.map(toUser),
		nextCursor: response.nextCursor,
	};
}

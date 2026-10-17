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
	NotificationSettings as WireNotificationSettings,
} from "@app/proto-ts/chats";
import {
	ChatType as WireChatType,
	HistoryVisibility,
	MemberRole as WireRole,
	NotificationSound as WireSound,
	SyncMode as WireSyncMode,
} from "@app/proto-ts/chats";
import { SessionRevokeReason as WireRevokeReason } from "@app/proto-ts/auth";
import { MediaKind as WireMediaKind, MediaSizeType as WireSizeType } from "@app/proto-ts/media";
import type { MediaRef as WireMediaRef, MediaSize as WireMediaSize } from "@app/proto-ts/media";
import type {
	GetHistoryResponse,
	GetPinnedMessagesResponse,
	ForwardHeader as WireForward,
	InlineButton as WireInlineButton,
	LinkPreview as WireLinkPreview,
	Message as WireMessage,
	MessageAction as WireAction,
	MessageEntity as WireEntity,
	ReactionCount as WireReaction,
	ReplyMarkup as WireReplyMarkup,
	SyncAck as WireSyncAck,
} from "@app/proto-ts/messages";
import { EntityType as WireEntityType, IncomingHookStopReason } from "@app/proto-ts/messages";
import { TypingAction as WireTypingAction, type HelloFrame, type TypingFrame, type UpdateFrame } from "@app/proto-ts/realtime";
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
import { toBase64 } from "../media/codec.ts";
import type {
	Chat,
	ChatDifference,
	ChatSyncState,
	ChatTyping,
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
	HookStopReason,
	LargeChatState,
	LinkPreview,
	MediaKind,
	MediaRef,
	MediaSize,
	MediaSizeType,
	MemberRole,
	Message,
	MessageAction,
	MessageButton,
	MessageEntity,
	NotificationSettings,
	NotificationSound,
	PinnedMessagesPage,
	ReactionCount,
	ReplyKeyboard,
	SessionRevokeReason,
	SyncAck,
	SyncMode,
	TypingAction,
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

const WIRE_MEDIA_KINDS = new Map<MediaKind, WireMediaKind>(
	Object.entries(MEDIA_KINDS).map(([wire, local]) => [local, Number(wire) as WireMediaKind]),
);

/** Protocol kind from a client kind; "unknown" has none. */
export function toWireMediaKind(kind: MediaKind): WireMediaKind {
	return WIRE_MEDIA_KINDS.get(kind) ?? WireMediaKind.UNSPECIFIED;
}

const SIZE_TYPES: Record<number, MediaSizeType> = {
	[WireSizeType.UNSPECIFIED]: "original",
	[WireSizeType.S]: "s",
	[WireSizeType.M]: "m",
	[WireSizeType.X]: "x",
};

const WIRE_SIZE_TYPES: Record<MediaSizeType, WireSizeType> = {
	original: WireSizeType.UNSPECIFIED,
	s: WireSizeType.S,
	m: WireSizeType.M,
	x: WireSizeType.X,
};

/** Rendition from the protocol; one this client does not know is treated as the original. */
export function toSizeType(type: WireSizeType): MediaSizeType {
	return SIZE_TYPES[type] ?? "original";
}

export function toWireSizeType(type: MediaSizeType): WireSizeType {
	return WIRE_SIZE_TYPES[type];
}

function toMediaSize(size: WireMediaSize): MediaSize | null {
	const type = SIZE_TYPES[size.type];
	if (type === undefined || type === "original") return null;
	return { type, width: size.width, height: size.height, size: id(size.size) };
}

export function toMediaRef(media: WireMediaRef): MediaRef {
	return {
		fileId: media.fileId,
		fileHash: media.fileHash,
		kind: MEDIA_KINDS[media.kind] ?? "unknown",
		mimeType: media.mimeType,
		size: id(media.size),
		fileName: media.fileName,
		width: media.width,
		height: media.height,
		duration: media.duration,
		inlineThumb: media.inlineThumb,
		sizes: media.sizes.flatMap((s) => toMediaSize(s) ?? []),
		waveform: media.waveform,
	};
}

const REVOKE_REASONS: Record<number, SessionRevokeReason> = {
	[WireRevokeReason.SIGNED_OUT]: "signed_out",
	[WireRevokeReason.REVOKED_BY_USER]: "revoked_by_user",
	[WireRevokeReason.IDP_GRANT_ENDED]: "idp_grant_ended",
	[WireRevokeReason.EXPIRED]: "expired",
	[WireRevokeReason.ADMIN]: "admin",
	[WireRevokeReason.REPLACED]: "replaced",
};

const TYPING_ACTIONS: Record<number, TypingAction> = {
	[WireTypingAction.TYPING]: "typing",
	[WireTypingAction.RECORDING_VOICE]: "voice",
	[WireTypingAction.UPLOADING_PHOTO]: "photo",
	[WireTypingAction.UPLOADING_VIDEO]: "video",
	[WireTypingAction.UPLOADING_DOCUMENT]: "document",
};

/** A typing frame from the server; action null ends the typing (cancel, or an unknown action). */
export type TypingChange = Omit<ChatTyping, "action"> & { readonly action: TypingAction | null };

export function toTyping(frame: TypingFrame): TypingChange {
	return { chatId: id(frame.chatId), userId: id(frame.userId), topicId: id(frame.topicId), action: TYPING_ACTIONS[frame.action] ?? null };
}

const WIRE_TYPING_ACTIONS: Record<TypingAction | "cancel", WireTypingAction> = {
	typing: WireTypingAction.TYPING,
	voice: WireTypingAction.RECORDING_VOICE,
	photo: WireTypingAction.UPLOADING_PHOTO,
	video: WireTypingAction.UPLOADING_VIDEO,
	document: WireTypingAction.UPLOADING_DOCUMENT,
	cancel: WireTypingAction.CANCEL,
};

/** The wire action of a typing frame the client sends; "cancel" ends it early. */
export function toWireTypingAction(action: TypingAction | "cancel"): WireTypingAction {
	return WIRE_TYPING_ACTIONS[action];
}

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
		...(user.deleted ? { deleted: true } : {}),
		...(user.photo !== undefined && user.photo.fileId !== "" ? { photoId: user.photo.fileId } : {}),
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
		// The wire chat does not say why; member_removed does (repo LEFT_REMOVED).
		removed: false,
		forum: chat.forum,
		...(chat.photo !== undefined && chat.photo.fileId !== "" ? { photoId: chat.photo.fileId } : {}),
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

/** One inline button: URL and bot callback buttons; other kinds keep only their text. */
function toButton(button: WireInlineButton): MessageButton {
	const action = button.action;
	if (action.case === "url") return { text: button.text, url: action.value };
	if (action.case === "callbackData") return { text: button.text, url: null, callbackData: toBase64(action.value) };
	return { text: button.text, url: null };
}

/** Inline keyboard rows under the message; empty for other markups. */
function toButtons(markup: WireReplyMarkup | undefined): MessageButton[][] {
	if (markup?.kind.case !== "inlineKeyboard") return [];
	return markup.kind.value.rows.map((row) => row.buttons.map(toButton)).filter((row) => row.length > 0);
}

/** The reply keyboard a bot message sets or removes; undefined for other markups. */
function toKeyboard(markup: WireReplyMarkup | undefined): ReplyKeyboard | undefined {
	const kind = markup?.kind;
	if (kind?.case === "remove") return { kind: "remove", selective: kind.value.selective };
	if (kind?.case !== "keyboard") return undefined;
	const rows = kind.value.rows.map((row) => row.buttons.map((button) => button.text).filter((text) => text !== "")).filter((row) => row.length > 0);
	if (rows.length === 0) return undefined;
	return { kind: "keyboard", rows, oneTime: kind.value.oneTime, placeholder: kind.value.placeholder, selective: kind.value.selective, hidden: false };
}

function toLinkPreview(preview: WireLinkPreview | undefined): LinkPreview | null {
	if (preview === undefined) return null;
	return {
		url: preview.url,
		siteName: preview.siteName,
		title: preview.title,
		description: preview.description,
		...(preview.photo === undefined ? {} : { photo: toMediaRef(preview.photo) }),
	};
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
		muteUntil: id(dialog.muteUntil),
		pinned: dialog.pinned,
		pinnedMessageCount: dialog.pinnedMessageCount,
		pinnedMessageSeq: id(dialog.pinnedMessageSeq),
		unreadMark: dialog.unreadMark,
		sortDate: id(dialog.sortDate),
	};
}

const SOUNDS: Record<number, NotificationSound> = {
	[WireSound.DEFAULT]: "default",
	[WireSound.SOFT]: "soft",
	[WireSound.OFF]: "off",
};

const WIRE_SOUNDS: Record<NotificationSound, WireSound> = {
	default: WireSound.DEFAULT,
	soft: WireSound.SOFT,
	off: WireSound.OFF,
};

export function toNotificationSettings(settings: WireNotificationSettings): NotificationSettings {
	return {
		privateEnabled: settings.privateEnabled,
		privatePreview: settings.privatePreview,
		groupsEnabled: settings.groupsEnabled,
		groupsPreview: settings.groupsPreview,
		channelsEnabled: settings.channelsEnabled,
		channelsPreview: settings.channelsPreview,
		// A sound this client does not know plays the default one.
		sound: SOUNDS[settings.sound] ?? "default",
		badgeMuted: settings.badgeMuted,
	};
}

/** Protocol sound from a client sound. */
export function toWireSound(sound: NotificationSound): WireSound {
	return WIRE_SOUNDS[sound];
}

/** Client entity from a protocol entity; unknown types become "unknown". */
export function fromWireEntity(entity: WireEntity): MessageEntity {
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
	return {
		emoji: reaction.emoji,
		count: reaction.count,
		chosen: reaction.chosen,
		recentUserIds: reaction.recentUserIds.map(id),
	};
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

const HOOK_STOP_REASONS: Partial<Record<IncomingHookStopReason, HookStopReason>> = {
	[IncomingHookStopReason.DISABLED]: "disabled",
	[IncomingHookStopReason.DELETED]: "deleted",
	[IncomingHookStopReason.CREATOR_NOT_ADMIN]: "creator_not_admin",
	[IncomingHookStopReason.CREATOR_LEFT]: "creator_left",
	[IncomingHookStopReason.BY_MODERATOR]: "by_moderator",
};

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
		case "incomingHookStopped":
			return { kind: "incoming_hook_stopped", hookName: kind.value.hookName, reason: HOOK_STOP_REASONS[kind.value.reason] ?? "unknown" };
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
		entities: message.entities.map(fromWireEntity),
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
		buttons: toButtons(message.replyMarkup),
		action: toAction(message.action),
		topicId: id(message.topicId),
		linkPreview: toLinkPreview(message.linkPreview),
		recalled: message.recalled,
		silent: message.silent,
		...(message.media === undefined ? {} : { media: toMediaRef(message.media) }),
		...keyboardOf(message.replyMarkup),
	};
}

function keyboardOf(markup: WireReplyMarkup | undefined): { keyboard?: ReplyKeyboard } {
	const keyboard = toKeyboard(markup);
	return keyboard === undefined ? {} : { keyboard };
}

function toBody(update: WireUpdate): UpdateBody {
	const kind = update.kind;
	switch (kind.case) {
		case "messageNew":
		case "messageEdit": {
			const message = kind.value.message;
			if (message === undefined) return { kind: "unknown" };
			if (kind.case === "messageNew") return { kind: "message_new", message: toMessage(message), notify: !message.silent };
			return { kind: "message_edit", message: toMessage(message), notify: kind.value.notify };
		}
		case "messageDelete":
			return {
				kind: "message_delete",
				chatId: id(kind.value.chatId),
				seqs: kind.value.seqs.map(id),
				recalled: kind.value.recalled,
			};
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
				unreadMentionsCount: kind.value.unreadMentionsCount,
			};
		case "pin":
			return {
				kind: "pin",
				chatId: id(kind.value.chatId),
				seq: id(kind.value.seq),
				pinned: kind.value.pinned,
				seqs: kind.value.seqs.map(id),
			};
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
		case "dialogMute":
			return { kind: "dialog_mute", chatId: id(kind.value.chatId), muteUntil: id(kind.value.muteUntil) };
		case "pinnedDialogs":
			return { kind: "pinned_dialogs", chatIds: kind.value.chatIds.map(id) };
		case "chatDeleted":
			return { kind: "chat_deleted", chatId: id(kind.value.chatId), forEveryone: kind.value.forEveryone };
		case "dialogUnreadMark":
			return { kind: "dialog_unread_mark", chatId: id(kind.value.chatId), unread: kind.value.unread };
		case "notificationSettings": {
			const settings = kind.value.settings;
			return settings === undefined
				? { kind: "unknown" }
				: { kind: "notification_settings", settings: toNotificationSettings(settings) };
		}
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

export function toPinnedMessagesPage(response: GetPinnedMessagesResponse): PinnedMessagesPage {
	return {
		messages: response.messages.map(toMessage),
		users: response.users.map(toUser),
		count: response.count,
		hasMore: response.hasMore,
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
		pinnedChatIds: [],
	});
}

export function toDialogsPage(
	response: Pick<GetDialogsResponse, "dialogs" | "messages" | "chats" | "users" | "nextCursor"> &
		Partial<Pick<GetDialogsResponse, "pinnedChatIds">>,
): DialogsPage {
	return {
		dialogs: response.dialogs.map(toDialog),
		messages: response.messages.map(toMessage),
		chats: response.chats.map(toChat),
		users: response.users.map(toUser),
		nextCursor: response.nextCursor,
		pinnedChatIds: (response.pinnedChatIds ?? []).map(id),
	};
}

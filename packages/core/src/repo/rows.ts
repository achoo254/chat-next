// Row decoding for the local database. JSON columns are written only by
// this package, but they are still parsed defensively: a corrupt row becomes
// an empty value instead of crashing the history view.
import type { SqlRow, SqlValue } from "@app/platform";
import type {
	Chat,
	ChatType,
	Dialog,
	EntityType,
	ForwardHeader,
	MediaKind,
	MediaRef,
	MemberRole,
	LinkPreview,
	Message,
	HookStopReason,
	MessageAction,
	MessageButton,
	MessageEntity,
	NotificationSettings,
	ReactionCount,
	ReplyKeyboard,
	User,
} from "../model/types.ts";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../model/types.ts";
import { decodeMediaRef } from "../media/codec.ts";

export function num(row: SqlRow, column: string): number {
	const value = row[column];
	if (typeof value === "number") return value;
	if (value === null || value === undefined) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function str(row: SqlRow, column: string): string {
	const value = row[column];
	return typeof value === "string" ? value : "";
}

function optionalStr(row: SqlRow, column: string): string | null {
	const value = row[column];
	return typeof value === "string" ? value : null;
}

/**
 * chats.left_chat: 0 a member, 1 no longer a member (left, or the cause is
 * unknown), LEFT_REMOVED removed by someone else.
 */
export const LEFT_REMOVED = 2;

function bool(row: SqlRow, column: string): boolean {
	return num(row, column) !== 0;
}

function parseJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" ? value : 0;
}

function text(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

const ENTITY_TYPES = new Set<EntityType>([
	"bold",
	"italic",
	"underline",
	"strike",
	"spoiler",
	"code",
	"pre",
	"text_link",
	"mention",
	"mention_name",
	"hashtag",
	"url",
	"email",
	"bot_command",
]);

/** Decodes stored entities; null when the value is not a well-formed entity list. */
export function decodeEntities(value: unknown): MessageEntity[] | null {
	if (!Array.isArray(value)) return null;
	const entities: MessageEntity[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.offset !== "number" || typeof item.length !== "number") return null;
		const type = item.type;
		entities.push({
			type: typeof type === "string" && ENTITY_TYPES.has(type as EntityType) ? (type as EntityType) : "unknown",
			offset: item.offset,
			length: item.length,
			...(typeof item.url === "string" ? { url: item.url } : {}),
			...(typeof item.userId === "number" ? { userId: item.userId } : {}),
			...(typeof item.language === "string" ? { language: item.language } : {}),
		});
	}
	return entities;
}

export function parseEntities(json: string | null): MessageEntity[] {
	return decodeEntities(parseJson(json)) ?? [];
}

function parseReactions(json: string | null): ReactionCount[] {
	const value = parseJson(json);
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map((item) => ({
		emoji: text(item, "emoji"),
		count: field(item, "count"),
		chosen: item.chosen === true,
		recentUserIds: Array.isArray(item.recentUserIds)
			? item.recentUserIds.filter((v): v is number => typeof v === "number")
			: [],
	}));
}

function parseForward(json: string | null): ForwardHeader | null {
	const value = parseJson(json);
	if (!isRecord(value)) return null;
	return {
		fromUserId: field(value, "fromUserId"),
		fromChatId: field(value, "fromChatId"),
		fromSeq: field(value, "fromSeq"),
		fromName: text(value, "fromName"),
		date: field(value, "date"),
	};
}

const HOOK_STOP_REASONS: readonly HookStopReason[] = ["disabled", "deleted", "creator_not_admin", "creator_left", "by_moderator", "unknown"];

function hookStopReason(value: unknown): HookStopReason {
	return HOOK_STOP_REASONS.find((reason) => reason === value) ?? "unknown";
}

function parseAction(json: string | null): MessageAction | null {
	const value = parseJson(json);
	if (!isRecord(value)) return null;
	switch (value.kind) {
		case "chat_created":
			return { kind: "chat_created", title: text(value, "title") };
		case "members_added": {
			const ids = Array.isArray(value.userIds) ? value.userIds.filter((v): v is number => typeof v === "number") : [];
			return { kind: "members_added", userIds: ids };
		}
		case "member_left":
			return { kind: "member_left" };
		case "member_removed":
			return { kind: "member_removed", userId: field(value, "userId"), by: field(value, "by") };
		case "title_changed":
			return { kind: "title_changed", title: text(value, "title") };
		case "photo_changed":
			return { kind: "photo_changed" };
		case "photo_removed":
			return { kind: "photo_removed" };
		case "message_pinned":
			return { kind: "message_pinned", seq: field(value, "seq") };
		case "history_visibility_changed":
			return { kind: "history_visibility_changed", visible: value.visible === true };
		case "chat_mode_changed":
			return { kind: "chat_mode_changed" };
		case "joined_by_invite":
			return { kind: "joined_by_invite" };
		case "incoming_hook_stopped":
			return {
				kind: "incoming_hook_stopped",
				hookName: text(value, "hookName"),
				reason: hookStopReason(value.reason),
			};
		default:
			return { kind: "unsupported" };
	}
}

function parseButtons(raw: string | null): MessageButton[][] {
	const value = parseJson(raw);
	if (!Array.isArray(value)) return [];
	const rows: MessageButton[][] = [];
	for (const row of value) {
		if (!Array.isArray(row)) continue;
		const buttons = row.filter(isRecord).map(parseButton);
		if (buttons.length > 0) rows.push(buttons);
	}
	return rows;
}

function parseButton(b: Record<string, unknown>): MessageButton {
	const button = { text: text(b, "text"), url: typeof b.url === "string" ? b.url : null };
	return typeof b.callbackData === "string" && b.callbackData !== "" ? { ...button, callbackData: b.callbackData } : button;
}

/** `hidden`: the local keyboard_hidden column (the JSON holds what the bot sent). */
function parseKeyboard(raw: string | null, hidden: boolean): { keyboard?: ReplyKeyboard } {
	const value = parseJson(raw);
	if (!isRecord(value)) return {};
	const selective = value.selective === true;
	if (value.kind === "remove") return { keyboard: { kind: "remove", selective } };
	if (value.kind !== "keyboard" || !Array.isArray(value.rows)) return {};
	const rows = value.rows
		.filter((row): row is unknown[] => Array.isArray(row))
		.map((row) => row.filter((label): label is string => typeof label === "string" && label !== ""))
		.filter((row) => row.length > 0);
	if (rows.length === 0) return {};
	return {
		keyboard: {
			kind: "keyboard",
			rows,
			oneTime: value.oneTime === true,
			placeholder: typeof value.placeholder === "string" ? value.placeholder : "",
			selective,
			hidden,
		},
	};
}

function parseLinkPreview(raw: string | null): LinkPreview | null {
	const value = parseJson(raw);
	if (!isRecord(value)) return null;
	const photo = decodeMediaRef(value.photo);
	return {
		url: text(value, "url"),
		siteName: text(value, "siteName"),
		title: text(value, "title"),
		description: text(value, "description"),
		...(photo === null ? {} : { photo }),
	};
}

const MEDIA_KINDS = new Set<MediaKind>(["photo", "video", "audio", "voice", "document", "unknown"]);
const CHAT_TYPES = new Set<ChatType>(["private", "group", "channel", "secret"]);
const ROLES = new Set<MemberRole>(["member", "admin", "owner"]);

export function rowToMessage(row: SqlRow): Message {
	const media = optionalStr(row, "media_kind");
	return {
		chatId: num(row, "chat_id"),
		seq: num(row, "seq"),
		fromId: num(row, "from_id"),
		date: num(row, "date"),
		text: str(row, "text"),
		entities: parseEntities(optionalStr(row, "entities")),
		mediaKind: media === null ? null : MEDIA_KINDS.has(media as MediaKind) ? (media as MediaKind) : "unknown",
		replyToSeq: num(row, "reply_to_seq"),
		forward: parseForward(optionalStr(row, "forward")),
		editDate: num(row, "edit_date"),
		editVersion: num(row, "edit_version"),
		randomId: num(row, "random_id"),
		groupedId: num(row, "grouped_id"),
		viaBotId: num(row, "via_bot_id"),
		reactions: parseReactions(optionalStr(row, "reactions")),
		integrationLabel: str(row, "integration_label"),
		buttons: parseButtons(optionalStr(row, "buttons")),
		action: parseAction(optionalStr(row, "action")),
		topicId: num(row, "topic_id"),
		linkPreview: parseLinkPreview(optionalStr(row, "link_preview")),
		recalled: bool(row, "recalled"),
		silent: bool(row, "silent"),
		...mediaOf(optionalStr(row, "media")),
		...parseKeyboard(optionalStr(row, "reply_keyboard"), bool(row, "keyboard_hidden")),
	};
}

function mediaOf(raw: string | null): { media?: MediaRef } {
	const media = decodeMediaRef(parseJson(raw));
	return media === null ? {} : { media };
}

export function rowToUser(row: SqlRow): User {
	return {
		id: num(row, "id"),
		username: str(row, "username"),
		name: str(row, "name"),
		bio: str(row, "bio"),
		isBot: bool(row, "is_bot"),
		isSelf: bool(row, "is_self"),
		isBlocked: bool(row, "is_blocked"),
		...(bool(row, "deleted") ? { deleted: true } : {}),
		...(str(row, "photo_id") !== "" ? { photoId: str(row, "photo_id") } : {}),
	};
}

export function rowToChat(row: SqlRow): Chat {
	const type = str(row, "type");
	const role = str(row, "my_role");
	return {
		id: num(row, "id"),
		type: CHAT_TYPES.has(type as ChatType) ? (type as ChatType) : "unknown",
		title: str(row, "title"),
		about: str(row, "about"),
		peerUserId: num(row, "peer_user_id"),
		syncMode: str(row, "sync_mode") === "large" ? "large" : "small",
		historyShared: bool(row, "history_shared"),
		memberCount: num(row, "member_count"),
		defaultPermissions: num(row, "default_permissions"),
		pinnedSeq: num(row, "pinned_seq"),
		createdAt: num(row, "created_at"),
		myRole: ROLES.has(role as MemberRole) ? (role as MemberRole) : "unknown",
		myPermissions: num(row, "my_permissions"),
		left: bool(row, "left_chat"),
		removed: num(row, "left_chat") === LEFT_REMOVED,
		forum: bool(row, "forum"),
	};
}

export function rowToDialog(row: SqlRow): Dialog {
	return {
		chatId: num(row, "chat_id"),
		topSeq: num(row, "top_seq"),
		readInboxMaxSeq: num(row, "read_inbox_max_seq"),
		readOutboxMaxSeq: num(row, "read_outbox_max_seq"),
		unreadCount: num(row, "unread_count"),
		unreadMentionsCount: num(row, "unread_mentions_count"),
		chatPts: num(row, "chat_pts"),
		muteUntil: num(row, "mute_until"),
		pinned: num(row, "pin_rank") > 0,
		pinnedMessageCount: num(row, "pinned_message_count"),
		pinnedMessageSeq: num(row, "pinned_message_seq"),
		unreadMark: bool(row, "unread_mark"),
		sortDate: num(row, "top_date"),
	};
}

/** Decodes stored notification settings; missing or corrupt fields take the defaults. */
export function parseNotificationSettings(json: string | null): NotificationSettings {
	const value = parseJson(json);
	if (!isRecord(value)) return DEFAULT_NOTIFICATION_SETTINGS;
	const flagOr = (key: keyof NotificationSettings, fallback: boolean): boolean => {
		const v = value[key];
		return typeof v === "boolean" ? v : fallback;
	};
	const d = DEFAULT_NOTIFICATION_SETTINGS;
	const sound = value.sound;
	return {
		privateEnabled: flagOr("privateEnabled", d.privateEnabled),
		privatePreview: flagOr("privatePreview", d.privatePreview),
		groupsEnabled: flagOr("groupsEnabled", d.groupsEnabled),
		groupsPreview: flagOr("groupsPreview", d.groupsPreview),
		channelsEnabled: flagOr("channelsEnabled", d.channelsEnabled),
		channelsPreview: flagOr("channelsPreview", d.channelsPreview),
		sound: sound === "default" || sound === "soft" || sound === "off" ? sound : d.sound,
		badgeMuted: flagOr("badgeMuted", d.badgeMuted),
	};
}

/** Encodes a boolean for an INTEGER column. */
export function flag(value: boolean): SqlValue {
	return value ? 1 : 0;
}

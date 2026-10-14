// Statement builders. A sync step collects its statements and event keys in
// one WriteBatch and commits them as a single atomic SqlDriver batch, so the
// database never holds half an update and listeners only hear about
// committed changes.
import type { SqlParams, SqlStatement } from "@app/platform";
import { EventKeys } from "../events/bus.ts";
import type {
	Chat,
	Dialog,
	Message,
	NotificationSettings,
	ReactionCount,
	SyncState,
	UpdateBody,
	User,
} from "../model/types.ts";
import { searchText } from "../vifold/index.ts";
import { flag } from "./rows.ts";

export class WriteBatch {
	readonly statements: SqlStatement[] = [];
	readonly events = new Set<string>();

	add(sql: string, params: SqlParams = []): this {
		this.statements.push({ sql, params });
		return this;
	}

	emit(...keys: string[]): this {
		for (const key of keys) this.events.add(key);
		return this;
	}

	get empty(): boolean {
		return this.statements.length === 0 && this.events.size === 0;
	}
}

/** "?, ?, ?" for an IN list of `count` values. */
export function placeholders(count: number): string {
	return new Array<string>(count).fill("?").join(", ");
}

export function putSyncState(w: WriteBatch, state: SyncState): void {
	w.add(
		`INSERT INTO sync_state (id, pts, server_epoch, date) VALUES (1, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET pts = excluded.pts, server_epoch = excluded.server_epoch, date = excluded.date`,
		[state.pts, state.serverEpoch, state.date],
	);
}

export function putChatPts(w: WriteBatch, chatId: number, chatPts: number): void {
	w.add(
		`INSERT INTO chat_sync_state (chat_id, chat_pts) VALUES (?, ?)
		ON CONFLICT (chat_id) DO UPDATE SET chat_pts = excluded.chat_pts`,
		[chatId, chatPts],
	);
}

export function putUser(w: WriteBatch, user: User): void {
	w.add(
		`INSERT INTO users (id, username, name, bio, is_bot, is_self, is_blocked) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET username = excluded.username, name = excluded.name, bio = excluded.bio,
			is_bot = excluded.is_bot, is_self = excluded.is_self, is_blocked = excluded.is_blocked`,
		[user.id, user.username, user.name, user.bio, flag(user.isBot), flag(user.isSelf), flag(user.isBlocked)],
	);
	w.emit(EventKeys.user(user.id));
}

export function putChat(w: WriteBatch, chat: Chat): void {
	w.add(
		`INSERT INTO chats (id, type, title, about, peer_user_id, sync_mode, history_shared, member_count,
			default_permissions, pinned_seq, created_at, my_role, my_permissions, left_chat, forum)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, about = excluded.about,
			peer_user_id = excluded.peer_user_id,
			sync_mode = CASE WHEN chats.sync_mode = 'large' THEN 'large' ELSE excluded.sync_mode END,
			history_shared = excluded.history_shared, member_count = excluded.member_count,
			default_permissions = excluded.default_permissions, pinned_seq = excluded.pinned_seq,
			created_at = excluded.created_at, my_role = excluded.my_role,
			my_permissions = excluded.my_permissions, left_chat = excluded.left_chat, forum = excluded.forum`,
		[
			chat.id,
			chat.type,
			chat.title,
			chat.about,
			chat.peerUserId,
			chat.syncMode,
			flag(chat.historyShared),
			chat.memberCount,
			chat.defaultPermissions,
			chat.pinnedSeq,
			chat.createdAt,
			chat.myRole,
			chat.myPermissions,
			flag(chat.left),
			flag(chat.forum),
		],
	);
	w.emit(EventKeys.chat(chat.id));
}

/** Indexed text of a message: its text folded per ADR 0005; system messages and recalled ones are not indexed. */
export function messageSearchText(message: Message): string {
	return message.action === null && !message.recalled ? searchText(message.text) : "";
}

/**
 * Inserts or refreshes a message. An older edit_version never overwrites a
 * newer one (edits can arrive out of order through history and realtime),
 * except over a stale row: after a restore the server may reuse a seq. A
 * recalled placeholder always replaces the live message and is never turned
 * back into one (unless the row is stale). Writing a row clears its stale
 * mark: it now matches the server.
 */
export function putMessage(w: WriteBatch, message: Message): void {
	w.add(
		`INSERT INTO messages (chat_id, seq, from_id, date, text, entities, media_kind, reply_to_seq, forward,
			edit_date, edit_version, random_id, grouped_id, via_bot_id, reactions, integration_label, buttons, action,
			search_text, topic_id, link_preview, recalled, stale)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		ON CONFLICT (chat_id, seq) DO UPDATE SET from_id = excluded.from_id, date = excluded.date,
			text = excluded.text, entities = excluded.entities, media_kind = excluded.media_kind,
			reply_to_seq = excluded.reply_to_seq, forward = excluded.forward, edit_date = excluded.edit_date,
			edit_version = excluded.edit_version,
			random_id = CASE WHEN excluded.random_id <> 0 THEN excluded.random_id ELSE messages.random_id END,
			grouped_id = excluded.grouped_id, via_bot_id = excluded.via_bot_id, reactions = excluded.reactions,
			integration_label = excluded.integration_label, buttons = excluded.buttons, action = excluded.action,
			search_text = excluded.search_text, topic_id = excluded.topic_id, link_preview = excluded.link_preview,
			recalled = excluded.recalled, stale = 0
		WHERE messages.stale = 1 OR (excluded.recalled >= messages.recalled
			AND (excluded.edit_version >= messages.edit_version OR excluded.recalled > messages.recalled))`,
		[
			message.chatId,
			message.seq,
			message.fromId,
			message.date,
			message.text,
			JSON.stringify(message.entities),
			message.mediaKind,
			message.replyToSeq,
			message.forward === null ? null : JSON.stringify(message.forward),
			message.editDate,
			message.editVersion,
			message.randomId,
			message.groupedId,
			message.viaBotId,
			JSON.stringify(message.reactions),
			message.integrationLabel,
			message.buttons.length === 0 ? null : JSON.stringify(message.buttons),
			message.action === null ? null : JSON.stringify(message.action),
			messageSearchText(message),
			message.topicId,
			message.linkPreview === null ? null : JSON.stringify(message.linkPreview),
			flag(message.recalled),
		],
	);
	w.emit(EventKeys.history(message.chatId), EventKeys.message(message.chatId, message.seq));
}

export function putReactions(w: WriteBatch, chatId: number, seq: number, reactions: readonly ReactionCount[]): void {
	w.add("UPDATE messages SET reactions = ? WHERE chat_id = ? AND seq = ?", [JSON.stringify(reactions), chatId, seq]);
	w.emit(EventKeys.message(chatId, seq));
}

/** Read state of the chat as a whole; forum topics get their own topic_id. */
export const CHAT_TOPIC = 0;

export function putUnreadMark(w: WriteBatch, chatId: number, unread: boolean): void {
	w.add("UPDATE dialogs SET unread_mark = ? WHERE chat_id = ?", [flag(unread), chatId]);
	w.emit(EventKeys.dialogs, EventKeys.dialog(chatId));
}

export function putNotificationSettings(w: WriteBatch, settings: NotificationSettings): void {
	w.add(
		`INSERT INTO notification_settings (id, settings) VALUES (1, ?)
		ON CONFLICT (id) DO UPDATE SET settings = excluded.settings`,
		[JSON.stringify(settings)],
	);
	w.emit(EventKeys.notificationSettings, EventKeys.dialogs);
}

export function putMute(w: WriteBatch, chatId: number, muteUntil: number): void {
	w.add("UPDATE dialogs SET mute_until = ? WHERE chat_id = ?", [muteUntil, chatId]);
	w.emit(EventKeys.dialogs, EventKeys.dialog(chatId));
}

/** Makes `chatIds` (top first) the pinned dialogs, unpinning every other. */
export function putPinnedOrder(w: WriteBatch, chatIds: readonly number[]): void {
	if (chatIds.length === 0) {
		w.add("UPDATE dialogs SET pin_rank = 0 WHERE pin_rank <> 0");
	} else {
		w.add(`UPDATE dialogs SET pin_rank = 0 WHERE pin_rank <> 0 AND chat_id NOT IN (${placeholders(chatIds.length)})`, [
			...chatIds,
		]);
	}
	chatIds.forEach((chatId, i) => {
		w.add("UPDATE dialogs SET pin_rank = ? WHERE chat_id = ?", [chatIds.length - i, chatId]);
		w.emit(EventKeys.dialog(chatId));
	});
	w.emit(EventKeys.dialogs);
}

/** Creates the dialog and chat-level read state of a chat the user belongs to, if missing. */
export function ensureDialog(w: WriteBatch, chatId: number): void {
	w.add("INSERT INTO dialogs (chat_id, top_seq, top_date) VALUES (?, 0, 0) ON CONFLICT (chat_id) DO NOTHING", [
		chatId,
	]);
	w.add(
		`INSERT INTO read_states (chat_id, topic_id, read_inbox_max_seq, read_outbox_max_seq, unread_count,
			unread_mentions_count) VALUES (?, ?, 0, 0, 0, 0) ON CONFLICT (chat_id, topic_id) DO NOTHING`,
		[chatId, CHAT_TOPIC],
	);
	w.emit(EventKeys.dialogs, EventKeys.dialog(chatId));
}

/**
 * Replaces a dialog with the server's view (dialog snapshot). A pinned
 * dialog keeps its local rank (putPinnedOrder sets the order).
 */
export function putDialog(w: WriteBatch, dialog: Dialog, topDate: number, selfId: number): void {
	w.add(
		`INSERT INTO dialogs (chat_id, top_seq, top_date, mute_until, pin_rank, unread_mark, pinned_message_count,
			pinned_message_seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		ON CONFLICT (chat_id) DO UPDATE SET top_seq = excluded.top_seq, top_date = excluded.top_date,
			mute_until = excluded.mute_until,
			pin_rank = CASE WHEN ?5 = 0 THEN 0 WHEN dialogs.pin_rank > 0 THEN dialogs.pin_rank ELSE 1 END,
			unread_mark = excluded.unread_mark, pinned_message_count = excluded.pinned_message_count,
			pinned_message_seq = excluded.pinned_message_seq`,
		[
			dialog.chatId,
			dialog.topSeq,
			topDate,
			dialog.muteUntil,
			dialog.pinned ? 1 : 0,
			flag(dialog.unreadMark),
			dialog.pinnedMessageCount,
			dialog.pinnedMessageSeq,
		],
	);
	putReadState(w, dialog, selfId);
	w.emit(EventKeys.dialogs, EventKeys.dialog(dialog.chatId));
}

/**
 * Takes the server's read state of a dialog. The server counted unread
 * messages up to dialog.topSeq; incoming messages the client already holds
 * beyond that point are still unread on top of it.
 */
export function putReadState(w: WriteBatch, dialog: Dialog, selfId: number): void {
	w.add(
		`INSERT INTO read_states (chat_id, topic_id, read_inbox_max_seq, read_outbox_max_seq, unread_count,
			unread_mentions_count, counted_through) VALUES (?1, ?2, ?3, ?4, ?5 + (
				SELECT count(*) FROM messages
				WHERE chat_id = ?1 AND seq > ?7 AND seq > ?3 AND from_id <> ?8 AND stale = 0 AND recalled = 0
			), ?6, ?7)
		ON CONFLICT (chat_id, topic_id) DO UPDATE SET read_inbox_max_seq = excluded.read_inbox_max_seq,
			read_outbox_max_seq = excluded.read_outbox_max_seq, unread_count = excluded.unread_count,
			unread_mentions_count = excluded.unread_mentions_count,
			counted_through = max(read_states.counted_through, excluded.counted_through)`,
		[
			dialog.chatId,
			CHAT_TOPIC,
			dialog.readInboxMaxSeq,
			dialog.readOutboxMaxSeq,
			dialog.unreadCount,
			dialog.unreadMentionsCount,
			dialog.topSeq,
			selfId,
		],
	);
	w.emit(EventKeys.dialog(dialog.chatId));
}

/**
 * Inserts a message that arrived as news (update, send result, history) and
 * keeps its dialog in step. An incoming message counts as unread exactly
 * once: when it is first inserted, and only above the read position and
 * above counted_through (messages the server's unread_count already holds).
 */
export function putNewMessage(w: WriteBatch, message: Message, selfId: number): void {
	ensureDialog(w, message.chatId);
	if (message.fromId !== selfId && !message.recalled) {
		// The chat row, and the topic row of a forum message when the client
		// keeps one.
		const topics = message.topicId === CHAT_TOPIC ? [CHAT_TOPIC] : [CHAT_TOPIC, message.topicId];
		for (const topic of topics) {
			w.add(
				`UPDATE read_states SET unread_count = unread_count + 1
				WHERE chat_id = ?1 AND topic_id = ?2 AND read_inbox_max_seq < ?3 AND counted_through < ?3
					AND NOT EXISTS (SELECT 1 FROM messages WHERE chat_id = ?1 AND seq = ?3 AND stale = 0)`,
				[message.chatId, topic, message.seq],
			);
		}
	}
	putMessage(w, message);
	raiseTop(w, message);
}

/** Moves the dialog top forward to `message` when it is newer; counters untouched. */
export function raiseTop(w: WriteBatch, message: Message): void {
	w.add("UPDATE dialogs SET top_seq = ?, top_date = ? WHERE chat_id = ? AND top_seq < ?", [
		message.seq,
		message.date,
		message.chatId,
		message.seq,
	]);
	w.emit(EventKeys.dialogs, EventKeys.dialog(message.chatId));
}

/** Recomputes the top of a dialog from the cached messages after its top was removed. */
export function retopDialog(w: WriteBatch, chatId: number): void {
	w.add(
		`UPDATE dialogs SET
			top_seq = COALESCE((SELECT max(seq) FROM messages WHERE chat_id = ?1), 0),
			top_date = COALESCE((SELECT date FROM messages WHERE chat_id = ?1 ORDER BY seq DESC LIMIT 1), top_date)
		WHERE chat_id = ?1 AND top_seq NOT IN (SELECT seq FROM messages WHERE chat_id = ?1)`,
		[chatId],
	);
}

/** Optimistic local read: the position and an unread count taken locally. */
export function putLocalRead(w: WriteBatch, chatId: number, maxSeq: number, unreadCount: number): void {
	w.add(
		`UPDATE read_states SET read_inbox_max_seq = ?, unread_count = ?
		WHERE chat_id = ? AND topic_id = ? AND read_inbox_max_seq <= ?`,
		[maxSeq, unreadCount, chatId, CHAT_TOPIC, maxSeq],
	);
	w.emit(EventKeys.dialog(chatId));
}

/**
 * Read update from the server. Outbox: others read the user's messages.
 * Inbox: the server counted unread messages up to read.topSeq, so incoming
 * messages the client already holds beyond it are unread on top, and later
 * ones are counted once when they arrive (counted_through). A topic read
 * also updates that topic's row.
 */
export function putRead(w: WriteBatch, read: Extract<UpdateBody, { kind: "read" }>, selfId: number): void {
	const { chatId, maxSeq } = read;
	if (read.outbox) {
		w.add(
			"UPDATE read_states SET read_outbox_max_seq = max(read_outbox_max_seq, ?) WHERE chat_id = ? AND topic_id = ?",
			[maxSeq, chatId, CHAT_TOPIC],
		);
		w.emit(EventKeys.dialog(chatId));
		return;
	}
	const beyond = `SELECT count(*) FROM messages
		WHERE chat_id = ?1 AND seq > ?2 AND from_id <> ?3 AND stale = 0 AND recalled = 0`;
	w.add(
		`UPDATE read_states SET read_inbox_max_seq = max(read_inbox_max_seq, ?4),
			unread_count = ?5 + (${beyond}), counted_through = ?2
		WHERE chat_id = ?1 AND topic_id = ?6 AND counted_through <= ?2`,
		[chatId, read.topSeq, selfId, maxSeq, read.unreadCount, CHAT_TOPIC],
	);
	if (read.topicId !== CHAT_TOPIC) {
		w.add(
			`INSERT INTO read_states (chat_id, topic_id, read_inbox_max_seq, read_outbox_max_seq, unread_count,
				unread_mentions_count, counted_through)
			VALUES (?1, ?6, ?4, 0, ?5 + (${beyond} AND topic_id = ?6), 0, ?2)
			ON CONFLICT (chat_id, topic_id) DO UPDATE SET
				read_inbox_max_seq = max(read_states.read_inbox_max_seq, excluded.read_inbox_max_seq),
				unread_count = excluded.unread_count, counted_through = excluded.counted_through
			WHERE read_states.counted_through <= excluded.counted_through`,
			[chatId, read.topSeq, selfId, maxSeq, read.topicUnreadCount, read.topicId],
		);
	}
	w.emit(EventKeys.dialog(chatId));
}

/**
 * A pin or unpin (seqs: several unpinned at once). The newest pin moves up
 * on a newer pin and is cleared when it is unpinned; the engine then
 * fetches the dialog for the exact count and the next newest pin.
 */
export function putPin(w: WriteBatch, chatId: number, seq: number, pinned: boolean, seqs: readonly number[] = []): void {
	if (pinned) {
		w.add("UPDATE chats SET pinned_seq = ? WHERE id = ? AND pinned_seq < ?", [seq, chatId, seq]);
		w.add("UPDATE dialogs SET pinned_message_seq = ? WHERE chat_id = ? AND pinned_message_seq < ?", [seq, chatId, seq]);
	} else {
		const gone = [seq, ...seqs].filter((s) => s !== 0);
		if (gone.length > 0) {
			const list = placeholders(gone.length);
			w.add(`UPDATE chats SET pinned_seq = 0 WHERE id = ? AND pinned_seq IN (${list})`, [chatId, ...gone]);
			w.add(`UPDATE dialogs SET pinned_message_seq = 0 WHERE chat_id = ? AND pinned_message_seq IN (${list})`, [
				chatId,
				...gone,
			]);
		}
	}
	w.emit(EventKeys.chat(chatId), EventKeys.dialog(chatId), EventKeys.pins(chatId));
}

/** Marks every cached message of the chat stale (too_long, ADR 0002). */
export function markChatStale(w: WriteBatch, chatId: number): void {
	w.add("UPDATE messages SET stale = 1 WHERE chat_id = ?", [chatId]);
	w.add("UPDATE dialogs SET history_start = 0 WHERE chat_id = ?", [chatId]);
	w.emit(EventKeys.history(chatId));
}

export function markAllStale(w: WriteBatch): void {
	w.add("UPDATE messages SET stale = 1");
	w.add("UPDATE dialogs SET history_start = 0");
}

export function setHistoryStart(w: WriteBatch, chatId: number): void {
	w.add("UPDATE dialogs SET history_start = 1 WHERE chat_id = ?", [chatId]);
}

/** Drops cached messages in [fromSeq, toSeq] that the server no longer returns. */
export function dropMissingInRange(
	w: WriteBatch,
	chatId: number,
	fromSeq: number,
	toSeq: number,
	keep: readonly number[],
): void {
	const keepClause = keep.length === 0 ? "" : ` AND seq NOT IN (${placeholders(keep.length)})`;
	w.add(`DELETE FROM messages WHERE chat_id = ? AND seq >= ? AND seq <= ?${keepClause}`, [
		chatId,
		fromSeq,
		toSeq,
		...keep,
	]);
	w.emit(EventKeys.history(chatId));
}

/** Drops stale rows above `seq`: the server's latest page showed they are gone. */
export function dropStaleAbove(w: WriteBatch, chatId: number, seq: number): void {
	w.add("DELETE FROM messages WHERE chat_id = ? AND seq > ? AND stale = 1", [chatId, seq]);
	w.emit(EventKeys.history(chatId));
}

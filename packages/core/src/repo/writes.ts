// Statement builders. A sync step collects its statements and event keys in
// one WriteBatch and commits them as a single atomic SqlDriver batch, so the
// database never holds half an update and listeners only hear about
// committed changes.
import type { SqlParams, SqlStatement } from "@app/platform";
import { EventKeys } from "../events/bus.ts";
import type { Chat, Dialog, Message, ReactionCount, SyncState, User } from "../model/types.ts";
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
			default_permissions, pinned_seq, created_at, my_role, my_permissions, left_chat)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET type = excluded.type, title = excluded.title, about = excluded.about,
			peer_user_id = excluded.peer_user_id,
			sync_mode = CASE WHEN chats.sync_mode = 'large' THEN 'large' ELSE excluded.sync_mode END,
			history_shared = excluded.history_shared, member_count = excluded.member_count,
			default_permissions = excluded.default_permissions, pinned_seq = excluded.pinned_seq,
			created_at = excluded.created_at, my_role = excluded.my_role,
			my_permissions = excluded.my_permissions, left_chat = excluded.left_chat`,
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
		],
	);
	w.emit(EventKeys.chat(chat.id));
}

/** Indexed text of a message: its text folded per ADR 0005; system messages are not indexed. */
export function messageSearchText(message: Message): string {
	return message.action === null ? searchText(message.text) : "";
}

/**
 * Inserts or refreshes a message. An older edit_version never overwrites a
 * newer one (edits can arrive out of order through history and realtime),
 * except over a stale row: after a restore the server may reuse a seq.
 * Writing a row clears its stale mark: it now matches the server.
 */
export function putMessage(w: WriteBatch, message: Message): void {
	w.add(
		`INSERT INTO messages (chat_id, seq, from_id, date, text, entities, media_kind, reply_to_seq, forward,
			edit_date, edit_version, random_id, grouped_id, via_bot_id, reactions, integration_label, action,
			search_text, stale)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		ON CONFLICT (chat_id, seq) DO UPDATE SET from_id = excluded.from_id, date = excluded.date,
			text = excluded.text, entities = excluded.entities, media_kind = excluded.media_kind,
			reply_to_seq = excluded.reply_to_seq, forward = excluded.forward, edit_date = excluded.edit_date,
			edit_version = excluded.edit_version,
			random_id = CASE WHEN excluded.random_id <> 0 THEN excluded.random_id ELSE messages.random_id END,
			grouped_id = excluded.grouped_id, via_bot_id = excluded.via_bot_id, reactions = excluded.reactions,
			integration_label = excluded.integration_label, action = excluded.action,
			search_text = excluded.search_text, stale = 0
		WHERE excluded.edit_version >= messages.edit_version OR messages.stale = 1`,
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
			message.action === null ? null : JSON.stringify(message.action),
			messageSearchText(message),
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

/** Replaces a dialog with the server's view (dialog snapshot). */
export function putDialog(w: WriteBatch, dialog: Dialog, topDate: number, selfId: number): void {
	w.add(
		`INSERT INTO dialogs (chat_id, top_seq, top_date) VALUES (?, ?, ?)
		ON CONFLICT (chat_id) DO UPDATE SET top_seq = excluded.top_seq, top_date = excluded.top_date`,
		[dialog.chatId, dialog.topSeq, topDate],
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
				WHERE chat_id = ?1 AND seq > ?7 AND seq > ?3 AND from_id <> ?8 AND stale = 0
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
	if (message.fromId !== selfId) {
		w.add(
			`UPDATE read_states SET unread_count = unread_count + 1
			WHERE chat_id = ?1 AND topic_id = ?2 AND read_inbox_max_seq < ?3 AND counted_through < ?3
				AND NOT EXISTS (SELECT 1 FROM messages WHERE chat_id = ?1 AND seq = ?3 AND stale = 0)`,
			[message.chatId, CHAT_TOPIC, message.seq],
		);
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

export function putRead(
	w: WriteBatch,
	chatId: number,
	maxSeq: number,
	outbox: boolean,
	unreadCount: number,
): void {
	if (outbox) {
		w.add(
			"UPDATE read_states SET read_outbox_max_seq = max(read_outbox_max_seq, ?) WHERE chat_id = ? AND topic_id = ?",
			[maxSeq, chatId, CHAT_TOPIC],
		);
	} else {
		w.add(
			`UPDATE read_states SET read_inbox_max_seq = ?, unread_count = ?
			WHERE chat_id = ? AND topic_id = ? AND read_inbox_max_seq <= ?`,
			[maxSeq, unreadCount, chatId, CHAT_TOPIC, maxSeq],
		);
	}
	w.emit(EventKeys.dialog(chatId));
}

export function putPin(w: WriteBatch, chatId: number, seq: number, pinned: boolean): void {
	if (pinned) {
		w.add("UPDATE chats SET pinned_seq = ? WHERE id = ?", [seq, chatId]);
	} else {
		w.add("UPDATE chats SET pinned_seq = 0 WHERE id = ? AND pinned_seq = ?", [chatId, seq]);
	}
	w.emit(EventKeys.chat(chatId));
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

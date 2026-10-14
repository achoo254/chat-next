// Permission-driven purge (ADR 0009): when the user leaves or is removed
// from a chat, or messages are hidden, the local copy goes too; recalled
// messages keep only a placeholder.
// The messages_fts triggers remove the search rows with the message rows, so
// nothing purged stays searchable. Media cache purge joins here with R3.
import { EventKeys } from "../events/bus.ts";
import { CHAT_TOPIC, placeholders, retopDialog, type WriteBatch } from "../repo/writes.ts";

/** Removes every local trace of a chat's content and pending operations. */
export function purgeChat(w: WriteBatch, chatId: number): void {
	w.add("DELETE FROM messages WHERE chat_id = ?", [chatId]);
	w.add("DELETE FROM dialogs WHERE chat_id = ?", [chatId]);
	w.add("DELETE FROM read_states WHERE chat_id = ?", [chatId]);
	w.add("DELETE FROM chat_sync_state WHERE chat_id = ?", [chatId]);
	w.add("DELETE FROM outbox WHERE chat_id = ?", [chatId]);
	w.add("UPDATE chats SET left_chat = 1, pinned_seq = 0 WHERE id = ?", [chatId]);
	w.emit(EventKeys.dialogs, EventKeys.dialog(chatId), EventKeys.chat(chatId), EventKeys.history(chatId), EventKeys.outbox);
}

/**
 * Turns cached messages recalled by their sender (deleted for everyone)
 * into placeholders: content, entities, reactions, reply, preview and the
 * search text go (the FTS trigger drops the search row), the row keeps its
 * place. Unread messages among them stop counting as unread.
 */
export function recallMessages(w: WriteBatch, chatId: number, seqs: readonly number[], selfId: number): void {
	if (seqs.length === 0) return;
	const list = placeholders(seqs.length);
	w.add(
		`UPDATE read_states SET unread_count = max(0, unread_count - (
			SELECT count(*) FROM messages
			WHERE chat_id = ? AND seq IN (${list}) AND from_id <> ? AND recalled = 0 AND seq > read_states.read_inbox_max_seq
		)) WHERE chat_id = ? AND topic_id = ?`,
		[chatId, ...seqs, selfId, chatId, CHAT_TOPIC],
	);
	w.add(
		`UPDATE messages SET text = '', entities = '[]', media_kind = NULL, reply_to_seq = 0, forward = NULL,
			edit_date = 0, via_bot_id = 0, reactions = '[]', integration_label = '', buttons = NULL, action = NULL, search_text = '',
			link_preview = NULL, recalled = 1
		WHERE chat_id = ? AND seq IN (${list})`,
		[chatId, ...seqs],
	);
	w.emit(EventKeys.history(chatId), EventKeys.dialog(chatId), EventKeys.dialogs);
	for (const seq of seqs) w.emit(EventKeys.message(chatId, seq));
}

/**
 * Removes messages hidden for this user (or deleted for everyone, by a
 * server that keeps no placeholders). Unread messages among them stop
 * counting as unread.
 */
export function purgeMessages(w: WriteBatch, chatId: number, seqs: readonly number[], selfId: number): void {
	if (seqs.length === 0) return;
	const list = placeholders(seqs.length);
	w.add(
		`UPDATE read_states SET unread_count = max(0, unread_count - (
			SELECT count(*) FROM messages
			WHERE chat_id = ? AND seq IN (${list}) AND from_id <> ? AND recalled = 0
				AND seq > read_states.read_inbox_max_seq
		)) WHERE chat_id = ? AND topic_id = ?`,
		[chatId, ...seqs, selfId, chatId, CHAT_TOPIC],
	);
	w.add(`DELETE FROM messages WHERE chat_id = ? AND seq IN (${list})`, [chatId, ...seqs]);
	retopDialog(w, chatId);
	w.emit(EventKeys.history(chatId), EventKeys.dialog(chatId), EventKeys.dialogs);
	for (const seq of seqs) w.emit(EventKeys.message(chatId, seq));
}

// Permission-driven purge (ADR 0009): when the user leaves or is removed
// from a chat, or messages are deleted or hidden, the local copy goes too.
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
 * Removes messages deleted for everyone or hidden for this user. Unread
 * messages among them stop counting as unread.
 */
export function purgeMessages(w: WriteBatch, chatId: number, seqs: readonly number[], selfId: number): void {
	if (seqs.length === 0) return;
	const list = placeholders(seqs.length);
	w.add(
		`UPDATE read_states SET unread_count = max(0, unread_count - (
			SELECT count(*) FROM messages
			WHERE chat_id = ? AND seq IN (${list}) AND from_id <> ? AND seq > read_states.read_inbox_max_seq
		)) WHERE chat_id = ? AND topic_id = ?`,
		[chatId, ...seqs, selfId, chatId, CHAT_TOPIC],
	);
	w.add(`DELETE FROM messages WHERE chat_id = ? AND seq IN (${list})`, [chatId, ...seqs]);
	retopDialog(w, chatId);
	w.emit(EventKeys.history(chatId), EventKeys.dialog(chatId), EventKeys.dialogs);
	for (const seq of seqs) w.emit(EventKeys.message(chatId, seq));
}

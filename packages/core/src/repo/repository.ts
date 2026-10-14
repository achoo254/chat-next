// Reads of the local database and the single commit path for writes.
import type { SqlDriver, SqlRow } from "@app/platform";
import type { EventBus } from "../events/bus.ts";
import type { Chat, Dialog, Message, NotificationSettings, SyncState, User } from "../model/types.ts";
import { num, parseNotificationSettings, rowToChat, rowToDialog, rowToMessage, rowToUser, str } from "./rows.ts";
import { CHAT_TOPIC, placeholders, type WriteBatch } from "./writes.ts";

/** A cached message plus whether it still has to be checked against the server. */
export type StoredMessage = Message & { readonly stale: boolean };

export interface DialogView {
	readonly dialog: Dialog;
	readonly chat: Chat | null;
	readonly topMessage: StoredMessage | null;
	/** Private chats: the other participant. */
	readonly peer: User | null;
}

export interface OutboxRow {
	readonly id: number;
	readonly chatId: number;
	readonly kind: string;
	readonly randomId: number;
	readonly payload: string;
	readonly createdAt: number;
	readonly attempts: number;
	/** Permanent failure reported by the server; the item waits for retry or discard. */
	readonly failure: string | null;
}

function toStored(row: SqlRow): StoredMessage {
	return { ...rowToMessage(row), stale: num(row, "stale") !== 0 };
}

// Dialog rows joined with the chat-level read state (topic 0) and the
// large-chat log position.
const DIALOG_SELECT = `SELECT d.chat_id, d.top_seq, d.top_date, d.history_start, d.mute_until, d.pin_rank,
	d.unread_mark, d.pinned_message_count, d.pinned_message_seq,
	COALESCE(r.read_inbox_max_seq, 0) AS read_inbox_max_seq, COALESCE(r.read_outbox_max_seq, 0) AS read_outbox_max_seq,
	COALESCE(r.unread_count, 0) AS unread_count, COALESCE(r.unread_mentions_count, 0) AS unread_mentions_count,
	COALESCE(s.chat_pts, 0) AS chat_pts
	FROM dialogs d
	LEFT JOIN read_states r ON r.chat_id = d.chat_id AND r.topic_id = ${CHAT_TOPIC}
	LEFT JOIN chat_sync_state s ON s.chat_id = d.chat_id`;

export class Repository {
	constructor(
		readonly driver: SqlDriver,
		private readonly bus: EventBus,
	) {}

	/** Commits the batch atomically, then announces its events. */
	async commit(w: WriteBatch): Promise<void> {
		if (w.statements.length > 0) await this.driver.batch(w.statements);
		this.bus.emitAll(w.events);
	}

	async syncState(): Promise<SyncState | null> {
		const rows = await this.driver.query("SELECT pts, server_epoch, date FROM sync_state WHERE id = 1");
		const row = rows[0];
		if (row === undefined) return null;
		return { pts: num(row, "pts"), serverEpoch: num(row, "server_epoch"), date: num(row, "date") };
	}

	async chatPts(chatId: number): Promise<number | null> {
		const rows = await this.driver.query("SELECT chat_pts FROM chat_sync_state WHERE chat_id = ?", [chatId]);
		const row = rows[0];
		return row === undefined ? null : num(row, "chat_pts");
	}

	async allChatPts(): Promise<Map<number, number>> {
		const rows = await this.driver.query("SELECT chat_id, chat_pts FROM chat_sync_state");
		return new Map(rows.map((row) => [num(row, "chat_id"), num(row, "chat_pts")]));
	}

	async user(id: number): Promise<User | null> {
		const rows = await this.driver.query("SELECT * FROM users WHERE id = ?", [id]);
		const row = rows[0];
		return row === undefined ? null : rowToUser(row);
	}

	async users(ids: readonly number[]): Promise<User[]> {
		if (ids.length === 0) return [];
		const rows = await this.driver.query(`SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`, ids);
		return rows.map(rowToUser);
	}

	async chat(id: number): Promise<Chat | null> {
		const rows = await this.driver.query("SELECT * FROM chats WHERE id = ?", [id]);
		const row = rows[0];
		return row === undefined ? null : rowToChat(row);
	}

	/** Ids from `ids` that have no row in `table`. */
	async missing(table: "users" | "chats", ids: Iterable<number>): Promise<number[]> {
		const wanted = [...new Set(ids)].filter((id) => id !== 0);
		if (wanted.length === 0) return [];
		const rows = await this.driver.query(
			`SELECT id FROM ${table} WHERE id IN (${placeholders(wanted.length)})`,
			wanted,
		);
		const present = new Set(rows.map((row) => num(row, "id")));
		return wanted.filter((id) => !present.has(id));
	}

	async dialog(chatId: number): Promise<(Dialog & { historyStart: boolean; topDate: number }) | null> {
		const rows = await this.driver.query(
			`${DIALOG_SELECT} WHERE d.chat_id = ?`,
			[chatId],
		);
		const row = rows[0];
		if (row === undefined) return null;
		return { ...rowToDialog(row), historyStart: num(row, "history_start") !== 0, topDate: num(row, "top_date") };
	}

	/** What the unread badge counts, for every dialog. */
	async badgeDialogs(): Promise<Pick<Dialog, "unreadCount" | "muteUntil" | "unreadMark">[]> {
		const rows = await this.driver.query(
			`SELECT COALESCE(r.unread_count, 0) AS unread_count, d.mute_until, d.unread_mark FROM dialogs d
			LEFT JOIN read_states r ON r.chat_id = d.chat_id AND r.topic_id = ${CHAT_TOPIC}`,
		);
		return rows.map((row) => ({
			unreadCount: num(row, "unread_count"),
			muteUntil: num(row, "mute_until"),
			unreadMark: num(row, "unread_mark") !== 0,
		}));
	}

	async dialogChatIds(): Promise<number[]> {
		const rows = await this.driver.query("SELECT chat_id FROM dialogs");
		return rows.map((row) => num(row, "chat_id"));
	}

	/** The dialog list, pinned chats first (pinned order), then newest first, with what a list row renders. */
	async dialogViews(limit: number): Promise<DialogView[]> {
		const rows = await this.driver.query(
			`${DIALOG_SELECT} ORDER BY d.pin_rank DESC, d.top_date DESC, d.chat_id DESC LIMIT ?`,
			[limit],
		);
		const dialogs = rows.map(rowToDialog);
		if (dialogs.length === 0) return [];
		const chatIds = dialogs.map((d) => d.chatId);
		const chatRows = await this.driver.query(
			`SELECT * FROM chats WHERE id IN (${placeholders(chatIds.length)})`,
			chatIds,
		);
		const chats = new Map(chatRows.map((row) => [num(row, "id"), rowToChat(row)]));
		const tops = await this.driver.query(
			`SELECT m.* FROM messages m JOIN dialogs d ON d.chat_id = m.chat_id AND d.top_seq = m.seq
			WHERE d.chat_id IN (${placeholders(chatIds.length)})`,
			chatIds,
		);
		const topByChat = new Map(tops.map((row) => [num(row, "chat_id"), toStored(row)]));
		const peerIds = [...chats.values()].map((c) => c.peerUserId).filter((id) => id !== 0);
		const peers = new Map((await this.users(peerIds)).map((u) => [u.id, u]));
		return dialogs.map((dialog) => {
			const chat = chats.get(dialog.chatId) ?? null;
			return {
				dialog,
				chat,
				topMessage: topByChat.get(dialog.chatId) ?? null,
				peer: chat === null ? null : (peers.get(chat.peerUserId) ?? null),
			};
		});
	}

	async message(chatId: number, seq: number): Promise<StoredMessage | null> {
		const rows = await this.driver.query("SELECT * FROM messages WHERE chat_id = ? AND seq = ?", [chatId, seq]);
		const row = rows[0];
		return row === undefined ? null : toStored(row);
	}

	/** Up to `limit` messages with seq < beforeSeq (0 = from the newest), ascending. */
	async messagesBefore(chatId: number, beforeSeq: number, limit: number): Promise<StoredMessage[]> {
		const bound = beforeSeq === 0 ? Number.MAX_SAFE_INTEGER : beforeSeq;
		const rows = await this.driver.query(
			"SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
			[chatId, bound, limit],
		);
		return rows.map(toStored).reverse();
	}

	/** Up to `limit` messages with seq > afterSeq, ascending. */
	async messagesAfter(chatId: number, afterSeq: number, limit: number): Promise<StoredMessage[]> {
		const rows = await this.driver.query(
			"SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
			[chatId, afterSeq, limit],
		);
		return rows.map(toStored);
	}

	async maxSeq(chatId: number): Promise<number> {
		const rows = await this.driver.query("SELECT max(seq) AS seq FROM messages WHERE chat_id = ?", [chatId]);
		return num(rows[0] ?? {}, "seq");
	}

	/** Incoming messages after `seq` (the unread count after reading up to it); placeholders do not count. */
	async countIncomingAfter(chatId: number, seq: number, selfId: number): Promise<number> {
		const rows = await this.driver.query(
			"SELECT count(*) AS n FROM messages WHERE chat_id = ? AND seq > ? AND from_id <> ? AND recalled = 0",
			[chatId, seq, selfId],
		);
		return num(rows[0] ?? {}, "n");
	}

	/** The user's notification settings; null until fetched from the server. */
	async notificationSettings(): Promise<NotificationSettings | null> {
		const rows = await this.driver.query("SELECT settings FROM notification_settings WHERE id = 1");
		const row = rows[0];
		return row === undefined ? null : parseNotificationSettings(str(row, "settings"));
	}

	async outbox(chatId?: number): Promise<OutboxRow[]> {
		const rows =
			chatId === undefined
				? await this.driver.query("SELECT * FROM outbox ORDER BY id")
				: await this.driver.query("SELECT * FROM outbox WHERE chat_id = ? ORDER BY id", [chatId]);
		return rows.map((row) => ({
			id: num(row, "id"),
			chatId: num(row, "chat_id"),
			kind: str(row, "kind"),
			randomId: num(row, "random_id"),
			payload: str(row, "payload"),
			createdAt: num(row, "created_at"),
			attempts: num(row, "attempts"),
			failure: typeof row.failure === "string" ? row.failure : null,
		}));
	}

	/** Full-text search over cached messages; `match` is an FTS5 query. */
	async search(match: string, chatId: number, limit: number): Promise<StoredMessage[]> {
		const chatFilter = chatId === 0 ? "" : " AND m.chat_id = ?";
		const params = chatId === 0 ? [match, limit] : [match, chatId, limit];
		const rows = await this.driver.query(
			`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
			WHERE messages_fts MATCH ?${chatFilter} ORDER BY m.date DESC, m.seq DESC LIMIT ?`,
			params,
		);
		return rows.map(toStored);
	}
}

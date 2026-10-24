// Reads of the local database and the single commit path for writes.
import type { SqlDriver, SqlRow } from "@achoo254/chat-platform";
import type { EventBus } from "../events/bus.ts";
import type { Chat, Dialog, Message, NotificationSettings, SearchFilters, SyncState, User } from "../model/types.ts";
import type { TextMatch } from "../search/index.ts";
import { mentionsUser } from "../entities/index.ts";
import { num, parseEntities, parseNotificationSettings, rowToChat, rowToDialog, rowToMessage, rowToUser, str } from "./rows.ts";
import { CHAT_TOPIC, placeholders, type WriteBatch } from "./writes.ts";

/** What Repository.search looks for. */
export interface LocalSearchRequest {
	/** How the query's tokens match; null lists every message with content (filters only). */
	readonly match: TextMatch | null;
	/** 0 = every chat. */
	readonly chatId: number;
	/** 0 = every topic. */
	readonly topicId: number;
	readonly filters: SearchFilters;
	readonly limit: number;
}

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

	/**
	 * Dialogs this device cannot show: no chat stored, or a private chat
	 * whose other person is 0, not stored, or the user themselves while the
	 * chat has more than one member (only "Cloud của tôi" has the user as
	 * its own peer).
	 */
	async dialogsToRepair(selfId: number): Promise<number[]> {
		const rows = await this.driver.query(
			`SELECT d.chat_id FROM dialogs d
			LEFT JOIN chats c ON c.id = d.chat_id
			LEFT JOIN users u ON u.id = c.peer_user_id
			WHERE c.id IS NULL
				OR (c.type = 'private' AND (c.peer_user_id = 0 OR u.id IS NULL OR (c.peer_user_id = ? AND c.member_count > 1)))
			ORDER BY d.chat_id`,
			[selfId],
		);
		return rows.map((row) => num(row, "chat_id"));
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

	/** The newest message from `fromId` in the chat that sets or removes a reply keyboard; null for none. */
	async newestKeyboard(chatId: number, fromId: number): Promise<StoredMessage | null> {
		const rows = await this.driver.query(
			"SELECT * FROM messages WHERE chat_id = ? AND from_id = ? AND reply_keyboard IS NOT NULL ORDER BY seq DESC LIMIT 1",
			[chatId, fromId],
		);
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

	/**
	 * Incoming messages after `seq` that mention the user or reply to them
	 * (the "@" count after reading up to it); placeholders do not count.
	 */
	async countMentionsAfter(chatId: number, seq: number, selfId: number): Promise<number> {
		const self = await this.driver.query("SELECT username FROM users WHERE id = ?", [selfId]);
		const username = str(self[0] ?? {}, "username");
		const rows = await this.driver.query(
			`SELECT m.text, m.entities, EXISTS (
				SELECT 1 FROM messages o WHERE o.chat_id = m.chat_id AND o.seq = m.reply_to_seq AND o.from_id = ?3
			) AS reply_to_me
			FROM messages m WHERE m.chat_id = ?1 AND m.seq > ?2 AND m.from_id <> ?3 AND m.recalled = 0`,
			[chatId, seq, selfId],
		);
		return rows.filter(
			(row) =>
				num(row, "reply_to_me") !== 0 ||
				mentionsUser(str(row, "text"), parseEntities(str(row, "entities")), selfId, username),
		).length;
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

	/**
	 * Cached messages matching an FTS5 query (null: every message with
	 * content) and the filters, newest first.
	 */
	async search(request: LocalSearchRequest): Promise<StoredMessage[]> {
		const where: string[] = ["m.action IS NULL", "m.recalled = 0"];
		const params: (string | number)[] = [];
		let from = "messages m";
		const match = request.match;
		if (match === null) {
			where.push("(m.search_text <> '' OR m.media_kind IS NOT NULL)");
		} else if (match.kind === "words") {
			from = "messages_fts f JOIN messages m ON m.id = f.rowid";
			where.push("messages_fts MATCH ?");
			params.push(match.fts);
		} else {
			from = "messages_trigram t JOIN messages m ON m.id = t.rowid";
			where.push("messages_trigram MATCH ?");
			params.push(match.trigram);
			for (const token of match.contains) {
				where.push("instr(m.search_text, ?) > 0");
				params.push(token);
			}
		}
		if (request.chatId !== 0) {
			where.push("m.chat_id = ?");
			params.push(request.chatId);
		}
		if (request.topicId !== 0) {
			where.push("m.topic_id = ?");
			params.push(request.topicId);
		}
		const f = request.filters;
		if ((f.fromId ?? 0) !== 0) {
			where.push("m.from_id = ?");
			params.push(f.fromId ?? 0);
		}
		if (f.mediaKind !== undefined) {
			where.push("m.media_kind = ?");
			params.push(f.mediaKind);
		}
		if (f.hasLink === true) {
			where.push(`(m.link_preview IS NOT NULL OR m.entities LIKE '%"url"%' OR m.entities LIKE '%"text_link"%'
				OR m.text LIKE '%http://%' OR m.text LIKE '%https://%')`);
		}
		if ((f.since ?? 0) > 0) {
			where.push("m.date >= ?");
			params.push(f.since ?? 0);
		}
		if ((f.until ?? 0) > 0) {
			where.push("m.date <= ?");
			params.push(f.until ?? 0);
		}
		params.push(request.limit);
		const rows = await this.driver.query(
			`SELECT m.* FROM ${from} WHERE ${where.join(" AND ")} ORDER BY m.date DESC, m.chat_id DESC, m.seq DESC LIMIT ?`,
			params,
		);
		return rows.map(toStored);
	}
}

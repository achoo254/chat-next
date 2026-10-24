// Local schema, shared by web, mobile and desktop through SqlDriver (ADR 0009).
// Migrations are TypeScript rather than .sql files so every bundler and the
// Node test runner load them the same way. Versions only grow; a database
// from a newer build is reset and synced again (the server is the source of
// truth).
import type { SqlDriver, SqlStatement } from "@achoo254/chat-platform";
import { FTS5_TOKENIZE } from "../vifold/index.ts";

export interface Migration {
	readonly version: number;
	readonly statements: readonly string[];
}

/** Quotes an FTS5 option value; double quotes inside are doubled. */
function fts5Quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		statements: [
			// Per-user log position (ADR 0002); one row once the first sync ran.
			`CREATE TABLE sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				pts INTEGER NOT NULL,
				server_epoch INTEGER NOT NULL,
				date INTEGER NOT NULL
			)`,
			// Per-chat log position of every sync_mode=large chat.
			`CREATE TABLE chat_sync_state (
				chat_id INTEGER PRIMARY KEY,
				chat_pts INTEGER NOT NULL
			)`,
			`CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				username TEXT NOT NULL,
				name TEXT NOT NULL,
				bio TEXT NOT NULL,
				is_bot INTEGER NOT NULL,
				is_self INTEGER NOT NULL,
				is_blocked INTEGER NOT NULL
			)`,
			`CREATE TABLE chats (
				id INTEGER PRIMARY KEY,
				type TEXT NOT NULL,
				title TEXT NOT NULL,
				about TEXT NOT NULL,
				peer_user_id INTEGER NOT NULL,
				sync_mode TEXT NOT NULL,
				history_shared INTEGER NOT NULL,
				member_count INTEGER NOT NULL,
				default_permissions INTEGER NOT NULL,
				pinned_seq INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				my_role TEXT NOT NULL,
				my_permissions INTEGER NOT NULL,
				left_chat INTEGER NOT NULL
			)`,
			// history_start: the oldest message of the chat is cached, so paging
			// older stops locally.
			`CREATE TABLE dialogs (
				chat_id INTEGER PRIMARY KEY,
				top_seq INTEGER NOT NULL,
				top_date INTEGER NOT NULL,
				history_start INTEGER NOT NULL DEFAULT 0
			)`,
			// Read position and unread counters per (chat, topic). topic_id 0 is
			// the chat as a whole; forum topics (R1, protocol fields pending) add
			// rows with their own topic_id without changing this table.
			// counted_through: the server's unread_count already includes every
			// incoming message up to this seq, so they are not counted twice.
			`CREATE TABLE read_states (
				chat_id INTEGER NOT NULL,
				topic_id INTEGER NOT NULL DEFAULT 0,
				read_inbox_max_seq INTEGER NOT NULL,
				read_outbox_max_seq INTEGER NOT NULL,
				unread_count INTEGER NOT NULL,
				unread_mentions_count INTEGER NOT NULL,
				counted_through INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (chat_id, topic_id)
			) WITHOUT ROWID`,
			"CREATE INDEX dialogs_by_date ON dialogs (top_date DESC, chat_id DESC)",
			// id is the local rowid shared with messages_fts. stale marks rows
			// that must be checked against the server before they are trusted
			// (too_long, ADR 0002). topic_id is the forum topic inside the chat's
			// single seq stream; NULL until the protocol carries it.
			`CREATE TABLE messages (
				id INTEGER PRIMARY KEY,
				chat_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				topic_id INTEGER,
				from_id INTEGER NOT NULL,
				date INTEGER NOT NULL,
				text TEXT NOT NULL,
				entities TEXT NOT NULL,
				media_kind TEXT,
				reply_to_seq INTEGER NOT NULL,
				forward TEXT,
				edit_date INTEGER NOT NULL,
				edit_version INTEGER NOT NULL,
				random_id INTEGER NOT NULL,
				grouped_id INTEGER NOT NULL,
				via_bot_id INTEGER NOT NULL,
				reactions TEXT NOT NULL,
				integration_label TEXT NOT NULL,
				action TEXT,
				search_text TEXT NOT NULL,
				stale INTEGER NOT NULL DEFAULT 0,
				UNIQUE (chat_id, seq)
			)`,
			"CREATE INDEX messages_by_topic ON messages (chat_id, topic_id, seq)",
			// FTS5 over the vifold search text (ADR 0005). External content:
			// the triggers keep it in step with messages, so every purge of a
			// message row also purges its search row.
			`CREATE VIRTUAL TABLE messages_fts USING fts5(
				search_text,
				content = 'messages',
				content_rowid = 'id',
				tokenize = ${fts5Quote(FTS5_TOKENIZE)}
			)`,
			`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts (rowid, search_text) VALUES (new.id, new.search_text);
			END`,
			`CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
				INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
			END`,
			`CREATE TRIGGER messages_fts_update AFTER UPDATE OF search_text ON messages BEGIN
				INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
				INSERT INTO messages_fts (rowid, search_text) VALUES (new.id, new.search_text);
			END`,
			// Operations waiting for the server, ordered per chat by id.
			`CREATE TABLE outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				random_id INTEGER NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				failure TEXT
			)`,
			"CREATE INDEX outbox_by_chat ON outbox (chat_id, id)",
		],
	},
	{
		version: 2,
		statements: [
			// Forum groups (topics) and the text-only link preview of a message.
			"ALTER TABLE chats ADD COLUMN forum INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE messages ADD COLUMN link_preview TEXT",
		],
	},
	{
		version: 3,
		statements: [
			// The user's own dialog settings: muted until (unix seconds, 0 = not
			// muted) and pinned position (0 = not pinned, higher = nearer the top).
			"ALTER TABLE dialogs ADD COLUMN mute_until INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE dialogs ADD COLUMN pin_rank INTEGER NOT NULL DEFAULT 0",
			// Existing dialogs lack these settings: dropping the sync position
			// makes the next start take a fresh dialog snapshot.
			"DELETE FROM sync_state",
		],
	},
	{
		version: 4,
		statements: [
			// Recalled messages stay as placeholders (no content, not searchable).
			"ALTER TABLE messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0",
			// The user's unread mark, and the pinned messages they see (count and newest).
			"ALTER TABLE dialogs ADD COLUMN unread_mark INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE dialogs ADD COLUMN pinned_message_count INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE dialogs ADD COLUMN pinned_message_seq INTEGER NOT NULL DEFAULT 0",
			// The user's notification settings (JSON of NotificationSettings); no row until fetched.
			`CREATE TABLE notification_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				settings TEXT NOT NULL
			)`,
			// Existing dialogs lack these fields and recalled messages were
			// removed: a fresh dialog snapshot marks the cache stale, so history
			// comes back with the placeholders.
			"DELETE FROM sync_state",
		],
	},
	{
		version: 5,
		statements: [
			// Inline buttons of a message (JSON rows of MessageButton; NULL = none),
			// posted by incoming webhooks. Older cached messages had none.
			"ALTER TABLE messages ADD COLUMN buttons TEXT",
		],
	},
	{
		version: 6,
		statements: [
			// Posted without a notification (silent incoming webhooks). Older
			// cached messages count as not silent; they never notify again anyway.
			"ALTER TABLE messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0",
		],
	},
	{
		version: 7,
		statements: [
			// The attached file of a message (JSON of MediaRef; NULL = none);
			// media_kind stays for list previews and older readers.
			"ALTER TABLE messages ADD COLUMN media TEXT",
			// Files being uploaded for queued media sends (the file itself is in
			// the platform BlobStore under upload:<key>). parts: JSON of the
			// uploaded parts with their ETags; media: the MediaRef once complete.
			`CREATE TABLE uploads (
				key TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				file_name TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				width INTEGER NOT NULL,
				height INTEGER NOT NULL,
				duration INTEGER NOT NULL,
				inline_thumb BLOB,
				waveform BLOB,
				file_hash TEXT,
				upload_id TEXT,
				part_size INTEGER NOT NULL DEFAULT 0,
				parts TEXT NOT NULL DEFAULT '[]',
				media TEXT,
				failure TEXT,
				created_at INTEGER NOT NULL
			)`,
			// Downloaded media (blob in the BlobStore under cache:<key>), with
			// LRU and age bookkeeping. large counts against the separate
			// large-file budget.
			`CREATE TABLE media_cache (
				key TEXT PRIMARY KEY,
				bytes INTEGER NOT NULL,
				large INTEGER NOT NULL,
				last_access INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			)`,
			"CREATE INDEX media_cache_by_access ON media_cache (last_access)",
			// Messages a cached file was fetched for. A file whose messages all
			// went (deleted, recalled, hidden, chat left) is evicted.
			`CREATE TABLE media_cache_refs (
				key TEXT NOT NULL,
				chat_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				PRIMARY KEY (key, chat_id, seq)
			) WITHOUT ROWID`,
			"CREATE INDEX media_cache_refs_by_message ON media_cache_refs (chat_id, seq)",
			`CREATE TRIGGER media_refs_message_delete AFTER DELETE ON messages BEGIN
				DELETE FROM media_cache_refs WHERE chat_id = old.chat_id AND seq = old.seq;
			END`,
			`CREATE TRIGGER media_refs_message_recall AFTER UPDATE OF recalled ON messages WHEN new.recalled = 1 BEGIN
				DELETE FROM media_cache_refs WHERE chat_id = new.chat_id AND seq = new.seq;
			END`,
		],
	},
	{
		version: 8,
		statements: [
			// Substring search (the server's rule, search/index.ts): a trigram
			// FTS5 table over the same vifold search text, kept in step by
			// triggers like messages_fts, which stays for queries of short
			// words. case_sensitive 1: the text and the query are already
			// folded, so a match is exactly a substring, as on the server.
			`CREATE VIRTUAL TABLE messages_trigram USING fts5(
				search_text,
				content = 'messages',
				content_rowid = 'id',
				tokenize = 'trigram case_sensitive 1'
			)`,
			`CREATE TRIGGER messages_trigram_insert AFTER INSERT ON messages BEGIN
				INSERT INTO messages_trigram (rowid, search_text) VALUES (new.id, new.search_text);
			END`,
			`CREATE TRIGGER messages_trigram_delete AFTER DELETE ON messages BEGIN
				INSERT INTO messages_trigram (messages_trigram, rowid, search_text) VALUES ('delete', old.id, old.search_text);
			END`,
			`CREATE TRIGGER messages_trigram_update AFTER UPDATE OF search_text ON messages BEGIN
				INSERT INTO messages_trigram (messages_trigram, rowid, search_text) VALUES ('delete', old.id, old.search_text);
				INSERT INTO messages_trigram (rowid, search_text) VALUES (new.id, new.search_text);
			END`,
			// Index the messages already cached.
			"INSERT INTO messages_trigram (messages_trigram) VALUES ('rebuild')",
		],
	},
	{
		version: 9,
		statements: [
			// The reply keyboard a bot message sets or removes (JSON of
			// ReplyKeyboard; NULL = none). Callback buttons ride in the existing
			// buttons JSON. Cached bot messages had neither: the next history
			// load brings them, as older messages never show a keyboard anyway.
			"ALTER TABLE messages ADD COLUMN reply_keyboard TEXT",
		],
	},
	{
		version: 10,
		statements: [
			// A bot's reply keyboard hidden on this device (a one-time keyboard
			// after its tap, or the user's toggle), so it stays hidden after a
			// reload. Local only: upserts from the server leave it alone.
			"ALTER TABLE messages ADD COLUMN keyboard_hidden INTEGER NOT NULL DEFAULT 0",
		],
	},
	{
		version: 11,
		statements: [
			// User.deleted: the account was deleted (or waits for deletion).
			// Cached users were all live; the server's next copy of a deleted
			// one sets it.
			"ALTER TABLE users ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
		],
	},
	{
		version: 12,
		statements: [
			// User.photoId: the profile photo's file_id; cached
			// users get it with the server's next copy.
			"ALTER TABLE users ADD COLUMN photo_id TEXT NOT NULL DEFAULT ''",
		],
	},
	{
		version: 13,
		statements: [
			// Chat.photoId: a group's or channel's photo file_id; cached chats
			// get it with the server's next copy.
			"ALTER TABLE chats ADD COLUMN photo_id TEXT NOT NULL DEFAULT ''",
		],
	},
	{
		version: 14,
		statements: [
			// UploadQueue.pause: a paused upload keeps its stored parts and
			// does not restart with the queue until it is resumed.
			"ALTER TABLE uploads ADD COLUMN paused INTEGER NOT NULL DEFAULT 0",
		],
	},
];

export const SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

export type MigrationOutcome = "ready" | "reset_required";

/**
 * Brings the database to SCHEMA_VERSION, one atomic batch per migration.
 * Returns "reset_required" when the file comes from a newer build; the caller
 * then destroys it and starts over.
 */
export async function migrate(driver: SqlDriver): Promise<MigrationOutcome> {
	const rows = await driver.query("PRAGMA user_version");
	const current = Number(rows[0]?.user_version ?? 0);
	if (current > SCHEMA_VERSION) return "reset_required";
	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;
		const statements: SqlStatement[] = migration.statements.map((sql) => ({ sql }));
		statements.push({ sql: `PRAGMA user_version = ${migration.version}` });
		await driver.batch(statements);
	}
	return "ready";
}

// Local schema, shared by web, mobile and desktop through SqlDriver (ADR 0009).
// Migrations are TypeScript rather than .sql files so every bundler and the
// Node test runner load them the same way. Versions only grow; a database
// from a newer build is reset and synced again (the server is the source of
// truth).
import type { SqlDriver, SqlStatement } from "@app/platform";
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

// SqlDriver over node:sqlite for tests. Databases live in memory and survive
// close() (like files on disk) until destroy(), so a test can "restart" the
// app on the same data.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDriver, SqlDriverFactory, SqlParams, SqlRow, SqlStatement } from "@achoo254/chat-platform";

class NodeSqlDriver implements SqlDriver {
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;

	constructor(
		private readonly db: DatabaseSync,
		private readonly onDestroy: () => void,
	) {}

	private prepare(sql: string): StatementSync {
		if (this.closed) throw new Error("database is closed");
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	async query(sql: string, params: SqlParams = []): Promise<SqlRow[]> {
		return this.prepare(sql).all(...params) as SqlRow[];
	}

	async batch(statements: readonly SqlStatement[]): Promise<void> {
		if (this.closed) throw new Error("database is closed");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const statement of statements) this.prepare(statement.sql).run(...(statement.params ?? []));
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async destroy(): Promise<void> {
		this.closed = true;
		this.onDestroy();
	}
}

export class MemorySqlFactory implements SqlDriverFactory {
	readonly files = new Map<string, DatabaseSync>();

	async open(name: string): Promise<SqlDriver> {
		let db = this.files.get(name);
		if (db === undefined) {
			db = new DatabaseSync(":memory:");
			this.files.set(name, db);
		}
		const file = db;
		return new NodeSqlDriver(file, () => {
			file.close();
			this.files.delete(name);
		});
	}

	/** Raw access for assertions. */
	db(name: string): DatabaseSync {
		const db = this.files.get(name);
		if (db === undefined) throw new Error(`no database ${name}`);
		return db;
	}
}

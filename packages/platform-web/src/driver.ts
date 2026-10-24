// SqlDriver over the official SQLite WebAssembly build. In the browser the
// database lives in OPFS through the "opfs-sahpool" VFS, which needs no
// COOP/COEP headers but allows one connection per pool: only the leader
// tab's worker opens it (see leader.ts). The same driver runs on an
// in-memory database in Node for tests.
import sqlite3InitModule, { type Database, type SqlValue as WasmValue } from "@sqlite.org/sqlite-wasm";
import type { SqlDriver, SqlDriverFactory, SqlParams, SqlRow, SqlStatement, SqlValue } from "@achoo254/chat-platform";

function toSqlValue(value: WasmValue): SqlValue {
	if (value === null || typeof value === "string" || typeof value === "number") return value;
	if (typeof value === "bigint") {
		// Ids stay below 2^53 (ADR 0001); a larger integer means a corrupt row.
		if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
			throw new RangeError(`integer ${value} does not fit a JavaScript number`);
		}
		return Number(value);
	}
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bindings(params: SqlParams): { bind?: SqlValue[] } {
	return params.length === 0 ? {} : { bind: [...params] };
}

export class WasmSqlDriver implements SqlDriver {
	private closed = false;

	constructor(
		private readonly db: Database,
		private readonly removeFiles: () => void,
	) {}

	private check(): void {
		if (this.closed) throw new Error("database is closed");
	}

	async query(sql: string, params: SqlParams = []): Promise<SqlRow[]> {
		this.check();
		const rows = this.db.exec({ sql, ...bindings(params), rowMode: "object", returnValue: "resultRows" });
		return rows.map((row) => {
			const out: Record<string, SqlValue> = {};
			for (const [key, value] of Object.entries(row)) out[key] = toSqlValue(value);
			return out;
		});
	}

	async batch(statements: readonly SqlStatement[]): Promise<void> {
		this.check();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const statement of statements) {
				this.db.exec({ sql: statement.sql, ...bindings(statement.params ?? []) });
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	async destroy(): Promise<void> {
		await this.close();
		this.removeFiles();
	}
}

export interface SahpoolOptions {
	/** OPFS directory of the pool; one per app so other apps on the origin are untouched. */
	readonly directory?: string;
	readonly vfsName?: string;
}

/**
 * Opens the opfs-sahpool VFS (must run in a dedicated worker) and returns a
 * factory for databases inside it.
 */
export async function openSahpoolFactory(options: SahpoolOptions = {}): Promise<SqlDriverFactory> {
	const sqlite3 = await sqlite3InitModule();
	const pool = await sqlite3.installOpfsSAHPoolVfs({
		name: options.vfsName ?? "chat-sahpool",
		directory: options.directory ?? "/chat-db",
		initialCapacity: 6,
	});
	return {
		open: async (name) => {
			const path = `/${name}`;
			return new WasmSqlDriver(new pool.OpfsSAHPoolDb(path), () => {
				pool.unlink(path);
			});
		},
	};
}

/** In-memory databases of the same build (Node tests, or a browser without OPFS). */
export async function openMemoryFactory(): Promise<SqlDriverFactory> {
	const sqlite3 = await sqlite3InitModule();
	return {
		open: async () => new WasmSqlDriver(new sqlite3.oo1.DB(":memory:"), () => undefined),
	};
}

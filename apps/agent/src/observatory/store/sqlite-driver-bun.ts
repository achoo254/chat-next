// bun:sqlite behind the Observatory connection interface (sqlite-driver.ts):
// the driver of the released tunelo, a Bun executable. Only ever loaded
// under Bun (the import below would fail under Node).
import type { Database, Statement } from "bun:sqlite";
import type { SqlRow, SqlValue, SqliteConnection, SqliteOpenMode } from "./sqlite-driver.ts";

class BunSqliteConnection implements SqliteConnection {
  readonly runtime = "bun";
  private readonly statements = new Map<string, Statement>();
  private closed = false;

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): number {
    return this.statement(sql).run(...params).changes;
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.statement(sql).all(...params);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A statement left open would keep the file (and its -wal) open after
    // close, which on Windows stops them being deleted.
    for (const st of this.statements.values()) st.finalize();
    this.statements.clear();
    this.db.close(true);
  }
}

export async function openBunSqlite(path: string, mode: SqliteOpenMode): Promise<SqliteConnection> {
  const { Database } = await import("bun:sqlite");
  return new BunSqliteConnection(new Database(path, mode === "readonly" ? { readonly: true } : { create: true, readwrite: true }));
}

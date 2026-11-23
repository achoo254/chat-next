// node:sqlite behind the Observatory connection interface (sqlite-driver.ts):
// the driver under Node, which runs the tests and development builds.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SqlRow, SqlValue, SqliteConnection, SqliteOpenMode } from "./sqlite-driver.ts";

class NodeSqliteConnection implements SqliteConnection {
  readonly runtime = "node";
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(private readonly db: DatabaseSync) {}

  private statement(sql: string): StatementSync {
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
    return Number(this.statement(sql).run(...params).changes);
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    return this.statement(sql).all(...params);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Closing the database finalizes its statements.
    this.statements.clear();
    this.db.close();
  }
}

export async function openNodeSqlite(path: string, mode: SqliteOpenMode): Promise<SqliteConnection> {
  const { DatabaseSync } = await import("node:sqlite");
  return new NodeSqliteConnection(new DatabaseSync(path, { readOnly: mode === "readonly" }));
}

// The part of bun:sqlite that sqlite-driver-bun.ts uses. The agent has no
// bun-types dependency (Node runs its tests and typecheck); this declares
// only the calls made, with Bun's own names and signatures.
declare module "bun:sqlite" {
  type BunSqlValue = string | number | bigint | boolean | null | Uint8Array;

  export class Statement {
    all(...params: BunSqlValue[]): Record<string, unknown>[];
    run(...params: BunSqlValue[]): { changes: number; lastInsertRowid: number | bigint };
    finalize(): void;
  }

  export class Database {
    constructor(filename: string, options?: { create?: boolean; readwrite?: boolean; readonly?: boolean; strict?: boolean });
    prepare(sql: string): Statement;
    exec(sql: string): unknown;
    close(throwOnError?: boolean): void;
  }
}

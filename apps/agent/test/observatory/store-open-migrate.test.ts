// Opening the Observatory database: schema v1 from an empty file, the
// tables matching what the code reads and writes, WAL, private files, and a
// database from a newer agent refused without a byte written.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../src/observatory/store/migrate.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { API_REQUESTS, CONTENT_SETTINGS, DAILY_ROLLUPS, GIT_OPS, INSTRUCTIONS_LOADED, PROMPTS, SESSIONS, SUBAGENTS, TOOL_CALLS } from "../../src/observatory/store/observatory-table-specs.ts";
import { OBSERVATORY_TABLES } from "../../src/observatory/store/schema-v1.ts";
import { openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import { ObservatorySchemaTooNew, ObservatoryStoreClosed } from "../../src/observatory/store/store-errors.ts";
import { sessionOps, tempDbPath } from "./store-fixture.ts";

// POSIX file modes are not enforced on Windows.
const posix = process.platform !== "win32";

describe("ObservatoryStore.open", () => {
  it("creates schema v1 from nothing, with WAL, under the Node driver in tests", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    expect(store.runtime).toBe("node");
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    store.close();

    const db = await openSqlite(path);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual([...OBSERVATORY_TABLES].sort());
    expect(db.all("PRAGMA journal_mode")[0]?.journal_mode).toBe("wal");
    db.close();
  });

  it("has every column the code maps, and no other", async () => {
    const path = tempDbPath();
    (await ObservatoryStore.open({ path })).close();
    const db = await openSqlite(path);
    const synthetic: Record<string, string[]> = { git_ops: ["id"] };
    for (const spec of [SESSIONS, PROMPTS, TOOL_CALLS, SUBAGENTS, API_REQUESTS, INSTRUCTIONS_LOADED, GIT_OPS, CONTENT_SETTINGS, DAILY_ROLLUPS]) {
      const columns = db.all(`PRAGMA table_info(${spec.table})`).map((r) => String(r.name));
      expect(columns.sort(), spec.table).toEqual([...spec.columns.map((c) => c.column), ...(synthetic[spec.table] ?? [])].sort());
    }
    db.close();
  });

  it("opens an existing database again without migrating it twice or losing rows", async () => {
    const path = tempDbPath();
    const first = await ObservatoryStore.open({ path });
    first.write(sessionOps("s1", Date.now()));
    first.close();
    const again = await ObservatoryStore.open({ path });
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    expect(again.sessionTimeline("s1").toolCalls).toHaveLength(2);
    again.close();
  });

  it("refuses a database of a newer schema that this agent may not read, and writes nothing to it", async () => {
    const path = tempDbPath();
    (await ObservatoryStore.open({ path })).close();
    const db = await openSqlite(path);
    db.exec("PRAGMA journal_mode = DELETE");
    db.run("UPDATE meta SET value = ? WHERE key = 'min_reader_version'", [String(SCHEMA_VERSION + 1)]);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const before = readFileSync(path);

    const err = await ObservatoryStore.open({ path }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservatorySchemaTooNew);
    expect(err).toMatchObject({ found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION, path });
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it("refuses a newer database it may not read whose last commits are still in its -wal, changing no byte of either file", async () => {
    // A newer agent that was killed: its schema version, minimum reader and a row only in the -wal.
    const source = tempDbPath();
    (await ObservatoryStore.open({ path: source })).close();
    const newer = await openSqlite(source);
    newer.exec("PRAGMA wal_autocheckpoint = 0");
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.run("UPDATE meta SET value = ? WHERE key = 'min_reader_version'", [String(SCHEMA_VERSION + 1)]);
    newer.exec("INSERT INTO content_settings VALUES ('k', 1, 1)");
    // Copy the files while the newer agent still has them open: as a crash leaves them.
    const path = join(dirname(tempDbPath()), "copy", "observatory.db");
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
    copyFileSync(`${source}-wal`, `${path}-wal`);
    newer.close();
    const main = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    expect(wal.length).toBeGreaterThan(0);

    const err = await ObservatoryStore.open({ path }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservatorySchemaTooNew);
    expect(err).toMatchObject({ found: SCHEMA_VERSION + 1 });
    expect(readFileSync(path).equals(main)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
  });

  it("throws a typed error once closed", async () => {
    const store = await ObservatoryStore.open({ path: tempDbPath() });
    store.close();
    store.close();
    expect(() => store.sessions()).toThrow(ObservatoryStoreClosed);
    expect(() => store.write(sessionOps("s", 1))).toThrow(ObservatoryStoreClosed);
  });

  it.skipIf(!posix)("keeps the folder 0700 and the database with its -wal and -shm 0600", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    store.write(sessionOps("s1", Date.now()));
    expect(statSync(path.replace(/[\\/]observatory\.db$/, "")).mode & 0o777).toBe(0o700);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(f).mode & 0o777, f).toBe(0o600);
    store.close();
  });

  it.skipIf(!posix)("makes an existing folder and database private again", async () => {
    const path = tempDbPath();
    (await ObservatoryStore.open({ path })).close();
    chmodSync(dirname(path), 0o755);
    chmodSync(path, 0o644);
    (await ObservatoryStore.open({ path })).close();
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

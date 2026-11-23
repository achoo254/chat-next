// A database written by a newer agent: this agent opens it as it is when the
// newer one still lets it read (meta.min_reader_version), writes only what
// it knows, leaves the rest alone, and refuses the database otherwise.
import { describe, expect, it } from "vitest";
import { MIN_READER_VERSION, SCHEMA_VERSION } from "../../src/observatory/store/migrate.ts";
import { NEWER_DB_EXPORT_NOTE } from "../../src/observatory/store/observatory-export.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { OBSERVATORY_TABLES } from "../../src/observatory/store/schema-tables.ts";
import { openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import { ObservatorySchemaTooNew } from "../../src/observatory/store/store-errors.ts";
import { DAY, sessionOps, tempDbPath } from "./store-fixture.ts";

const NEWER = SCHEMA_VERSION + 1;

/** A database this agent made, then changed as a newer agent's additive migration would: a new column, a new table, a higher version. */
async function newerDb(minReader: number | undefined): Promise<string> {
  const path = tempDbPath();
  const store = await ObservatoryStore.open({ path });
  store.write(sessionOps("old", Date.now() - 200 * DAY));
  store.close();
  const db = await openSqlite(path);
  db.exec("ALTER TABLE tool_calls ADD COLUMN future_lane TEXT");
  db.exec("UPDATE tool_calls SET future_lane = 'TERMINAL'");
  db.exec("CREATE TABLE future_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL)");
  db.run("INSERT INTO future_events VALUES (?, ?, ?)", ["e1", "old", Date.now() - 200 * DAY]);
  if (minReader === undefined) db.exec("DROP TABLE meta");
  else db.run("UPDATE meta SET value = ? WHERE key = 'min_reader_version'", [String(minReader)]);
  db.exec(`PRAGMA user_version = ${NEWER}`);
  db.close();
  return path;
}

describe("the minimum reader version", () => {
  it("is recorded in meta when a database is made", async () => {
    const path = tempDbPath();
    (await ObservatoryStore.open({ path })).close();
    const db = await openSqlite(path);
    expect(db.all("SELECT key, value FROM meta")).toEqual([{ key: "min_reader_version", value: String(MIN_READER_VERSION) }]);
    db.close();
  });

  it("is added to a development database made before meta existed, rows kept", async () => {
    const path = tempDbPath();
    const first = await ObservatoryStore.open({ path });
    first.write(sessionOps("s1", Date.now()));
    first.close();
    const raw = await openSqlite(path);
    raw.exec("DROP TABLE meta");
    raw.close();

    const again = await ObservatoryStore.open({ path });
    expect(again.newerThanAgent).toBe(false);
    expect(again.sessionTimeline("s1").toolCalls).toHaveLength(2);
    again.close();
    const db = await openSqlite(path);
    expect(db.all("SELECT value FROM meta WHERE key = 'min_reader_version'")).toEqual([{ value: String(MIN_READER_VERSION) }]);
    db.close();
  });

  it("is never lowered by an older agent", async () => {
    const path = tempDbPath();
    (await ObservatoryStore.open({ path })).close();
    const raw = await openSqlite(path);
    raw.run("UPDATE meta SET value = ? WHERE key = 'min_reader_version'", [String(SCHEMA_VERSION)]);
    raw.close();
    (await ObservatoryStore.open({ path })).close();
    const db = await openSqlite(path);
    expect(db.all("SELECT value FROM meta")).toEqual([{ value: String(SCHEMA_VERSION) }]);
    db.close();
  });
});

describe("a database a newer agent wrote, readable by this one", () => {
  it("opens without migrating or lowering its version", async () => {
    const path = await newerDb(SCHEMA_VERSION);
    const store = await ObservatoryStore.open({ path });
    expect(store.newerThanAgent).toBe(true);
    expect(store.schemaVersion).toBe(NEWER);
    store.close();
    const db = await openSqlite(path);
    expect(db.all("PRAGMA user_version")[0]?.user_version).toBe(NEWER);
    db.close();
  });

  it("takes this agent's writes, the new column NULL on new rows and kept on old ones", async () => {
    const path = await newerDb(SCHEMA_VERSION);
    const store = await ObservatoryStore.open({ path });
    const now = Date.now();
    store.write(sessionOps("new", now));
    // An upsert of an existing row changes only the columns this agent names.
    store.write([{ kind: "toolCall", row: { toolUseId: "old-t1", sessionId: "old", at: now - 200 * DAY + 2, toolName: "Bash", durationMs: 999, success: true } }]);
    expect(store.sessionTimeline("new").toolCalls).toHaveLength(2);
    store.close();

    const db = await openSqlite(path);
    expect(db.all("SELECT future_lane FROM tool_calls WHERE session_id = 'new'")).toEqual([{ future_lane: null }, { future_lane: null }]);
    expect(db.all("SELECT future_lane, duration_ms FROM tool_calls WHERE tool_use_id = 'old-t1'")).toEqual([{ future_lane: "TERMINAL", duration_ms: 999 }]);
    db.close();
  });

  it("prunes only the tables it knows: a table it does not know keeps its rows", async () => {
    const path = await newerDb(SCHEMA_VERSION);
    const store = await ObservatoryStore.open({ path });
    store.prune(Date.now());
    expect(store.sessionTimeline("old").toolCalls).toHaveLength(0);
    store.close();
    const db = await openSqlite(path);
    expect(db.all("SELECT id FROM future_events")).toEqual([{ id: "e1" }]);
    db.close();
  });

  it("exports the tables it knows, with a note that others are left out", async () => {
    const path = await newerDb(SCHEMA_VERSION);
    const store = await ObservatoryStore.open({ path });
    let text = "";
    await store.exportTo(async (chunk) => {
      text += chunk;
    });
    store.close();
    const out = JSON.parse(text) as { schemaVersion: number; note?: string; tables: Record<string, unknown[]> };
    expect(out.schemaVersion).toBe(NEWER);
    expect(out.note).toBe(NEWER_DB_EXPORT_NOTE);
    expect(Object.keys(out.tables)).toEqual([...OBSERVATORY_TABLES]);
  });

  it("is deleted whole by wipe", async () => {
    const path = await newerDb(SCHEMA_VERSION);
    const store = await ObservatoryStore.open({ path });
    await store.wipe();
    const fresh = await ObservatoryStore.open({ path });
    expect(fresh.newerThanAgent).toBe(false);
    expect(fresh.schemaVersion).toBe(SCHEMA_VERSION);
    fresh.close();
  });
});

describe("a database a newer agent wrote, not readable by this one", () => {
  it("is refused when its minimum reader is above this agent", async () => {
    const path = await newerDb(NEWER);
    const err = await ObservatoryStore.open({ path }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservatorySchemaTooNew);
    expect(err).toMatchObject({ found: NEWER, supported: SCHEMA_VERSION, minReader: NEWER });
  });

  it("is refused when it records no minimum reader", async () => {
    const path = await newerDb(undefined);
    const err = await ObservatoryStore.open({ path }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservatorySchemaTooNew);
    expect(err).toMatchObject({ found: NEWER, minReader: undefined });
  });
});

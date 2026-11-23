// Schema version 2: a version 1 database moves up keeping its rows, in one
// transaction; an older agent can still use a version 2 database (it only
// adds); a tool call's exact station wins over an estimated one in either
// order; session events and bottleneck findings are stored, kept 90 days,
// exported and wiped; a call stored without a station is read with an
// estimated one.
import { describe, expect, it } from "vitest";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import { MIN_READER_VERSION, SCHEMA_VERSION, minReaderVersionOf, schemaVersionOf } from "../../src/observatory/store/migrate.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { TOOL_CALLS, type TableSpec } from "../../src/observatory/store/observatory-table-specs.ts";
import type { ToolCallRow } from "../../src/observatory/store/observatory-rows.ts";
import { encodeRow, writeSql } from "../../src/observatory/store/row-codec.ts";
import { OBSERVATORY_TABLES } from "../../src/observatory/store/schema-tables.ts";
import { META_TABLE, SCHEMA_V1 } from "../../src/observatory/store/schema-v1.ts";
import { type SqliteConnection, openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { DAY, sessionOps, tempDbPath } from "./store-fixture.ts";

const EST = StationFlag.estimated;

/** A database exactly as an agent of version 1 leaves it, with one session's rows. */
async function versionOneDb(): Promise<string> {
  const path = tempDbPath();
  const store = await ObservatoryStore.open({ path });
  store.close();
  // Rebuilt from the version 1 statements alone, in the same file.
  const db = await openSqlite(path);
  for (const t of OBSERVATORY_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  for (const sql of SCHEMA_V1) db.exec(sql);
  db.exec(META_TABLE);
  db.run("INSERT INTO meta (key, value) VALUES ('min_reader_version', '1')");
  db.exec("PRAGMA user_version = 1");
  const at = Date.now();
  db.run("INSERT INTO sessions (session_id, project_key, source, started_at) VALUES ('s1', 'github.com/acme/app', 'cli', ?)", [at]);
  db.run("INSERT INTO tool_calls (tool_use_id, session_id, at, tool_name, office_room, target, success) VALUES ('t1', 's1', ?, 'Bash', 'qa', 'vitest', 1)", [at + 1]);
  db.run("INSERT INTO prompts (prompt_id, session_id, at, excerpt) VALUES ('p1', 's1', ?, 'fix it')", [at]);
  db.close();
  return path;
}

const columnsOf = (db: SqliteConnection, table: string): { name: unknown; notnull: unknown; pk: unknown; type: unknown }[] =>
  db.all(`PRAGMA table_info(${table})`).map((c) => ({ name: c.name, notnull: c.notnull, pk: c.pk, type: c.type }));

describe("the migration from version 1", () => {
  it("adds the columns, tables and indexes and keeps every row", async () => {
    const path = await versionOneDb();
    const store = await ObservatoryStore.open({ path });
    expect(store.schemaVersion).toBe(2);
    const t = store.sessionTimeline("s1");
    expect(t.prompts.map((p) => p.excerpt)).toEqual(["fix it"]);
    // The old row: its office room kept, its station read from its target, estimated.
    expect(t.toolCalls).toMatchObject([{ toolUseId: "t1", officeRoom: "qa", station: "TESTING", stationFlags: EST, targetKey: null }]);
    expect(t.sessionEvents).toEqual([]);
    store.close();
    const db = await openSqlite(path);
    const indexes = db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["tool_calls_tool", "sessions_project", "session_events_session", "session_events_at", "bottlenecks_key", "bottlenecks_session", "bottlenecks_opened_at"]),
    );
    expect(minReaderVersionOf(db)).toBe(1);
    db.close();
  });

  it("changes nothing when one of its statements fails: one transaction", async () => {
    const path = await versionOneDb();
    const raw = await openSqlite(path);
    // A table in the way of the migration's CREATE TABLE.
    raw.exec("CREATE TABLE bottlenecks (x TEXT)");
    raw.close();
    await expect(ObservatoryStore.open({ path })).rejects.toThrow();
    const db = await openSqlite(path);
    expect(schemaVersionOf(db)).toBe(1);
    expect(columnsOf(db, "tool_calls").map((c) => c.name)).not.toContain("station");
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'session_events'")).toEqual([]);
    expect(db.all("SELECT tool_use_id FROM tool_calls")).toEqual([{ tool_use_id: "t1" }]);
    db.close();
  });
});

describe("a version 2 database used by an agent of version 1", () => {
  it("is open to it by the minimum reader rule, and takes its writes as version 1 wrote them", async () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(MIN_READER_VERSION).toBe(1);
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    store.write(sessionOps("s2", Date.now()));
    store.write([{ kind: "toolCall", row: { toolUseId: "s2-t1", sessionId: "s2", at: 1, station: "SANDBOX", stationFlags: 0, targetKey: "k".repeat(32) } }]);
    store.close();

    // What version 1 knew of each table, from its own statements.
    const v1 = await openSqlite(":memory:");
    for (const sql of SCHEMA_V1) v1.exec(sql);
    const db = await openSqlite(path);
    // An agent of version 1 opens it: newer, and its minimum reader is not above 1.
    expect(schemaVersionOf(db)).toBeGreaterThan(1);
    expect(minReaderVersionOf(db)).toBeLessThanOrEqual(1);
    for (const table of ["sessions", "prompts", "tool_calls", "subagents", "api_requests", "instructions_loaded", "git_ops", "content_settings", "daily_rollups"]) {
      const now = columnsOf(db, table);
      const before = columnsOf(v1, table);
      // Every column version 1 knew is there as it was; every added one may be NULL.
      expect(now.filter((c) => before.some((b) => b.name === c.name)), table).toEqual(before);
      for (const added of now.filter((c) => !before.some((b) => b.name === c.name))) expect(added.notnull, `${table}.${String(added.name)}`).toBe(0);
    }
    // Its upsert names only the columns it knows: the stored station stays, a new row leaves it NULL.
    const known = new Set(columnsOf(v1, "tool_calls").map((c) => c.name));
    const v1Spec: TableSpec<ToolCallRow> = { ...TOOL_CALLS, columns: TOOL_CALLS.columns.filter((c) => known.has(c.column)) };
    db.run(writeSql(v1Spec), encodeRow(v1Spec, { toolUseId: "s2-t1", sessionId: "s2", at: 1, durationMs: 55 }));
    db.run(writeSql(v1Spec), encodeRow(v1Spec, { toolUseId: "v1-new", sessionId: "s2", at: 2, toolName: "Read" }));
    expect(db.all("SELECT tool_use_id, station, target_key, duration_ms FROM tool_calls WHERE tool_use_id IN ('s2-t1', 'v1-new') ORDER BY tool_use_id")).toEqual([
      { tool_use_id: "s2-t1", station: "SANDBOX", target_key: "k".repeat(32), duration_ms: 55 },
      { tool_use_id: "v1-new", station: null, target_key: null, duration_ms: null },
    ]);
    db.close();
    v1.close();
  });
});

describe("a tool call's station", () => {
  const exact: WriteOp = { kind: "toolCall", row: { toolUseId: "t", sessionId: "s", at: 10, toolName: "Bash", station: "GIT", stationFlags: StationFlag.push } };
  const estimated: WriteOp = { kind: "toolCall", row: { toolUseId: "t", sessionId: "s", at: 11, toolName: "Bash", station: "SANDBOX", stationFlags: EST, durationMs: 9 } };
  const later: WriteOp = { kind: "toolCall", row: { toolUseId: "t", sessionId: "s", at: 12, durationMs: 9 } };

  it("is the exact one whichever arrives first, an estimate never replacing it", async () => {
    for (const order of [
      [exact, estimated, later],
      [estimated, exact, later],
      [estimated, later, exact],
    ]) {
      const store = await ObservatoryStore.open({ path: tempDbPath() });
      for (const op of order) store.write([op]);
      expect(store.sessionTimeline("s").toolCalls).toMatchObject([{ station: "GIT", stationFlags: StationFlag.push, durationMs: 9 }]);
      store.close();
    }
  });

  it("is the first estimate when no exact one comes, and a later exact one replaces it", async () => {
    const store = await ObservatoryStore.open({ path: tempDbPath() });
    store.write([estimated, { kind: "toolCall", row: { toolUseId: "t", sessionId: "s", at: 13, station: "FILES", stationFlags: EST } }]);
    expect(store.sessionTimeline("s").toolCalls).toMatchObject([{ station: "SANDBOX", stationFlags: EST }]);
    store.write([{ kind: "toolCall", row: { toolUseId: "t", sessionId: "s", at: 14, station: "TESTING", stationFlags: 0 } }]);
    expect(store.sessionTimeline("s").toolCalls).toMatchObject([{ station: "TESTING", stationFlags: 0 }]);
    store.close();
  });
});

describe("session events and bottleneck findings", () => {
  const event = (key: string, at: number, label: string): WriteOp => ({ kind: "sessionEvent", row: { dedupeKey: key, sessionId: "s1", at, kind: "stop_failure", label, number: 1, flag: false } });

  it("keep one row of an event read twice: its earliest time, its first values", async () => {
    const store = await ObservatoryStore.open({ path: tempDbPath() });
    store.write([event("k1", 5, "first"), event("k1", 3, "second"), event("k2", 4, "other")]);
    expect(store.sessionTimeline("s1").sessionEvents.map((e) => [e.dedupeKey, e.at, e.label, e.flag])).toEqual([
      ["k1", 3, "first", false],
      ["k2", 4, "other", false],
    ]);
    store.close();
  });

  it("keep one finding per session, rule and subkey, written whole: reopened, it has no closing time", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    const finding = (status: "open" | "closed", severity: "warn" | "alert", at: number, closedAt?: number): WriteOp => ({
      kind: "bottleneck",
      row: { sessionId: "s1", rule: "repeat_read", subkey: "f".repeat(32), station: "FILES", severity, status, openedAt: 100, updatedAt: at, closedAt, value: 3, threshold: 3, n: 3, evidenceJson: '{"ids":["t1"]}' },
    });
    store.write([finding("open", "warn", 100), finding("open", "alert", 200), finding("closed", "alert", 300, 300)]);
    store.write([finding("open", "warn", 400)]);
    store.close();
    const db = await openSqlite(path);
    expect(db.all("SELECT id, severity, status, updated_at, closed_at FROM bottlenecks")).toEqual([{ id: 1, severity: "warn", status: "open", updated_at: 400, closed_at: null }]);
    expect(() => db.run("INSERT INTO bottlenecks (session_id, rule, subkey, severity, status, opened_at, updated_at) VALUES ('s', 'r', '', 'red', 'open', 1, 1)")).toThrow();
    db.close();
  });

  it("are kept 90 days, keep their session meanwhile, and are exported and wiped with the rest", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    const old = Date.now() - 100 * DAY;
    store.write([
      { kind: "session", row: { sessionId: "s1", source: "cli", startedAt: old } },
      event("old", old, "x"),
      event("new", Date.now(), "y"),
      { kind: "bottleneck", row: { sessionId: "s1", rule: "context_high", subkey: "", severity: "warn", status: "closed", openedAt: old, updatedAt: old } },
    ]);
    const first = store.prune(Date.now(), undefined, "UTC");
    expect(first.deleted).toMatchObject({ session_events: 1, bottlenecks: 1, sessions: 0 });
    expect(store.sessionTimeline("s1").sessionEvents.map((e) => e.dedupeKey)).toEqual(["new"]);
    let text = "";
    await store.exportTo(async (chunk) => void (text += chunk));
    const out = JSON.parse(text) as { tables: Record<string, Record<string, unknown>[]> };
    expect(Object.keys(out.tables)).toEqual([...OBSERVATORY_TABLES]);
    expect(out.tables.session_events).toMatchObject([{ dedupe_key: "new", kind: "stop_failure", label: "y" }]);
    expect(out.tables.bottlenecks).toEqual([]);
    await store.wipe();
    const fresh = await ObservatoryStore.open({ path });
    expect(fresh.sessionTimeline("s1").sessionEvents).toEqual([]);
    fresh.close();
  });
});

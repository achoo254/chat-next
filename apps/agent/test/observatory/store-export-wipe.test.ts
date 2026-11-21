// Export (every stored row and nothing else, written page by page to a sink
// or a file) and wipe (the database with its -wal and -shm gone; refused
// with a typed error, store still usable, while another program holds it on
// Windows).
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteObservatoryDb } from "../../src/observatory/store/observatory-db-files.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { OBSERVATORY_TABLES } from "../../src/observatory/store/schema-v1.ts";
import { openSqlite } from "../../src/observatory/store/sqlite-driver.ts";
import { ObservatoryStoreClosed, ObservatoryStoreError, ObservatoryWipeFailed } from "../../src/observatory/store/store-errors.ts";
import { tempDir } from "../harness.ts";
import { openTempStore, sessionOps, tempDbPath } from "./store-fixture.ts";

const T = Date.UTC(2026, 10, 21, 3);
const windows = process.platform === "win32";

type Exported = { schemaVersion: number; tables: Record<string, Record<string, unknown>[]> };

describe("ObservatoryStore export", () => {
  it("writes every table with its rows as stored, in pages, as one JSON document", async () => {
    const store = await openTempStore();
    store.write(sessionOps("s1", T));
    for (let i = 0; i < 5; i++) store.write([{ kind: "prompt", row: { promptId: `x${i}`, sessionId: "s1", at: T + 100 + i } }]);
    const chunks: string[] = [];
    const summary = await store.exportTo(async (c) => void chunks.push(c), 2);
    store.close();

    const out = JSON.parse(chunks.join("")) as Exported;
    expect(summary.rows).toBe(13);
    expect(Object.keys(out)).toEqual(["schemaVersion", "tables"]);
    expect(out.schemaVersion).toBe(1);
    expect(Object.keys(out.tables)).toEqual([...OBSERVATORY_TABLES]);
    expect(out.tables.sessions).toEqual([
      {
        session_id: "s1",
        previous_session_id: null,
        previous_session_inferred: null,
        project_key: "github.com/acme/app",
        cwd: "~/work/app",
        source: "terminal",
        internal_label: null,
        started_at: T,
        ended_at: null,
        main_model: "claude-opus",
      },
    ]);
    expect(out.tables.prompts?.map((r) => r.prompt_id)).toEqual(["s1-p1", "x0", "x1", "x2", "x3", "x4"]);
    expect(out.tables.tool_calls?.map((r) => [r.tool_use_id, r.success])).toEqual([
      ["s1-t1", 1],
      ["s1-t2", 0],
    ]);
    expect(out.tables.git_ops?.[0]).toMatchObject({ id: 1, sha: "abc1234" });
    expect(out.tables.daily_rollups).toEqual([]);
    // Pages of 2 rows: the six prompts came in three pieces, not one.
    expect(chunks.filter((c) => c.includes('"prompt_id":"x')).length).toBe(3);
  });

  it("writes the export to a private file", async () => {
    const store = await openTempStore();
    store.write(sessionOps("s1", T));
    const file = join(tempDir("observatory-export-"), "export.json");
    await store.exportToFile(file);
    store.close();
    const out = JSON.parse(readFileSync(file, "utf8")) as Exported;
    expect(out.tables.api_requests).toHaveLength(1);
    if (!windows) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("stops, leaving no file and no temp file, when the store closes during the export", async () => {
    const store = await openTempStore();
    for (let i = 0; i < 10; i++) store.write([{ kind: "prompt", row: { promptId: `p${i}`, sessionId: "s", at: i } }]);
    const dir = tempDir("observatory-export-");
    const running = store.exportToFile(join(dir, "export.json"), { pageRows: 2 });
    store.close();
    await expect(running).rejects.toBeInstanceOf(ObservatoryStoreClosed);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses to replace an existing file unless asked, and a failed export leaves the user's file as it was", async () => {
    const store = await openTempStore();
    store.write(sessionOps("s1", T));
    const dir = tempDir("observatory-export-");
    const file = join(dir, "mine.json");
    writeFileSync(file, "the user's own notes");
    if (!windows) chmodSync(file, 0o644);

    await expect(store.exportToFile(file)).rejects.toBeInstanceOf(ObservatoryStoreError);
    expect(readFileSync(file, "utf8")).toBe("the user's own notes");

    const failing = store.exportToFile(file, { overwrite: true, pageRows: 1 });
    store.close();
    await expect(failing).rejects.toBeInstanceOf(ObservatoryStoreClosed);
    expect(readFileSync(file, "utf8")).toBe("the user's own notes");
    expect(readdirSync(dir)).toEqual(["mine.json"]);

    const again = await ObservatoryStore.open({ path: store.path });
    await again.exportToFile(file, { overwrite: true });
    again.close();
    expect((JSON.parse(readFileSync(file, "utf8")) as Exported).tables.sessions).toHaveLength(1);
    // The replacement is a new 0600 file, not the old file's mode.
    if (!windows) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["mine.json"]);
  });
});

describe("ObservatoryStore wipe", () => {
  it("closes the database and deletes it with its -wal and -shm", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    store.write(sessionOps("s1", T));
    // WAL mode: the log and shared memory exist while the database is open.
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(existsSync(`${path}-shm`)).toBe(true);

    await store.wipe();
    expect(readdirSync(dirname(path))).toEqual([]);
    expect(() => store.sessions()).toThrow(ObservatoryStoreClosed);

    const fresh = await ObservatoryStore.open({ path });
    expect(fresh.sessions()).toEqual([]);
    fresh.close();
  });

  it.runIf(windows)("throws a typed error and keeps the store working while another program has the database open", async () => {
    const path = tempDbPath();
    const store = await ObservatoryStore.open({ path });
    store.write(sessionOps("s1", T));
    const other = await openSqlite(path);
    other.all("SELECT count(*) FROM sessions");

    const err = await store.wipe().catch((e: unknown) => e);
    other.close();
    expect(err).toBeInstanceOf(ObservatoryWipeFailed);
    expect(store.sessions().map((s) => s.sessionId)).toEqual(["s1"]);
    store.write(sessionOps("s2", T + 1));
    expect(store.sessions()).toHaveLength(2);

    // With the other program gone, the wipe goes through.
    await store.wipe();
    expect(existsSync(path)).toBe(false);
  });

  it("deletes the files of a closed database, and does nothing when there are none", async () => {
    const path = tempDbPath();
    await deleteObservatoryDb(path);
    (await ObservatoryStore.open({ path })).close();
    await deleteObservatoryDb(path);
    expect(readdirSync(dirname(path))).toEqual([]);
  });
});

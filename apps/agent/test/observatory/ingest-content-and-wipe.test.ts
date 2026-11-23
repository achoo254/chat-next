// A project with content switched off keeps none in tool_calls: a failed
// call's text and a denial's reason are content, blocked and cleared with
// the rest, and `error` holds only a label. A session running across a wipe
// gets its row back before its next event, so its project's content stays
// blocked. A session that moves to another project keeps each content row
// under the project it was written in. And a database a development build
// wrote before version 1 settled still takes writes, its rows kept.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { ObservatoryIngest } from "../../src/observatory/ingest/observatory-ingest.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const PROJECT = "github.com/example/private-app";

async function service(): Promise<{ s: ObservatoryService; db: string }> {
  const dir = obsTempDir("ingest-content");
  const config = new ConfigStore(join(dir, "config"));
  const port = await pickFreePort();
  config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_393 }));
  const data = join(dir, "data");
  const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
  await s.start();
  stops.push(() => s.stop());
  return { s, db: join(data, "observatory.db") };
}

/** A record as an SDK callback hands it in (both passes done). */
const record = (event: string, at: number, f: Record<string, string | number | boolean>, c?: Record<string, string>): FilteredHookRecord => ({
  v: 1,
  src: "hook",
  event,
  at,
  f: { session_id: "sess-p", cwd: "~/work/private-app", project_key: PROJECT, ...f },
  ...(c ? { c } : {}),
});

async function readStore<T>(path: string, read: (store: ObservatoryStore) => T): Promise<T> {
  const store = await ObservatoryStore.open({ path });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

describe("a project with content switched off", () => {
  it("keeps no text of a failed call or a denial anywhere in tool_calls, stored before the switch or after", async () => {
    const { s, db } = await service();
    await s.accept(record("SessionStart", 1, { source: "startup" }), "sdk");
    await s.accept(record("PostToolUseFailure", 2, { tool_use_id: "t1", tool_name: "Read", duration_ms: 3 }, { tool_input: '{"file_path":"~/work/private-app/.notes"}', error: "DB_PASSWORD=hunter2-file-content" }), "sdk");
    await s.accept(record("PermissionDenied", 3, { tool_use_id: "t2", tool_name: "Read" }, { reason: "denied reading private-notes.md: contents hunter2" }), "sdk");
    await s.accept(record("PostToolUseFailure", 4, { tool_use_id: "t3", tool_name: "Bash", is_interrupt: true }, { error: "interrupted while printing hunter2" }), "sdk");
    await s.setProjectContent(PROJECT, false);
    // Late, after the switch: blocked by the store.
    await s.accept(record("PostToolUseFailure", 5, { tool_use_id: "t4", tool_name: "Read" }, { error: "late hunter2 text" }), "sdk");
    await s.stop();

    const calls = await readStore(db, (store) => store.sessionTimeline("sess-p").toolCalls);
    expect(calls.map((c) => [c.toolUseId, c.success, c.error, c.content])).toEqual([
      ["t1", false, "failed", null],
      ["t2", false, "permission denied", null],
      ["t3", false, "interrupted", null],
      ["t4", false, "failed", null],
    ]);
    const everything = JSON.stringify(calls);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("private-notes");
    expect(everything).not.toContain("DB_PASSWORD");
  });
});

describe("a session running across a wipe", () => {
  it("gets its sessions row again before its next event, so its project's content stays blocked", async () => {
    const { s, db } = await service();
    await s.setProjectContent(PROJECT, false);
    await s.accept(record("SessionStart", 1, { source: "startup" }), "sdk");
    await s.accept(record("UserPromptSubmit", 2, { prompt_id: "p1" }, { prompt: "before the wipe" }), "sdk");
    await s.wipe();
    await s.accept(record("UserPromptSubmit", 3, { prompt_id: "p2" }, { prompt: "after the wipe, project content off" }), "sdk");
    await s.stop();

    const t = await readStore(db, (store) => store.sessionTimeline("sess-p"));
    expect(t.session).toMatchObject({ sessionId: "sess-p", projectKey: PROJECT, source: "sdk" });
    expect(t.prompts).toEqual([expect.objectContaining({ promptId: "p2", excerpt: null })]);
  });
});

describe("a session that moves to another project", () => {
  const A = "github.com/example/project-a";
  const B = "github.com/example/project-b";
  /** The session starts in A, then a `cd` takes it to B: each record carries its own folder's project. */
  const inA = (event: string, at: number, f: Record<string, string | number | boolean>, c?: Record<string, string>): FilteredHookRecord => {
    const r = record(event, at, f, c);
    return { ...r, f: { ...r.f, cwd: "~/work/project-a", project_key: A } };
  };
  const inB = (event: string, at: number, f: Record<string, string | number | boolean>, c?: Record<string, string>): FilteredHookRecord => {
    const r = record(event, at, f, c);
    return { ...r, f: { ...r.f, cwd: "~/work/project-b", project_key: B } };
  };
  const records = (): FilteredHookRecord[] => [
    inA("SessionStart", 1, { source: "startup" }),
    inA("UserPromptSubmit", 2, { prompt_id: "pa" }, { prompt: "secret-in-A prompt" }),
    inA("PostToolUse", 3, { tool_use_id: "ta", tool_name: "Read", duration_ms: 1 }, { tool_input: "secret-in-A input", tool_response: "secret-in-A output" }),
    inB("UserPromptSubmit", 4, { prompt_id: "pb" }, { prompt: "kept-in-B prompt" }),
    inB("PostToolUse", 5, { tool_use_id: "tb", tool_name: "Read", duration_ms: 1 }, { tool_input: "kept-in-B input" }),
  ];

  it("loses the first project's content when that project is switched off, keeps the other's, and a record read again changes nothing", async () => {
    const { s, db } = await service();
    for (const r of records()) await s.accept(r, "sdk");
    await s.setProjectContent(A, false);
    // Read again (a spool line after a failed commit, a late copy): from both projects.
    await s.accept(inB("PostToolUse", 5, { tool_use_id: "tb", tool_name: "Read", duration_ms: 1 }, { tool_input: "kept-in-B input" }), "sdk");
    await s.accept(inA("UserPromptSubmit", 2, { prompt_id: "pa" }, { prompt: "secret-in-A prompt" }), "sdk");
    await s.accept(inA("PostToolUse", 3, { tool_use_id: "ta", tool_name: "Read", duration_ms: 1 }, { tool_input: "secret-in-A input" }), "sdk");
    await s.stop();

    const t = await readStore(db, (store) => store.sessionTimeline("sess-p"));
    // The session stays where it started.
    expect(t.session).toMatchObject({ projectKey: A, cwd: "~/work/project-a" });
    expect(t.prompts.map((p) => [p.promptId, p.projectKey, p.excerpt])).toEqual([
      ["pa", A, null],
      ["pb", B, "kept-in-B prompt"],
    ]);
    expect(t.toolCalls.map((c) => [c.toolUseId, c.projectKey, c.content])).toEqual([
      ["ta", A, null],
      ["tb", B, JSON.stringify({ input: "kept-in-B input" })],
    ]);
    expect(JSON.stringify(t)).not.toContain("secret-in-A");
  });

  it("gives each content row its own project whatever order the records come in", async () => {
    const stored = async (order: FilteredHookRecord[]): Promise<unknown> => {
      const store = await ObservatoryStore.open({ path: join(obsTempDir("ingest-order"), "observatory.db") });
      try {
        store.write([{ kind: "contentSetting", row: { projectKey: A, storeContent: false, updatedAt: 1 } }]);
        const ops: WriteOp[] = [];
        const ingest = new ObservatoryIngest({ push: (op) => ops.push(op), home: "~", log: () => undefined });
        for (const r of order) await ingest.accept(r, "spool");
        store.write(ops);
        const t = store.sessionTimeline("sess-p");
        return { prompts: t.prompts, toolCalls: t.toolCalls };
      } finally {
        store.close();
      }
    };
    const forward = await stored(records());
    expect(await stored([...records()].reverse())).toEqual(forward);
    expect(JSON.stringify(forward)).not.toContain("secret-in-A");
    expect(JSON.stringify(forward)).toContain("kept-in-B");
  });

  it("starting in B and moving into A, with a `cd` inside a single call each way, loses only what was written in A, in any order", async () => {
    const moved = (): FilteredHookRecord[] => [
      inB("SessionStart", 1, { source: "startup" }),
      inB("UserPromptSubmit", 2, { prompt_id: "pb" }, { prompt: "kept-in-B prompt" }),
      // `cd ../project-a && …`: the call starts in B and ends, with its content, in A.
      inB("PreToolUse", 3, { tool_use_id: "t3", tool_name: "Bash", target: "git" }),
      inA("PostToolUse", 4, { tool_use_id: "t3", tool_name: "Bash", target: "git", duration_ms: 1 }, { tool_input: "secret-in-A t3" }),
      // And back: starts in A, ends in B.
      inA("PreToolUse", 5, { tool_use_id: "t4", tool_name: "Bash", target: "git" }),
      inB("PostToolUse", 6, { tool_use_id: "t4", tool_name: "Bash", target: "git", duration_ms: 1 }, { tool_input: "kept-in-B t4" }),
    ];
    for (const order of [moved(), [...moved()].reverse()]) {
      const { s, db } = await service();
      for (const r of order) await s.accept(r, "sdk");
      await s.setProjectContent(A, false);
      await s.stop();
      const t = await readStore(db, (store) => store.sessionTimeline("sess-p"));
      expect(t.prompts.map((p) => [p.promptId, p.projectKey, p.excerpt])).toEqual([["pb", B, "kept-in-B prompt"]]);
      expect(t.toolCalls.map((c) => [c.toolUseId, c.projectKey, c.content])).toEqual([
        ["t3", A, null],
        ["t4", B, JSON.stringify({ input: "kept-in-B t4" })],
      ]);
      expect(JSON.stringify(t)).not.toContain("secret-in-A");
    }
  });
});

describe("content whose project cannot be told", () => {
  /** A write from a session not stored, with no project of its own (a hook that could not tell its folder's project). */
  const unknown = (excerpt: string): WriteOp[] => [
    { kind: "prompt", row: { promptId: "pu", sessionId: "sess-u", at: 1, excerpt } },
    { kind: "toolCall", row: { toolUseId: "tu", sessionId: "sess-u", at: 1, content: excerpt } },
  ];
  const contentOf = (store: ObservatoryStore): (string | null)[] => {
    const t = store.sessionTimeline("sess-u");
    return [t.prompts[0]?.excerpt ?? null, t.toolCalls[0]?.content ?? null];
  };
  const open = async (): Promise<ObservatoryStore> => ObservatoryStore.open({ path: join(obsTempDir("ingest-unknown"), "observatory.db") });

  it("is blocked while any project has content off, and a project given later brings nothing back", async () => {
    const store = await open();
    try {
      store.write([{ kind: "contentSetting", row: { projectKey: "github.com/example/off", storeContent: false, updatedAt: 1 } }]);
      store.write(unknown("unknown-project text"));
      expect(contentOf(store)).toEqual([null, null]);
      // The session's project is learnt later (one with content on): what was blocked stays out.
      store.write([{ kind: "session", row: { sessionId: "sess-u", source: "cli", startedAt: 1, projectKey: "github.com/example/on" } }]);
      expect(contentOf(store)).toEqual([null, null]);
    } finally {
      store.close();
    }
  });

  it("is kept while no project has content off, and cleared when one is switched off", async () => {
    const store = await open();
    try {
      store.write([{ kind: "contentSetting", row: { projectKey: "github.com/example/on", storeContent: true, updatedAt: 1 } }]);
      store.write(unknown("unknown-project text"));
      expect(contentOf(store)).toEqual(["unknown-project text", "unknown-project text"]);
      // It may be the project switched off: it goes with that project's content.
      expect(store.clearContent("github.com/example/off")).toEqual({ prompts: 1, toolCalls: 1 });
      expect(contentOf(store)).toEqual([null, null]);
    } finally {
      store.close();
    }
  });
});

describe("a database a development build wrote before version 1 settled", () => {
  it("is brought in line in place on open, keeps its rows, and takes writes", async () => {
    const path = join(obsTempDir("ingest-devdb"), "observatory.db");
    const first = await ObservatoryStore.open({ path });
    first.write([
      { kind: "toolCall", row: { toolUseId: "old", sessionId: "s", at: 1, toolName: "Bash", officeRoom: "server", content: "kept", durationMs: 7 } },
      { kind: "prompt", row: { promptId: "p-old", sessionId: "s", at: 1, excerpt: "kept too" } },
    ]);
    first.close();
    // As a development build left it: version 1, the room under its old name, no project on content rows.
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE tool_calls RENAME COLUMN office_room TO tool_kind");
    raw.exec("ALTER TABLE tool_calls DROP COLUMN project_key");
    raw.exec("ALTER TABLE prompts DROP COLUMN project_key");
    // …and without what version 2 added.
    for (const column of ["station", "station_flags", "target_key", "read_offset", "read_limit"]) raw.exec(`ALTER TABLE tool_calls DROP COLUMN ${column}`);
    for (const sql of ["DROP INDEX tool_calls_tool", "DROP INDEX sessions_project", "DROP TABLE session_events", "DROP TABLE bottlenecks", "PRAGMA user_version = 1"]) raw.exec(sql);
    raw.close();

    // Twice: the second open finds nothing to change.
    for (let open = 0; open < 2; open++) {
      const store = await ObservatoryStore.open({ path });
      try {
        expect(store.schemaVersion).toBe(2);
        store.write([{ kind: "toolCall", row: { toolUseId: `t${open}`, sessionId: "s", at: 2, toolName: "Bash", officeRoom: "qa", projectKey: "github.com/example/x" } }]);
        const t = store.sessionTimeline("s");
        expect(t.toolCalls.find((c) => c.toolUseId === "old")).toMatchObject({ officeRoom: "server", content: "kept", durationMs: 7, projectKey: null });
        expect(t.toolCalls.find((c) => c.toolUseId === `t${open}`)).toMatchObject({ officeRoom: "qa", projectKey: "github.com/example/x" });
        expect(t.prompts).toEqual([expect.objectContaining({ promptId: "p-old", excerpt: "kept too", projectKey: null })]);
      } finally {
        store.close();
      }
    }
  });
});

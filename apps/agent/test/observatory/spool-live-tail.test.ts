// Reading the spool's tail for watched sessions: whole lines only, each
// record once, from the minute files the spool reader has not taken yet (the
// current one and the one before), across a change of minute; SDK and
// internal sessions left out; the machine's secrets hidden by the second
// pass; no content in an event even when the record carries it; never a
// write or a deletion.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { redactRecordAgain } from "../../src/observatory/privacy/redact-record-again.ts";
import { SPOOL_DIR, minuteOf, spoolFileName } from "../../src/observatory/spool/spool-files.ts";
import { type LiveTailEvent, SpoolLiveTail } from "../../src/observatory/spool/spool-live-tail.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const T = 1_795_000_020_000; // a minute's start
const MACHINE_SECRET = "machine-secret-5d1e9c7b2a";
const CONTENT = "SAMPLE-CONTENT-never-shown-91c2";

const tails: SpoolLiveTail[] = [];
afterEach(async () => {
  for (const t of tails.splice(0)) await t.stop();
});

type Rig = { dir: string; tail: SpoolLiveTail; events: LiveTailEvent[]; clock: { now: number }; problems: string[]; skipped: Set<string> };

function rig(): Rig {
  const dataDir = obsTempDir("live-tail");
  const dir = join(dataDir, SPOOL_DIR);
  mkdirSync(dir, { recursive: true });
  const events: LiveTailEvent[] = [];
  const clock = { now: T + 30_000 };
  const problems: string[] = [];
  const skipped = new Set<string>();
  const tail = new SpoolLiveTail({
    dataDir,
    secondPass: (r) => redactRecordAgain(r, [MACHINE_SECRET]),
    skipSession: (id) => skipped.has(id),
    onEvent: (e) => events.push(e),
    problems: (place) => problems.push(place),
    now: () => clock.now,
    intervalMs: 20,
  });
  tails.push(tail);
  tail.start();
  return { dir, tail, events, clock, problems, skipped };
}

const record = (event: string, at: number, f: Record<string, string | number>, c?: Record<string, string>): FilteredHookRecord => ({ v: 1, src: "hook", event, at, f: { session_id: "s1", ...f }, ...(c ? { c } : {}) });
const line = (r: FilteredHookRecord): string => `${JSON.stringify(r)}\n`;
const fileOf = (dir: string, at: number): string => join(dir, spoolFileName("events", minuteOf(at)));

const toolPre = (id: string, at: number, extra: Record<string, string | number> = {}): FilteredHookRecord =>
  record("PreToolUse", at, { tool_use_id: id, tool_name: "Read", target: "src/a.ts", station: "FILES", station_flags: 0, ...extra }, { tool_input: CONTENT });

describe("the spool's live tail", () => {
  it("hands on whole lines only, each once, for the watched session", async () => {
    const r = rig();
    r.tail.watch("s1");
    const path = fileOf(r.dir, T);
    const first = line(toolPre("t1", T + 1_000));
    const second = line(toolPre("t2", T + 2_000));
    writeFileSync(path, first + second.slice(0, 40));
    await r.tail.readOnce();
    expect(r.events.map((e) => e.ops.map((o) => (o.kind === "toolCall" ? o.row.toolUseId : o.kind)))).toEqual([["t1"]]);
    await r.tail.readOnce();
    expect(r.events).toHaveLength(1);
    appendFileSync(path, second.slice(40));
    await r.tail.readOnce();
    await r.tail.readOnce();
    expect(r.events.map((e) => [e.provisional, e.event, e.at])).toEqual([
      [true, "PreToolUse", T + 1_000],
      [true, "PreToolUse", T + 2_000],
    ]);
    expect(r.events[0]?.ops[0]).toMatchObject({ kind: "toolCall", row: { toolUseId: "t1", station: "FILES", stationFlags: 0, target: "src/a.ts" } });
  });

  it("reads the minute just over and the current one, not older ones, and follows a change of minute", async () => {
    const r = rig();
    r.tail.watch("s1");
    writeFileSync(fileOf(r.dir, T - 60_000), line(toolPre("old", T - 30_000)));
    writeFileSync(fileOf(r.dir, T - 120_000), line(toolPre("older", T - 90_000)));
    writeFileSync(fileOf(r.dir, T), line(toolPre("now", T + 1_000)));
    await r.tail.readOnce();
    const ids = (): string[] => r.events.flatMap((e) => e.ops.flatMap((o) => (o.kind === "toolCall" ? [o.row.toolUseId] : [])));
    expect(ids()).toEqual(["old", "now"]);
    // The next minute starts: its file is read, the one before still is, nothing twice.
    r.clock.now = T + 61_000;
    writeFileSync(fileOf(r.dir, T + 60_000), line(toolPre("next", T + 60_500)));
    appendFileSync(fileOf(r.dir, T), line(toolPre("late", T + 59_000)));
    await r.tail.readOnce();
    expect(ids()).toEqual(["old", "now", "late", "next"]);
    // Nothing deleted or changed.
    expect(readdirSync(r.dir).sort()).toHaveLength(4);
  });

  it("shows a session watched later its records from the files' start", async () => {
    const r = rig();
    r.tail.watch("s2");
    writeFileSync(fileOf(r.dir, T), line(toolPre("a", T + 1)) + line({ ...toolPre("b", T + 2), f: { ...toolPre("b", T + 2).f, session_id: "s2" } }));
    await r.tail.readOnce();
    expect(r.events.map((e) => e.sessionId)).toEqual(["s2"]);
    r.tail.watch("s1");
    await r.tail.readOnce();
    expect(r.events.map((e) => e.sessionId)).toEqual(["s2", "s1"]);
    r.tail.unwatch("s1");
    r.tail.unwatch("s2");
    expect(r.tail.watched).toEqual([]);
    appendFileSync(fileOf(r.dir, T), line(toolPre("c", T + 3)));
    await r.tail.readOnce();
    expect(r.events).toHaveLength(2);
  });

  it("leaves out sessions the agent runs through the SDK and internal ones", async () => {
    const r = rig();
    for (const id of ["s1", "sdk", "advisor"]) r.tail.watch(id);
    r.skipped.add("sdk");
    const of = (session: string, extra: Record<string, string> = {}): FilteredHookRecord => ({ ...toolPre(`t-${session}`, T + 1), f: { ...toolPre("x", T + 1).f, session_id: session, ...extra } });
    writeFileSync(fileOf(r.dir, T), line(of("s1")) + line(of("sdk")) + line(of("advisor", { internal_label: "advisor" })));
    await r.tail.readOnce();
    expect(r.events.map((e) => e.sessionId)).toEqual(["s1"]);
  });

  it("hides the machine's secrets and hands on no content, though the record carries it", async () => {
    const r = rig();
    r.tail.watch("s1");
    const records = [
      record("UserPromptSubmit", T + 1, { prompt_id: "p1", prompt_length: 40 }, { prompt: `${CONTENT} ${MACHINE_SECRET}` }),
      toolPre("t1", T + 2, { target: `deploy/${MACHINE_SECRET}` }),
      record("PostToolUseFailure", T + 3, { tool_use_id: "t1", tool_name: "Bash", station: "GIT", station_flags: StationFlag.commit, duration_ms: 5 }, { error: CONTENT, tool_input: CONTENT }),
      record("PermissionDenied", T + 4, { tool_use_id: "t9", tool_name: "Write" }, { reason: CONTENT, tool_input: CONTENT }),
      record("Stop", T + 5, { prompt_id: "p1" }, { last_assistant_message: CONTENT }),
      record("InstructionsLoaded", T + 6, { file_path: "~/work/CLAUDE.md", load_reason: "session_start" }),
    ];
    writeFileSync(fileOf(r.dir, T), records.map(line).join(""));
    await r.tail.readOnce();
    expect(r.events.map((e) => e.event)).toEqual(["UserPromptSubmit", "PreToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "InstructionsLoaded"]);
    const text = JSON.stringify(r.events);
    expect(text).not.toContain(CONTENT);
    expect(text).not.toContain(MACHINE_SECRET);
    expect(r.events[0]?.ops[0]).toMatchObject({ kind: "prompt", row: { promptId: "p1", length: 40 } });
    expect(r.events[5]?.instruction).toMatchObject({ filePath: "~/work/CLAUDE.md", loadReason: "session_start" });
    // The spool file itself is left as it was.
    expect(readFileSync(fileOf(r.dir, T), "utf8")).toContain(CONTENT);
  });

  it("takes every line of two hook processes appending at once, each once, while reading", async () => {
    const r = rig();
    r.clock.now = T + 1_500;
    const count = 150;
    for (const tag of ["A", "B"]) for (let i = 0; i < count; i++) r.tail.watch(`${tag}-${i}`);
    const child = (tag: string): Promise<number | null> =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [join(import.meta.dirname, "spool-writer-child.ts"), join(r.dir, ".."), String(count), tag, String(T + 1_000), "3000"], { stdio: ["ignore", "ignore", "inherit"] });
        p.on("exit", resolve);
      });
    const writers = Promise.all([child("A"), child("B")]);
    let done = false;
    void writers.then(() => (done = true));
    while (!done) await r.tail.readOnce();
    expect(await writers).toEqual([0, 0]);
    await r.tail.readOnce();
    const ids = r.events.map((e) => e.sessionId);
    expect(ids).toHaveLength(2 * count);
    expect(new Set(ids).size).toBe(2 * count);
    expect(JSON.stringify(r.events)).not.toContain("ppppp");
  }, 30_000);

  it("reads on its own while started and watched, and stops", async () => {
    const r = rig();
    writeFileSync(fileOf(r.dir, T), line(toolPre("t1", T + 1)));
    r.tail.watch("s1");
    await expect.poll(() => r.events.length, { timeout: 2_000 }).toBe(1);
    await r.tail.stop();
    appendFileSync(fileOf(r.dir, T), line(toolPre("t2", T + 2)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.events).toHaveLength(1);
    expect(r.problems).toEqual([]);
  });
});

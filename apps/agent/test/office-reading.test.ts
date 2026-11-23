// How the office reads and reports: whole lines a bounded piece at a time,
// problems logged by place and kind at most once an interval, and the
// subagents' records read only when they can tell something the machine's
// own stream does not.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, OfficeActorState, OfficeRole, ThreadState, ThreadSummarySchema, ToolKind } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { readLinesUntil } from "../src/activity/bounded-lines.ts";
import { ProblemLog, errorKind } from "../src/activity/problem-log.ts";
import { OfficeMemory, OfficeThread } from "../src/office/office-thread.ts";
import { tempDir } from "./harness.ts";

describe("bounded lines", () => {
  const file = (text: string): string => {
    const path = join(tempDir("office-lines-"), "log.jsonl");
    writeFileSync(path, text);
    return path;
  };

  it("passes whole lines starting before the end, and says where to go on", async () => {
    const path = file("aa\nbbbb\ncc\ndd");
    const seen: string[] = [];
    const { next } = await readLinesUntil(path, 0, 4, 100, (l) => seen.push(l.toString()));
    // "bbbb" starts at 3, before the end (4): passed whole.
    expect(seen).toEqual(["aa", "bbbb"]);
    expect(next).toBe(8);
    const rest: string[] = [];
    // "dd" has no newline yet: left for later, but its bytes were read (they count against a budget).
    expect(await readLinesUntil(path, next, 100, 100, (l) => rest.push(l.toString()))).toEqual({ next: 11, bytesRead: 5 });
    expect(rest).toEqual(["cc"]);
  });

  it("skips a line over the cap whole", async () => {
    const path = file(`${"x".repeat(50)}\nok\n`);
    const seen: string[] = [];
    expect((await readLinesUntil(path, 0, 1_000, 10, (l) => seen.push(l.toString()))).next).toBe(54);
    expect(seen).toEqual(["ok"]);
  });

  it("reads nothing when the end is not past the start", async () => {
    const path = file("aa\n");
    expect(await readLinesUntil(path, 3, 3, 100, () => undefined)).toEqual({ next: 3, bytesRead: 0 });
  });
});

describe("office problems", () => {
  it("logs a place at most once an interval, with how many more happened, never the message", () => {
    const lines: string[] = [];
    let now = 0;
    const p = new ProblemLog((l) => lines.push(l), () => now, 1_000);
    p.report("poll", new TypeError("secret text"));
    p.report("poll", new TypeError("secret text"));
    p.report("send events", Object.assign(new Error("C:\\Users\\me\\private"), { code: "EACCES" }));
    now = 1_500;
    p.report("poll", new RangeError("x"));
    expect(lines).toEqual(["office: poll failed: TypeError", "office: send events failed: EACCES", "office: poll failed: RangeError (+1 since the last line)"]);
  });

  it("names an error's kind only", () => {
    expect(errorKind(new SyntaxError("{ private"))).toBe("SyntaxError");
    expect(errorKind({ code: "ENOENT", message: "/home/me" })).toBe("ENOENT");
    expect(errorKind({ code: "not a code /home/me" })).toBe("object");
    expect(errorKind("text")).toBe("string");
  });
});

describe("when the subagents' records are read", () => {
  const summary = (fields: { state?: ThreadState; busyElsewhere?: boolean; backgroundTasks?: number }) =>
    create(ThreadSummarySchema, { id: "t1", provider: "claude", state: fields.state ?? ThreadState.IDLE, busyElsewhere: fields.busyElsewhere ?? false, backgroundTasks: fields.backgroundTasks ?? 0 });
  const thread = (): OfficeThread => {
    const memory = new OfficeMemory();
    memory.sessionIds.set("t1", "session-1");
    return new OfficeThread("t1", true, memory, 0);
  };
  const report = { subagents: [], usage: [] };

  it("an idle thread the machine ran: once, then not until it runs elsewhere", () => {
    const t = thread();
    t.setSummary(summary({}), 1);
    expect(t.wantsSubagentRecords()).toBe(true);
    t.subagentReport(report, 2);
    // A second read, in case the first came back empty after an error.
    expect(t.wantsSubagentRecords()).toBe(true);
    t.subagentReport(report, 2);
    expect(t.wantsSubagentRecords()).toBe(false);
    t.setSummary(summary({ state: ThreadState.RUNNING }), 3);
    expect(t.wantsSubagentRecords()).toBe(false);
    // Background work of the machine's own turn: its stream tells it.
    t.setSummary(summary({ backgroundTasks: 1 }), 4);
    expect(t.wantsSubagentRecords()).toBe(false);
  });

  it("a thread run elsewhere: while it runs, once more after, and while its background work goes on", () => {
    const t = thread();
    t.setSummary(summary({ busyElsewhere: true }), 1);
    t.subagentReport(report, 2);
    expect(t.wantsSubagentRecords()).toBe(true);
    t.setSummary(summary({ backgroundTasks: 1 }), 3);
    t.subagentReport(report, 4);
    t.subagentReport(report, 4);
    expect(t.wantsSubagentRecords()).toBe(true);
    t.setSummary(summary({}), 5);
    expect(t.wantsSubagentRecords()).toBe(false);
  });

  it("a subagent the journal brought in learns its kind from an old finished record (the agent's memory was lost on a restart)", () => {
    // Built an hour after the subagent finished, while the session still runs elsewhere, from a journal item that keeps no kind.
    const hour = 3_600_000;
    const built = new OfficeThread("t1", true, Object.assign(new OfficeMemory(), { sessionIds: new Map([["t1", "session-1"]]) }), hour);
    const item = create(ItemSchema, { id: "sub:a1", at: 1_000n, body: { case: "subagent", value: { toolId: "a1", description: "Review", done: true } } });
    built.seed([item], summary({ busyElsewhere: true }), hour);
    expect(built.tracker.snapshot().actors.find((a) => a.id === "a1")?.agentType).toBe("");
    const record = { toolUseId: "a1", parentToolUseId: "", workflowId: "", agentType: "code-reviewer", description: "Review", background: true, spawnDepth: 1, finished: true, updatedAt: 2_000, tools: [] };
    built.subagentReport({ subagents: [record], usage: [] }, hour + 1);
    expect(built.tracker.snapshot().actors.find((a) => a.id === "a1")?.agentType).toBe("code-reviewer");
    // One the journal never brought in is still left out.
    built.subagentReport({ subagents: [{ ...record, toolUseId: "gone" }], usage: [] }, hour + 2);
    expect(built.tracker.snapshot().actors.some((a) => a.id === "gone")).toBe(false);
  });

  it("a subagent in the background is done only when its record says finished or has been quiet over ten minutes", () => {
    const t = thread();
    t.setSummary(summary({ busyElsewhere: true }), 1);
    const minute = 60_000;
    const record = { toolUseId: "bg", parentToolUseId: "", workflowId: "", agentType: "fullstack-developer", description: "Build", background: true, spawnDepth: 1, finished: false, updatedAt: 0, tools: [] };
    const state = (): unknown => t.tracker.snapshot().actors.find((a) => a.id === "bg")?.state;
    // Its record still being written (a minute ago): it works on, whatever the count of background work says.
    t.subagentReport({ subagents: [{ ...record, updatedAt: 9 * minute }], usage: [] }, 10 * minute);
    t.setSummary(summary({}), 10 * minute + 1);
    expect(state()).toBe(OfficeActorState.WORKING);
    // Quiet for over ten minutes: the AI that ran it is gone.
    t.subagentReport({ subagents: [{ ...record, updatedAt: 9 * minute }], usage: [] }, 20 * minute);
    expect(state()).toBe(OfficeActorState.DONE);
  });

  it("a quiet record is no end while a tool of its own is open or background work is counted, and only a presumed one", () => {
    const minute = 60_000;
    const t = thread();
    t.setSummary(summary({ busyElsewhere: true }), 1);
    const open = { toolId: "bg-t", name: "Bash", kind: "shell" as const, at: minute, done: false, ok: true, command: "pnpm test" };
    const record = { toolUseId: "bg", parentToolUseId: "", workflowId: "", agentType: "tester", description: "Test", background: true, spawnDepth: 1, finished: false, updatedAt: minute, tools: [open] };
    const state = (): unknown => t.tracker.snapshot().actors.find((a) => a.id === "bg")?.state;
    // A long test run: its record is quiet for 15 minutes, its tool open, background work counted.
    t.setSummary(summary({ backgroundTasks: 1 }), 2);
    t.subagentReport({ subagents: [record], usage: [] }, 16 * minute);
    expect(state()).toBe(OfficeActorState.WORKING);
    // The count of background work at 0 (it may miss subagents): the open tool still keeps it at work.
    t.setSummary(summary({ busyElsewhere: true }), 16 * minute + 1);
    t.subagentReport({ subagents: [record], usage: [] }, 17 * minute);
    expect(state()).toBe(OfficeActorState.WORKING);
    // Its tool done, nothing counted, quiet: presumed gone...
    const quiet = { ...record, tools: [{ ...open, done: true }] };
    t.subagentReport({ subagents: [quiet], usage: [] }, 18 * minute);
    expect(state()).toBe(OfficeActorState.DONE);
    // ...until a tool call of its own shows up: back to work.
    t.subagentReport({ subagents: [{ ...quiet, updatedAt: 19 * minute, tools: [{ ...open, toolId: "bg-t2", at: 19 * minute }] }], usage: [] }, 19 * minute);
    expect(state()).toBe(OfficeActorState.WORKING);
  });

  it("a quiet record with no tool open is no end while background work is counted", () => {
    const minute = 60_000;
    const t = thread();
    t.setSummary(summary({ backgroundTasks: 1 }), 1);
    const record = { toolUseId: "bg", parentToolUseId: "", workflowId: "", agentType: "tester", description: "", background: true, spawnDepth: 1, finished: false, updatedAt: minute, tools: [] };
    t.subagentReport({ subagents: [record], usage: [] }, 20 * minute);
    expect(t.tracker.snapshot().actors.find((a) => a.id === "bg")?.state).toBe(OfficeActorState.WORKING);
  });

  it("a recent record saying finished does not bring one already done back to work", () => {
    const t = thread();
    t.setSummary(summary({ busyElsewhere: true }), 1);
    const record = { toolUseId: "bg", parentToolUseId: "", workflowId: "", agentType: "tester", description: "", background: false, spawnDepth: 1, finished: false, updatedAt: 1, tools: [] };
    t.subagentReport({ subagents: [record], usage: [] }, 2);
    // Its turn ended first: taken as done (not yet known to run in the background).
    t.setSummary(summary({}), 3);
    expect(t.tracker.snapshot().actors.find((a) => a.id === "bg")).toMatchObject({ state: OfficeActorState.DONE, doneAt: 3n });
    t.tracker.drain();
    t.subagentReport({ subagents: [{ ...record, background: true, finished: true, updatedAt: 4 }], usage: [] }, 5);
    expect(t.tracker.snapshot().actors.find((a) => a.id === "bg")).toMatchObject({ state: OfficeActorState.DONE, doneAt: 3n });
    expect(t.tracker.drain().filter((e) => e.kind.case === "actorUpdate" && e.kind.value.state === OfficeActorState.WORKING)).toEqual([]);
  });

  it("a subagent its record says finished is never brought back to hand in again, and keeps when it was done", () => {
    const hour = 3_600_000;
    const built = new OfficeThread("t1", true, Object.assign(new OfficeMemory(), { sessionIds: new Map([["t1", "session-1"]]) }), hour);
    const item = create(ItemSchema, { id: "sub:a1", at: 1_000n, body: { case: "subagent", value: { toolId: "a1", description: "Review", done: true } } });
    built.seed([item], summary({ busyElsewhere: true }), hour);
    const before = built.tracker.snapshot().actors.find((a) => a.id === "a1");
    expect(before?.state).toBe(OfficeActorState.DONE);
    built.tracker.drain();
    const record = { toolUseId: "a1", parentToolUseId: "", workflowId: "", agentType: "code-reviewer", description: "Review", background: true, spawnDepth: 1, finished: true, updatedAt: 2_000, tools: [] };
    // Read again and again (each read after a restart of the agent too): no work again, no second hand-in.
    for (const at of [hour + 1, hour + 2]) built.subagentReport({ subagents: [record], usage: [] }, at);
    const after = built.tracker.snapshot().actors.find((a) => a.id === "a1");
    expect(after).toMatchObject({ state: OfficeActorState.DONE, doneAt: before?.doneAt, agentType: "code-reviewer" });
    expect(built.tracker.drain().filter((e) => e.kind.case === "actorUpdate" && e.kind.value.state === OfficeActorState.WORKING)).toEqual([]);
  });

  it("never without the AI's session id", () => {
    const t = new OfficeThread("t1", true, new OfficeMemory(), 0);
    t.setSummary(summary({ busyElsewhere: true }), 1);
    expect(t.wantsSubagentRecords()).toBe(false);
  });
});

describe("which machine leaves when background work ends", () => {
  const summary = (backgroundTasks: number) =>
    create(ThreadSummarySchema, { id: "t1", provider: "claude", state: ThreadState.IDLE, busyElsewhere: true, backgroundTasks });
  const start = (t: OfficeThread, toolId: string, command: string, at: number): void =>
    t.tracker.toolStart({ toolId, name: "Bash", kind: "shell", summary: command, sensitive: false, background: true }, at);
  const machines = (t: OfficeThread): string[] => t.tracker.snapshot().actors.filter((a) => a.role === OfficeRole.MACHINE).map((a) => a.id);
  /** A session run in a terminal: the dev server first, then a sleep, then a second server that dies. */
  const running = (): OfficeThread => {
    const t = new OfficeThread("t1", true, Object.assign(new OfficeMemory(), { sessionIds: new Map([["t1", "session-1"]]) }), 0);
    t.setSummary(summary(1), 1);
    start(t, "dev", "cd /w && python3 -m http.server 5173", 2);
    start(t, "sleep", "sleep 420", 3);
    start(t, "second", "cd /w && PORT=5174 python3 -m http.server 5174", 4);
    t.setSummary(summary(3), 4);
    return t;
  };

  it("the machine whose task the record says ended leaves, not the oldest one that still runs", () => {
    const t = running();
    // The record's pass gives the ended task and the lower count together: the ended task is told first.
    t.backgroundEnded(new Map([["second", false]]), 5);
    t.setSummary(summary(2), 5);
    expect(machines(t)).toEqual(["dev", "sleep"]);
  });

  it("told again and again, an end applies once", () => {
    const t = running();
    const ended = new Map([["second", false]]);
    t.backgroundEnded(ended, 5);
    t.setSummary(summary(2), 5);
    t.tracker.drain();
    t.backgroundEnded(ended, 6);
    t.setSummary(summary(2), 6);
    expect(machines(t)).toEqual(["dev", "sleep"]);
    expect(t.tracker.drain().filter((e) => e.kind.case === "actorLeave" || e.kind.case === "actorUpdate")).toEqual([]);
  });

  it("without the record's word, a fall in the count still sends the oldest machine away", () => {
    const t = running();
    t.setSummary(summary(2), 5);
    expect(machines(t)).toEqual(["sleep", "second"]);
  });

  it("an office built from the journal drops the ended machine at once", () => {
    const built = new OfficeThread("t1", true, Object.assign(new OfficeMemory(), { sessionIds: new Map([["t1", "session-1"]]) }), 10);
    const item = (id: string, at: bigint, command: string) =>
      create(ItemSchema, {
        id: `tool:${id}`,
        at,
        body: { case: "toolCall", value: { toolId: id, name: "Bash", kind: ToolKind.SHELL, summary: command, input: JSON.stringify({ command, run_in_background: true }) } },
      });
    built.seed([item("dev", 1_000n, "python3 -m http.server 5173"), item("second", 2_000n, "python3 -m http.server 5174")], summary(1), 10, new Map([["second", false]]));
    expect(machines(built)).toEqual(["dev"]);
  });
});

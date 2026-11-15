// How the office reads and reports: whole lines a bounded piece at a time,
// problems logged by place and kind at most once an interval, and the
// subagents' records read only when they can tell something the machine's
// own stream does not.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ThreadState, ThreadSummarySchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { readLinesUntil } from "../src/office/office-bounded-lines.ts";
import { OfficeProblems, errorKind } from "../src/office/office-problem-log.ts";
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
    const pos = await readLinesUntil(path, 0, 4, 100, (l) => seen.push(l.toString()));
    // "bbbb" starts at 3, before the end (4): passed whole.
    expect(seen).toEqual(["aa", "bbbb"]);
    expect(pos).toBe(8);
    const rest: string[] = [];
    // "dd" has no newline yet: left for later.
    expect(await readLinesUntil(path, pos, 100, 100, (l) => rest.push(l.toString()))).toBe(11);
    expect(rest).toEqual(["cc"]);
  });

  it("skips a line over the cap whole", async () => {
    const path = file(`${"x".repeat(50)}\nok\n`);
    const seen: string[] = [];
    expect(await readLinesUntil(path, 0, 1_000, 10, (l) => seen.push(l.toString()))).toBe(54);
    expect(seen).toEqual(["ok"]);
  });

  it("reads nothing when the end is not past the start", async () => {
    const path = file("aa\n");
    expect(await readLinesUntil(path, 3, 3, 100, () => undefined)).toBe(3);
  });
});

describe("office problems", () => {
  it("logs a place at most once an interval, with how many more happened, never the message", () => {
    const lines: string[] = [];
    let now = 0;
    const p = new OfficeProblems((l) => lines.push(l), () => now, 1_000);
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
    expect(t.wantsSubagentRecords()).toBe(true);
    t.setSummary(summary({}), 5);
    expect(t.wantsSubagentRecords()).toBe(false);
  });

  it("never without the AI's session id", () => {
    const t = new OfficeThread("t1", true, new OfficeMemory(), 0);
    t.setSummary(summary({ busyElsewhere: true }), 1);
    expect(t.wantsSubagentRecords()).toBe(false);
  });
});

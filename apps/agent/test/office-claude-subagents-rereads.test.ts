// A subagent's log whose last line is not finished yet is not read again
// while the file does not change, and is read on once it grows; a log
// unchanged since a read that reached its end is not opened at all.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeSubagentFeed } from "../src/providers/claude/office-subagents.ts";
import { tempDir } from "./harness.ts";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../src/activity/bounded-lines.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/activity/bounded-lines.ts")>();
  return {
    readLinesUntil: (path: string, ...rest: Parameters<typeof actual.readLinesUntil> extends [string, ...infer R] ? R : never) => {
      reads.paths.push(path);
      return actual.readLinesUntil(path, ...rest);
    },
  };
});

const reply = (id: string): string =>
  `${JSON.stringify({ type: "assistant", timestamp: "2026-11-15T10:00:00.000Z", sessionId: "s", requestId: `r-${id}`, message: { id, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } })}\n`;

describe("rereads of the subagents' logs", () => {
  it("leaves an unfinished last line alone until the log grows", async () => {
    const root = tempDir("office-rereads-");
    const transcript = join(root, "sess.jsonl");
    const sub = join(root, "sess", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(transcript, reply("main"));
    writeFileSync(join(sub, "agent-x.meta.json"), JSON.stringify({ toolUseId: "a1" }));
    const log = join(sub, "agent-x.jsonl");
    const half = reply("late");
    writeFileSync(log, reply("one") + half.slice(0, 40));
    const feed = new ClaudeSubagentFeed(() => transcript);
    const keys = async (): Promise<string[]> => (await feed.read("sess", 0)).usage.map((c) => c.key).sort();

    expect(await keys()).toEqual(["main|r-main", "one|r-one"]);
    reads.paths.length = 0;
    await keys();
    await keys();
    // Neither the transcript nor the log changed: neither is read again.
    expect(reads.paths).toEqual([]);

    appendFileSync(log, half.slice(40));
    expect(await keys()).toEqual(["late|r-late", "main|r-main", "one|r-one"]);
    expect(reads.paths).toEqual([log]);
  });
});

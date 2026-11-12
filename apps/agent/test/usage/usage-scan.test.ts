// The Claude usage source: which files it lists (subagents included, links
// never followed, one projects folder however many profiles link to it) and
// what a read takes from them (numbers and names only).
import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeUsage, parseUsageLine, readLines } from "../../src/providers/claude/usage-scan.ts";
import type { UsageFile, UsageLineStats } from "../../src/providers/types.ts";
import { tempDir } from "../harness.ts";
import { MARKER, appendLines, mainFile, minute, replyRecord, subagentFile, toolResultRecord, userRecord, writeLines } from "./usage-fixture.ts";

const SID = "11111111-1111-4111-8111-111111111111";
const stats = (): UsageLineStats => ({ records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} });

function fileOf(path: string): UsageFile {
  const st = statSync(path);
  return { path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

describe("listing transcripts", () => {
  it("lists main sessions and subagents (nested too), skips links, and reads a projects folder linked from two homes once", async () => {
    const root = tempDir("usage-list-");
    const home = join(root, "claude");
    const main = mainFile(home, "-work-example", SID);
    writeLines(main, [replyRecord({ sessionId: SID, msgId: "msg_a", requestId: "req_a", at: minute(1) })]);
    const sub = subagentFile(home, "-work-example", SID, "a1");
    const nested = subagentFile(home, "-work-example", SID, "a2", "workflows");
    writeLines(sub, [replyRecord({ sessionId: SID, msgId: "msg_b", requestId: "req_b", at: minute(2), agentId: "a1" })]);
    writeLines(nested, [replyRecord({ sessionId: SID, msgId: "msg_c", requestId: "req_c", at: minute(3), agentId: "a2" })]);
    // A tool-results folder beside the session is not a transcript.
    mkdirSync(join(home, "projects", "-work-example", SID, "tool-results"), { recursive: true });
    writeFileSync(join(home, "projects", "-work-example", SID, "tool-results", "x.jsonl"), "{}\n");
    // Links: a transcript, a folder of transcripts, a subagents folder.
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeLines(join(outside, "other.jsonl"), [replyRecord({ sessionId: SID, msgId: "msg_z", requestId: "req_z", at: minute(4) })]);
    symlinkSync(join(outside, "other.jsonl"), join(home, "projects", "-work-example", "linked.jsonl"));
    symlinkSync(outside, join(home, "projects", "-linked-folder"));
    mkdirSync(join(home, "projects", "-work-example", "22222222-2222-4222-8222-222222222222"), { recursive: true });
    symlinkSync(outside, join(home, "projects", "-work-example", "22222222-2222-4222-8222-222222222222", "subagents"));
    // A profile whose projects folder links to the machine's own.
    const profile = join(root, "profile");
    mkdirSync(profile, { recursive: true });
    symlinkSync(join(home, "projects"), join(profile, "projects"));

    const source = new ClaudeUsage({ homes: () => [home, profile, join(root, "missing")] });
    const files = await source.files();
    expect(files.map((f) => f.path).sort()).toEqual([main, nested, sub].map((p) => realpathSync(p)).sort());
    const reads = await Promise.all(files.map((f) => source.read(f, 0)));
    const turns = reads.flatMap((r) => r.turns);
    expect(turns.map((t) => [t.key, t.subagent, t.agentId ?? ""]).sort()).toEqual([
      ["msg_a|req_a", false, ""],
      ["msg_b|req_b", true, "a1"],
      ["msg_c|req_c", true, "a2"],
    ]);
  });
});

describe("reading a transcript", () => {
  it("takes numbers and names only: never a message, a tool's input or its result", async () => {
    const home = join(tempDir("usage-read-"), "claude");
    const file = mainFile(home, "-work-example", SID);
    writeLines(file, [
      userRecord(SID, minute(0)),
      replyRecord({
        sessionId: SID,
        msgId: "msg_1",
        requestId: "req_1",
        at: minute(1),
        cwd: "/work/example-repo/sub",
        usage: { input: 5, cacheRead: 2000, cacheWrite: 300, output: 40 },
        tools: [{ name: "Bash" }, { name: "Skill", skill: "example-skill" }, { name: "mcp__example__search" }],
      }),
      toolResultRecord(SID, minute(2)),
    ]);
    const source = new ClaudeUsage({ homes: () => [home] });
    const [f] = await source.files();
    if (!f) throw new Error("no file");
    const read = await source.read(f, 0);
    expect(read.turns).toEqual([
      {
        key: "msg_1|req_1",
        sessionId: SID,
        subagent: false,
        at: Date.parse(minute(1)),
        model: "claude-test-model",
        cwd: "/work/example-repo/sub",
        inputTokens: 5,
        cacheReadTokens: 2000,
        cacheWriteTokens: 300,
        outputTokens: 40,
        tools: ["Bash", "Skill:example-skill", "mcp__example__search"],
      },
    ]);
    expect(JSON.stringify(read)).not.toContain(MARKER);
    expect(read.end).toBe(f.size);
    expect(read.stats).toEqual({ records: 1, withUsage: 1, parseErrors: 0, overCap: 0, unknownTypes: {} });
  });

  it("keys a reply without requestId by its message id, and skips Claude's synthetic replies", () => {
    const s = stats();
    const plain = parseUsageLine(Buffer.from(replyRecord({ sessionId: SID, msgId: "msg_only", at: minute(1) })), false, s);
    expect(plain?.key).toBe("msg_only");
    const synthetic = parseUsageLine(Buffer.from(replyRecord({ sessionId: SID, msgId: "msg_syn", at: minute(1), model: "<synthetic>", usage: {} })), false, s);
    expect(synthetic).toBeUndefined();
  });

  it("counts replies without token counts, broken lines and unknown reply content", () => {
    const s = stats();
    parseUsageLine(Buffer.from(replyRecord({ sessionId: SID, msgId: "msg_1", requestId: "r", at: minute(1), usage: null })), false, s);
    parseUsageLine(Buffer.from('{"type":"assistant", broken'), false, s);
    parseUsageLine(Buffer.from(replyRecord({ sessionId: SID, msgId: "msg_2", requestId: "r", at: minute(1), blockType: "hologram" })), false, s);
    parseUsageLine(Buffer.from(replyRecord({ sessionId: SID, msgId: "msg_3", requestId: "r", at: minute(1), blockType: "Not A Type!" })), false, s);
    expect(s).toEqual({ records: 3, withUsage: 2, parseErrors: 1, overCap: 0, unknownTypes: { hologram: 1, other: 1 } });
  });

  it("leaves a line still being written for the next read", async () => {
    const home = join(tempDir("usage-partial-"), "claude");
    const file = mainFile(home, "-work-example", SID);
    const first = replyRecord({ sessionId: SID, msgId: "msg_1", requestId: "req_1", at: minute(1) });
    const second = replyRecord({ sessionId: SID, msgId: "msg_2", requestId: "req_2", at: minute(2) });
    writeFileSync(file, `${first}\n${second.slice(0, 40)}`);
    const source = new ClaudeUsage({ homes: () => [home] });
    const [f] = await source.files();
    if (!f) throw new Error("no file");
    const read = await source.read(f, 0);
    expect(read.turns.map((t) => t.key)).toEqual(["msg_1|req_1"]);
    expect(read.end).toBe(first.length + 1);
    appendLines(file, [second.slice(40)]);
    const next = await source.read(fileOf(file), read.end);
    expect(next.turns.map((t) => t.key)).toEqual(["msg_2|req_2"]);
  });

  it("skips a line over the cap without keeping it, and goes on after it", async () => {
    const dir = tempDir("usage-cap-");
    const file = join(dir, "t.jsonl");
    const big = replyRecord({ sessionId: SID, msgId: "msg_big", requestId: "r", at: minute(1) }).replace(MARKER, "x".repeat(3000));
    const small = replyRecord({ sessionId: SID, msgId: "msg_ok", requestId: "r", at: minute(2) });
    writeLines(file, [big, small]);
    const s = stats();
    const keys: string[] = [];
    const end = await readLines(file, 0, 1000, s, (line) => {
      const t = parseUsageLine(line, false, s);
      if (t) keys.push(t.key);
    });
    expect(keys).toEqual(["msg_ok|r"]);
    expect(s.overCap).toBe(1);
    expect(end).toBe(big.length + small.length + 2);
    // An over-long line still being written is neither counted nor passed.
    writeFileSync(file, `${small}\n${"y".repeat(5000)}`);
    const s2 = stats();
    const end2 = await readLines(file, 0, 1000, s2, () => undefined);
    expect(s2.overCap).toBe(0);
    expect(end2).toBe(small.length + 1);
  });
});

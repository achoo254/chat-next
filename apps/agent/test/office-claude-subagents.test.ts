// Claude Code's records of a session's subagents, read for the office view:
// kinds, depth, background, finished, tool calls by name with their ok, the
// session's token counts; never a message, a tool's input (but a shell's
// command, kept on the machine) or a result; a damaged record is passed over.
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSubagentFeed, parseAgentLine } from "../src/providers/claude/office-subagents.ts";
import { tempDir } from "./harness.ts";

const SECRET = "MARKER-7f3a-private";
const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const ts = (s: number) => new Date(T0 + s * 1000).toISOString();

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const assistant = (s: number, id: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 5 }) =>
  line({ type: "assistant", timestamp: ts(s), sessionId: "sess", requestId: `req-${id}`, isSidechain: true, message: { id, model: "claude-x", usage, content } });
const result = (s: number, toolUseId: string, isError = false) =>
  line({ type: "user", timestamp: ts(s), sessionId: "sess", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: `${SECRET} output` }] } });

function sessionFixture() {
  const root = tempDir("office-subagents-");
  const project = join(root, "projects", "-w");
  const transcript = join(project, "sess.jsonl");
  const sub = join(project, "sess", "subagents");
  mkdirSync(join(sub, "workflows", "wf_1"), { recursive: true });
  writeFileSync(
    transcript,
    [
      assistant(0, "main-1", [{ type: "text", text: `${SECRET} said` }], { input_tokens: 100, output_tokens: 50 }),
      // The same reply written again for its next block: one call.
      assistant(0, "main-1", [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: SECRET } }], { input_tokens: 100, output_tokens: 50 }),
      line({ type: "api-request-blob", message: { content: [{ type: "tool_use", id: "ghost", name: "Bash", input: { command: "rm -rf /" } }] } }),
    ].join(""),
  );
  writeFileSync(join(sub, "agent-x1.meta.json"), JSON.stringify({ agentType: "code-reviewer", description: "Review the diff", toolUseId: "a1", spawnDepth: 1, requestShape: "background" }));
  writeFileSync(
    join(sub, "agent-x1.jsonl"),
    [
      assistant(1, "s1", [
        { type: "thinking", thinking: SECRET },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test", description: SECRET } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: `/w/${SECRET}.ts` } },
      ]),
      result(2, "t1", true),
      "not json at all\n",
      assistant(3, "s2", [{ type: "tool_use", id: "n1", name: "Agent", input: { subagent_type: "scout", prompt: SECRET } }]),
    ].join(""),
  );
  writeFileSync(join(sub, "agent-x2.meta.json"), JSON.stringify({ agentType: "scout", description: "Nested look", toolUseId: "n1", spawnDepth: 2, requestShape: "background", finished: true }));
  writeFileSync(join(sub, "agent-x2.jsonl"), assistant(4, "s3", [{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: SECRET } }]));
  writeFileSync(join(sub, "workflows", "wf_1", "agent-w1.meta.json"), JSON.stringify({ agentType: "tester", description: "Phase", workflowPhase: "x", spawnDepth: 1, requestShape: "foreground" }));
  // A damaged record: skipped, nothing thrown.
  writeFileSync(join(sub, "agent-bad.meta.json"), "{ not json");
  return { transcript, sub, feed: new ClaudeSubagentFeed((id) => (id === "sess" ? transcript : undefined)) };
}

describe("the subagents' records of a Claude session", () => {
  it("tell each subagent's kind, depth, parent, background and finished, and its tool calls by name", async () => {
    const { feed } = sessionFixture();
    const r = await feed.read("sess", 0);
    const byId = new Map(r.subagents.map((s) => [s.toolUseId, s]));
    expect(byId.get("a1")).toMatchObject({ agentType: "code-reviewer", description: "Review the diff", spawnDepth: 1, parentToolUseId: "", workflowId: "", background: true, finished: false });
    expect(byId.get("a1")?.tools).toEqual([
      { toolId: "t1", name: "Bash", kind: "shell", at: T0 + 1000, done: true, ok: false, command: "pnpm test" },
      { toolId: "t2", name: "Read", kind: "read", at: T0 + 1000, done: false, ok: true },
      { toolId: "n1", name: "Agent", kind: "subagent", at: T0 + 3000, done: false, ok: true },
    ]);
    expect(byId.get("n1")).toMatchObject({ agentType: "scout", spawnDepth: 2, parentToolUseId: "a1", finished: true });
    expect(byId.get("workflow:wf_1/w1")).toMatchObject({ agentType: "tester", workflowId: "wf_1", background: false });
    expect(r.subagents).toHaveLength(3);
  });

  it("counts every call to the API once, the session's and its subagents'", async () => {
    const { feed } = sessionFixture();
    const r = await feed.read("sess", 0);
    const keys = r.usage.map((c) => c.key).sort();
    expect(keys).toEqual(["main-1|req-main-1", "s1|req-s1", "s2|req-s2", "s3|req-s3"]);
    expect(r.usage.find((c) => c.key === "main-1|req-main-1")).toEqual({ key: "main-1|req-main-1", at: T0, inputTokens: 100, outputTokens: 50 });
    expect((await feed.read("sess", T0 + 3500)).usage.map((c) => c.key)).toEqual(["s3|req-s3"]);
  });

  it("reads only what was appended, and gives the tool calls that changed since a time", async () => {
    const { feed, sub } = sessionFixture();
    await feed.read("sess", 0);
    appendFileSync(join(sub, "agent-x1.jsonl"), result(10, "t2"));
    const r = await feed.read("sess", T0 + 9000);
    const tools = r.subagents.find((s) => s.toolUseId === "a1")?.tools ?? [];
    // n1 is still running (no result): it stays listed; t1 ended before `since`: it is not.
    expect(tools.map((t) => [t.toolId, t.done])).toEqual([
      ["t2", true],
      ["n1", false],
    ]);
  });

  it("never carries a message, a tool's input other than a shell's command, or a result", async () => {
    const { feed } = sessionFixture();
    const text = JSON.stringify(await feed.read("sess", 0));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("rm -rf");
  });

  it("has nothing for a session it cannot find", async () => {
    const { feed } = sessionFixture();
    expect(await feed.read("other", 0)).toEqual({ subagents: [], usage: [] });
  });

  it("keeps a subagent's open tool call however many calls come after it", async () => {
    const { feed, sub } = sessionFixture();
    const many = Array.from({ length: 12 }, (_, i) => ({ type: "tool_use", id: `k${i}`, name: "Grep", input: {} }));
    writeFileSync(join(sub, "agent-x3.meta.json"), JSON.stringify({ agentType: "scout", toolUseId: "a3", spawnDepth: 1 }));
    writeFileSync(join(sub, "agent-x3.jsonl"), [assistant(1, "k", many), ...many.slice(1).map((t, i) => result(2 + i, t.id))].join(""));
    const tools = (await feed.read("sess", 0)).subagents.find((s) => s.toolUseId === "a3")?.tools ?? [];
    // The first call is still open: kept (its end must still reach the office); of the ended ones, the newest eight.
    expect(tools.filter((t) => !t.done).map((t) => t.toolId)).toEqual(["k0"]);
    expect(tools.filter((t) => t.done)).toHaveLength(8);
    appendFileSync(join(sub, "agent-x3.jsonl"), result(30, "k0"));
    const after = (await feed.read("sess", T0 + 29_000)).subagents.find((s) => s.toolUseId === "a3")?.tools ?? [];
    expect(after.map((t) => [t.toolId, t.done])).toEqual([["k0", true]]);
  });

  it("follows only the newest agents' logs, and not a finished agent whose files stopped changing", async () => {
    const root = tempDir("office-subagents-many-");
    const transcript = join(root, "sess.jsonl");
    const sub = join(root, "sess", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(transcript, "");
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(sub, `agent-m${i}.meta.json`), JSON.stringify({ agentType: "scout", toolUseId: `m${i}`, spawnDepth: 1 }));
      writeFileSync(join(sub, `agent-m${i}.jsonl`), assistant(1, `call-m${i}`, []));
      // m0 is the oldest, m39 the newest.
      const at = new Date(now - (40 - i) * 1000);
      utimesSync(join(sub, `agent-m${i}.meta.json`), at, at);
      utimesSync(join(sub, `agent-m${i}.jsonl`), at, at);
    }
    writeFileSync(join(sub, "agent-old.meta.json"), JSON.stringify({ agentType: "scout", toolUseId: "old", spawnDepth: 1, finished: true }));
    writeFileSync(join(sub, "agent-old.jsonl"), assistant(1, "call-old", []));
    const hourAgo = new Date(now - 3_600_000);
    utimesSync(join(sub, "agent-old.meta.json"), hourAgo, hourAgo);
    utimesSync(join(sub, "agent-old.jsonl"), hourAgo, hourAgo);

    const r = await new ClaudeSubagentFeed(() => transcript).read("sess", 0);
    const keys = new Set(r.usage.map((c) => c.key));
    expect(keys.size).toBe(32);
    expect(keys.has("call-m39|req-call-m39")).toBe(true);
    expect(keys.has("call-m7|req-call-m7")).toBe(false);
    expect(keys.has("call-old|req-call-old")).toBe(false);
    // Its record is still read: the office knows it finished.
    expect(r.subagents.find((s) => s.toolUseId === "old")).toMatchObject({ finished: true, tools: [] });
  });

  it("reads a fast-growing log a bounded piece at a time, and the rest on the next reads", async () => {
    const { feed, sub } = sessionFixture();
    await feed.read("sess", 0);
    const pad = "x".repeat(2_000);
    const lines = Array.from({ length: 1_500 }, (_, i) => assistant(20, `big-${i}`, [{ type: "text", text: pad }]));
    appendFileSync(join(sub, "agent-x1.jsonl"), lines.join(""));
    const count = async () => (await feed.read("sess", 0)).usage.filter((c) => c.key.startsWith("big-")).length;
    const first = await count();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1_500);
    let total = first;
    for (let i = 0; i < 5 && total < 1_500; i++) total = await count();
    expect(total).toBe(1_500);
  });

  it("logs a record it cannot read, by kind only and at most once a minute", async () => {
    const { transcript } = sessionFixture();
    const lines: string[] = [];
    const feed = new ClaudeSubagentFeed((id) => (id === "sess" ? transcript : undefined), (l) => lines.push(l));
    await feed.read("sess", 0);
    expect(lines).toEqual(["office: subagent meta failed: SyntaxError"]);
  });

  it("reads one record field by field, its type and tool blocks only", () => {
    const rec = parseAgentLine(Buffer.from(assistant(1, "m", [{ type: "tool_use", id: "x", name: "WebFetch", input: { url: `https://${SECRET}` } }])));
    expect(rec).toEqual({
      type: "assistant",
      at: T0 + 1000,
      blocks: [{ type: "tool_use", id: "x", name: "WebFetch", toolUseId: "", isError: false }],
      // The reply's API call, read in the same pass, keyed as the usage scan keys it.
      call: { key: "m|req-m", at: T0 + 1000, inputTokens: 10, outputTokens: 5 },
    });
    expect(parseAgentLine(Buffer.from('{"type":"attachment"}'))).toBeUndefined();
    expect(parseAgentLine(Buffer.from("{broken"))).toBeUndefined();
  });
});

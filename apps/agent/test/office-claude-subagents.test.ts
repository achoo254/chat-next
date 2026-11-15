// Claude Code's records of a session's subagents, read for the office view:
// kinds, depth, background, finished, tool calls by name with their ok, the
// session's token counts; never a message, a tool's input (but a shell's
// command, kept on the machine) or a result; a damaged record is passed over.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("reads one record field by field, its type and tool blocks only", () => {
    const rec = parseAgentLine(Buffer.from(assistant(1, "m", [{ type: "tool_use", id: "x", name: "WebFetch", input: { url: `https://${SECRET}` } }])));
    expect(rec).toEqual({ type: "assistant", at: T0 + 1000, blocks: [{ type: "tool_use", id: "x", name: "WebFetch", toolUseId: "", isError: false }] });
    expect(parseAgentLine(Buffer.from('{"type":"attachment"}'))).toBeUndefined();
    expect(parseAgentLine(Buffer.from("{broken"))).toBeUndefined();
  });
});

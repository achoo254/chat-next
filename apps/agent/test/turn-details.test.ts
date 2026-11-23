// A turn's numbers, a subagent's file edits, the uncommitted changes of a
// session's folder, and questions that outlive a restart of the service.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AnswersSchema, GitFileState, PromptState, ThreadState, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { turnStats } from "../src/providers/claude/index.ts";
import { MessageMapper } from "../src/providers/claude/message-mapper.ts";
import type { AgentProvider, AskUser, ProviderEvent, TurnStats } from "../src/providers/types.ts";
import { GIT_LIMITS, clipDiff, parseNumstat, parsePorcelain, readGitChanges, readGitFileDiff, splitDiff, stateOf } from "../src/threads/git-changes.ts";
import { gitChangesBody } from "../src/link/connection.ts";
import { Channel } from "../src/util/channel.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const consent = { sensitive: false, projectSettings: false };

describe("the numbers of a turn", () => {
  it("come from the SDK's result: the turn's tokens and round trips, the session's running API time and cost", () => {
    const msg = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 9000,
      duration_api_ms: 7000,
      num_turns: 4,
      total_cost_usd: 0.42,
      usage: { input_tokens: 120, output_tokens: 3400, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000 },
    } as unknown as Extract<SDKMessage, { type: "result" }>;
    expect(turnStats(msg, "claude-opus")).toEqual({
      model: "claude-opus",
      inputTokens: 120,
      outputTokens: 3400,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 2_000,
      numTurns: 4,
      apiMsTotal: 7000,
      costUsdTotal: 0.42,
    });
    // Missing or odd values count as 0.
    expect(turnStats({ type: "result", subtype: "success" } as unknown as Extract<SDKMessage, { type: "result" }>, "")).toMatchObject({ inputTokens: 0, numTurns: 0, costUsdTotal: 0 });
  });

  it("go on the turn's item; API time and cost are what the session's totals grew by", async () => {
    const totals: TurnStats[] = [
      { model: "m1", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, numTurns: 2, apiMsTotal: 1000, costUsdTotal: 0.5 },
      { model: "m1", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, numTurns: 1, apiMsTotal: 1600, costUsdTotal: 0.8 },
    ];
    const provider = scripted((turn, events) => {
      events.push({ type: "turn-end", state: "completed", durationMs: 5, ...(totals[turn] ? { stats: totals[turn] } : {}) });
    });
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: "scripted", model: "", dir: work, text: "one", consent, device: "d" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    await core.send(t.id, "two", "c2");
    const items = await until(core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state === TurnState.COMPLETED).length === 2);
    const turns = byCase(items, "turn").map((x) => x.body.value);
    expect(turns[0]).toMatchObject({ model: "m1", inputTokens: 10n, outputTokens: 20n, cacheReadTokens: 30n, cacheWriteTokens: 40n, numTurns: 2, durationApiMs: 1000n, costUsdEstimate: 0.5 });
    expect(turns[1]?.durationApiMs).toBe(600n);
    expect(turns[1]?.costUsdEstimate).toBeCloseTo(0.3);
    await core.stop();
  });

  it("stay empty for an adapter that does not report them", async () => {
    const { core, work } = makeCore([fakeProvider()]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "d" });
    const items = await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    expect(byCase(items, "turn")[0]?.body.value).toMatchObject({ model: "", inputTokens: 0n, numTurns: 0, costUsdEstimate: 0 });
    await core.stop();
  });
});

describe("a subagent's edits", () => {
  it("show as diffs of the subagent, with no tool card of their own", () => {
    const events: ProviderEvent[] = [];
    const mapper = new MessageMapper("/w", (e) => events.push(e));
    mapper.map({
      type: "assistant",
      parent_tool_use_id: "task1",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/w/a.ts", old_string: "x", new_string: "y" } },
          { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/w/a.ts" } },
        ],
      },
    } as unknown as SDKMessage);
    expect(events).toEqual([{ type: "diff", toolId: "e1", path: "a.ts", unified: "--- a/a.ts\n+++ b/a.ts\n@@\n-x\n+y", added: 1, removed: 1, parentToolId: "task1" }]);
  });

  it("keep the model of the conversation's latest reply", () => {
    const mapper = new MessageMapper("/w", () => undefined);
    mapper.map({ type: "assistant", parent_tool_use_id: null, message: { id: "m", model: "claude-x", content: [] } } as unknown as SDKMessage);
    mapper.map({ type: "assistant", parent_tool_use_id: null, message: { id: "n", model: "<synthetic>", content: [] } } as unknown as SDKMessage);
    expect(mapper.model).toBe("claude-x");
  });
});

describe("an approval naming sign-in secrets", () => {
  it("carries each secret with its site to the devices", async () => {
    const provider = scripted(async (turn, events, askUser) => {
      await askUser(
        {
          kind: "approval",
          toolId: `b${turn}`,
          toolKind: "shell",
          name: "Bash",
          summary: "curl",
          input: "{}",
          sensitive: false,
          secrets: [{ name: "GH", origin: "https://github.com" }],
        },
        new AbortController().signal,
      );
      events.push({ type: "turn-end", state: "completed", durationMs: 1 });
    });
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: "scripted", model: "", dir: work, text: "go", consent, device: "d" });
    const items = await until(core, t.id, (i) => byCase(i, "approval").length > 0);
    expect(byCase(items, "approval")[0]?.body.value.secrets.map((s) => [s.name, s.origin])).toEqual([["GH", "https://github.com"]]);
    await core.stop();
  });
});

describe("a question waiting when the service stops", () => {
  async function askedThenStopped(crash = false) {
    const provider = fakeProvider();
    const first = makeCore([provider]);
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "question", consent, device: "d" });
    await until(first.core, t.id, (i) => byCase(i, "question").length > 0);
    if (!crash) await first.core.stop();
    const again = fakeProvider("fake", { starts: [], sent: [], closed: 0 });
    const second = makeCore([again], { dataDir: first.dataDir, home: first.home });
    return { t, first, second, again };
  }

  it("expires (not cancelled), and the next start asks it again; the answer goes to the AI", async () => {
    const { t, first, second, again } = await askedThenStopped();
    const items = second.core.snapshot(t.id);
    const questions = byCase(items, "question");
    expect(questions.map((q) => q.body.value.state)).toEqual([PromptState.EXPIRED, PromptState.PENDING]);
    expect(questions[1]?.body.value.questions[0]?.question).toBe("Pick one?");
    expect(second.core.list().find((x) => x.id === t.id)).toMatchObject({ state: ThreadState.WAITING, pending: 1 });
    const asked = questions[1];
    if (!asked) throw new Error("not asked again");
    second.core.respond(t.id, asked.id, asked.revision, { answers: create(AnswersSchema, { answers: [{ values: ["B"] }] }) }, "d");
    const after = await until(second.core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state === TurnState.COMPLETED).length > 0);
    expect(byCase(after, "question")[1]?.body.value.state).toBe(PromptState.ANSWERED);
    expect(again.log.sent[0]).toContain("Pick one?: B");
    // The same session, resumed.
    expect(again.log.starts[0]?.resumeId).toBe("fake-session-1");
    expect(second.core.list().find((x) => x.id === t.id)?.pending).toBe(0);
    // A third start does not ask an answered question again.
    await second.core.stop();
    const third = makeCore([fakeProvider()], { dataDir: first.dataDir, home: first.home });
    expect(byCase(third.core.snapshot(t.id), "question").filter((q) => q.body.value.state === PromptState.PENDING)).toHaveLength(0);
  });

  it("is asked again after a crash too, and stopping the thread drops it", async () => {
    const { t, second } = await askedThenStopped(true);
    const pending = byCase(second.core.snapshot(t.id), "question").filter((q) => q.body.value.state === PromptState.PENDING);
    expect(pending).toHaveLength(1);
    await second.core.interrupt(t.id);
    expect(byCase(second.core.snapshot(t.id), "question").at(-1)?.body.value.state).toBe(PromptState.CANCELLED);
    expect(second.core.list().find((x) => x.id === t.id)?.state).toBe(ThreadState.IDLE);
  });

  it("an approval expires and is not asked again (its call is gone)", async () => {
    const first = makeCore([fakeProvider()]);
    const t = await first.core.create({ provider: "fake", model: "", dir: first.work, text: "ask ls", consent, device: "d" });
    await until(first.core, t.id, (i) => byCase(i, "approval").length > 0);
    await first.core.stop();
    expect(byCase(first.core.snapshot(t.id), "approval")[0]?.body.value.state).toBe(PromptState.EXPIRED);
    const second = makeCore([fakeProvider()], { dataDir: first.dataDir, home: first.home });
    expect(byCase(second.core.snapshot(t.id), "approval").map((a) => a.body.value.state)).toEqual([PromptState.EXPIRED]);
  });
});

function gitRepo(): string {
  const dir = tempDir("git-changes-");
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
  g("init", "-q");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "app", "gone.txt"), "bye\n");
  writeFileSync(join(dir, "app", ".env"), "KEY=1\n");
  writeFileSync(join(dir, "top.txt"), "top\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return dir;
}

const sensitiveEnv = (p: string) => p.endsWith(".env");

describe("the uncommitted changes of a session's folder", () => {
  it("lists changed, deleted, new and sensitive files below the folder, with their diffs", async () => {
    const repo = gitRepo();
    const app = join(repo, "app");
    writeFileSync(join(app, "a.txt"), "one\nTWO\nthree\n");
    rmSync(join(app, "gone.txt"));
    writeFileSync(join(app, "new.txt"), "fresh\n");
    writeFileSync(join(app, ".env"), "KEY=2\n");
    writeFileSync(join(app, "pic.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "top.txt"), "changed above the folder\n");
    const r = await readGitChanges(app, sensitiveEnv);
    expect(r).toMatchObject({ git: true, truncated: false, partial: false });
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual([".env", "a.txt", "gone.txt", "new.txt", "pic.bin"]);
    expect(byPath.get("a.txt")).toMatchObject({ state: "modified", added: 2, removed: 1, binary: false, sensitive: false });
    expect(byPath.get("a.txt")?.unified).toMatch(/^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@/);
    expect(byPath.get("gone.txt")).toMatchObject({ state: "deleted", removed: 1 });
    expect(byPath.get("new.txt")).toMatchObject({ state: "untracked", added: 1, unified: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+fresh" });
    expect(byPath.get(".env")).toMatchObject({ sensitive: true, unified: "" });
    expect(byPath.get("pic.bin")).toMatchObject({ binary: true, unified: "" });
  });

  it("shortens long diffs in the list and gives one file whole on request", async () => {
    const repo = gitRepo();
    const app = join(repo, "app");
    writeFileSync(join(app, "a.txt"), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    const r = await readGitChanges(app, sensitiveEnv);
    const a = r.files.find((f) => f.path === "a.txt");
    expect(a?.truncated).toBe(true);
    expect(a?.unified.split("\n")).toHaveLength(GIT_LIMITS.listLines);
    const whole = await readGitFileDiff(app, "a.txt", sensitiveEnv);
    expect(whole?.truncated).toBe(false);
    expect(whole?.added).toBe(300);
    expect(whole?.unified.split("\n").length).toBeGreaterThan(300);
    // Only what git lists now; a sensitive file without its content.
    expect(await readGitFileDiff(app, "top.txt", sensitiveEnv)).toBeUndefined();
    expect(await readGitFileDiff(app, "../top.txt", sensitiveEnv)).toBeUndefined();
    writeFileSync(join(app, ".env"), "KEY=3\n");
    expect(await readGitFileDiff(app, ".env", sensitiveEnv)).toMatchObject({ sensitive: true, unified: "" });
  });

  it("caps the number of files and says so", async () => {
    const repo = gitRepo();
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `n${i}.txt`), `${i}\n`);
    const r = await readGitChanges(repo, () => false, { ...GIT_LIMITS, files: 3 });
    expect(r.files).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("lists every file of a repository with no commit yet as new", async () => {
    const dir = tempDir("git-fresh-");
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "x\ny\n");
    execFileSync("git", ["-C", dir, "add", "a.txt"]);
    const r = await readGitChanges(dir, () => false);
    expect(r.files).toEqual([expect.objectContaining({ path: "a.txt", state: "added", added: 2 })]);
  });

  it("outside git there is nothing to list", async () => {
    const r = await readGitChanges(tempDir("no-git-"), () => false);
    expect(r).toEqual({ git: false, files: [], truncated: false, partial: false });
    expect(gitChangesBody("t1", r)).toMatchObject({ threadId: "t1", git: false, files: [] });
  });

  it("parses git's output", () => {
    expect(parsePorcelain(" M a\0?? b c\0D  d\0UU e\0")).toEqual([
      { path: "a", state: "modified" },
      { path: "b c", state: "untracked" },
      { path: "d", state: "deleted" },
      { path: "e", state: "conflicted" },
    ]);
    expect(stateOf("A ")).toBe("added");
    expect(stateOf(" T")).toBe("typeChanged");
    expect(parseNumstat("1\t2\ta b\0-\t-\tbin\0")).toEqual(
      new Map([
        ["a b", { added: 1, removed: 2 }],
        ["bin", null],
      ]),
    );
    const diff = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n";
    expect(splitDiff(diff)).toEqual(
      new Map([
        ["x", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"],
        ["y", "--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-z"],
      ]),
    );
    expect(clipDiff("a\nb\nc", 2, 100)).toEqual({ unified: "a\nb", truncated: true });
    expect(clipDiff("abc", 5, 2)).toEqual({ unified: "ab", truncated: true });
  });

  it("goes to devices with its states, after each turn and when asked", async () => {
    const { core, work } = makeCore([fakeProvider()]);
    execFileSync("git", ["-C", work, "init", "-q"]);
    writeFileSync(join(work, "made.txt"), "by a shell command\n");
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent, device: "d" });
    const ended: string[] = [];
    core.onTurnEnd((id) => ended.push(id));
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    expect(ended).toEqual([t.id]);
    const body = gitChangesBody(t.id, await core.gitChanges(t.id));
    expect(body.files.map((f) => [f.path, f.state])).toEqual([["made.txt", GitFileState.UNTRACKED]]);
    await expect(core.gitFileDiff(t.id, "nope.txt")).rejects.toThrow(/no uncommitted change/);
    expect((await core.gitFileDiff(t.id, "made.txt")).added).toBe(1);
    await core.stop();
  });
});

/**
 * An adapter whose every turn runs `turn` (numbered from 0); a session id
 * like the fake provider's.
 */
function scripted(turn: (n: number, events: Channel<ProviderEvent>, askUser: AskUser) => void | Promise<void>): AgentProvider {
  const base = fakeProvider("scripted");
  let n = 0;
  return {
    ...base,
    async start({ askUser }) {
      const events = new Channel<ProviderEvent>();
      events.push({ type: "session", sessionId: "scripted-1" });
      let chain = Promise.resolve();
      return {
        events,
        async send() {
          const mine = n++;
          chain = chain.then(() => turn(mine, events, askUser));
        },
        async interrupt() {
          // nothing runs long
        },
        async close() {
          await chain;
          events.close();
        },
      };
    },
  };
}

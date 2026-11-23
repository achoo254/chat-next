// How the ingest joins records into rows: the same rows whatever order the
// sources arrive in; a duration worked out from PreToolUse and PostToolUse
// when the hook gives none; the branch of a commit without gitOperation read
// from .git/HEAD; one row for an event that came from the SDK callback and the
// spool; different events of one session never merged; the /clear link; the
// session's row written before its events; unknown events and fields counted,
// never thrown.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runsGitCommit } from "../../src/observatory/ingest/git-commit-command.ts";
import { ObservatoryIngest } from "../../src/observatory/ingest/observatory-ingest.ts";
import { classifyTool } from "../../src/observatory/ingest/tool-classification.ts";
import { StationFlag } from "../../src/observatory/live-map/station-map.ts";
import type { FilteredHookRecord, FilteredOtelRecord, FilteredRecord, RecordOrigin } from "../../src/observatory/privacy/filtered-record.ts";
import { ObservatoryStore, type SessionTimeline } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const HOME = join(obsTempDir("ingest-home"), "home");
const stores: ObservatoryStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

type Rig = { ingest: ObservatoryIngest; store: ObservatoryStore; ops: WriteOp[]; logs: string[]; feed: (records: readonly FilteredRecord[], origin?: RecordOrigin) => Promise<void> };

async function rig(store?: ObservatoryStore): Promise<Rig> {
  const s = store ?? (await ObservatoryStore.open({ path: join(obsTempDir("ingest"), "observatory.db") }));
  if (!store) stores.push(s);
  const ops: WriteOp[] = [];
  const logs: string[] = [];
  const ingest = new ObservatoryIngest({ push: (op) => ops.push(op), home: HOME, log: (l) => logs.push(l), storedLoads: (...key) => s.instructionLoads(...key) });
  const feed = async (records: readonly FilteredRecord[], origin: RecordOrigin = "spool"): Promise<void> => {
    for (const r of records) await ingest.accept(r, origin);
    s.write(ops.splice(0));
  };
  return { ingest, store: s, ops, logs, feed };
}

const hook = (event: string, at: number, f: Record<string, string | number | boolean | string[]>, c?: Record<string, string>): FilteredHookRecord => ({
  v: 1,
  src: "hook",
  event,
  at,
  f: { session_id: "sess-a", cwd: "~/work/app", project_key: "github.com/example/app", ...f },
  ...(c ? { c } : {}),
});
const otel = (event: string, at: number, f: Record<string, string | number | boolean>): FilteredOtelRecord => ({ v: 1, src: "otel", event, at, f: { "session.id": "sess-a", ...f } });

/** A small session from every source: start, prompt, a tool in the main thread and one in a subagent, API calls, the end. */
function session(): FilteredRecord[] {
  return [
    hook("SessionStart", 1_000, { source: "startup", model: "claude-opus-4-5" }),
    hook("UserPromptSubmit", 1_100, { prompt_id: "p1", prompt_length: 12 }, { prompt: "fix the bug" }),
    hook("PreToolUse", 1_200, { prompt_id: "p1", tool_use_id: "t1", tool_name: "Read", target: "src/app.ts", input_bytes: 40 }),
    hook("PostToolUse", 1_260, { prompt_id: "p1", tool_use_id: "t1", tool_name: "Read", target: "src/app.ts", input_bytes: 40, output_bytes: 900, duration_ms: 50 }),
    otel("tool_result", 1_262, { "prompt.id": "p1", tool_use_id: "t1", tool_name: "Read", success: true, duration_ms: 50, tool_input_size_bytes: 41, tool_result_size_bytes: 901 }),
    hook("SubagentStart", 1_300, { prompt_id: "p1", agent_id: "ag1", agent_type: "Explore" }),
    hook("PreToolUse", 1_400, { prompt_id: "p1", agent_id: "ag1", tool_use_id: "t2", tool_name: "Grep", input_bytes: 20 }),
    hook("PostToolUseFailure", 1_480, { prompt_id: "p1", agent_id: "ag1", tool_use_id: "t2", tool_name: "Grep", duration_ms: 70 }, { error: "no such file" }),
    hook("SubagentStop", 1_500, { prompt_id: "p1", agent_id: "ag1", agent_type: "Explore" }),
    otel("subagent_completed", 1_501, { "prompt.id": "p1", agent_id: "ag1", agent_type: "Explore", total_tokens: 900, total_tool_uses: 1, duration_ms: 201, model: "claude-haiku-4-5" }),
    otel("api_request", 1_150, { "prompt.id": "p1", request_id: "r1", model: "claude-opus-4-5", cost_usd: 0.2, input_tokens: 10 }),
    otel("api_request", 1_450, { "prompt.id": "p1", agent_id: "ag1", "event.sequence": 4, model: "claude-haiku-4-5", cost_usd: 0.01 }),
    hook("Stop", 1_600, { prompt_id: "p1" }),
    hook("SessionEnd", 1_700, { reason: "other" }),
  ];
}

describe("records arriving in any order", () => {
  it("make the same rows in order and reversed, OpenTelemetry's exact sizes winning over the hooks' estimates either way", async () => {
    const inOrder = await rig();
    await inOrder.feed(session());
    const reversed = await rig();
    await reversed.feed([...session()].reverse());
    const a = inOrder.store.sessionTimeline("sess-a");
    expect(reversed.store.sessionTimeline("sess-a")).toEqual(a);
    expect(a.session).toMatchObject({ startedAt: 1_000, endedAt: 1_700, mainModel: "claude-opus-4-5", source: "cli", cwd: "~/work/app" });
    expect(a.toolCalls).toEqual([
      expect.objectContaining({ toolUseId: "t1", at: 1_200, durationMs: 50, inputBytes: 41, outputBytes: 901, success: true, agentId: null }),
      expect.objectContaining({ toolUseId: "t2", at: 1_400, durationMs: 70, success: false, error: "failed", agentId: "ag1" }),
    ]);
    // The failure's text is content: in the content column, which the store blocks and clears per project.
    expect(JSON.parse(a.toolCalls[1]?.content ?? "{}")).toEqual({ error: "no such file" });
    expect(a.subagents).toEqual([expect.objectContaining({ agentId: "ag1", startedAt: 1_300, endedAt: 1_501, model: "claude-haiku-4-5", totalTokens: 900, toolCount: 1 })]);
    expect(a.apiRequests.map((r) => [r.dedupeKey.slice(0, 4), r.agentId, r.costUsd])).toEqual([
      ["req:", null, 0.2],
      ["evt:", "ag1", 0.01],
    ]);
  });
});

describe("a tool call without duration_ms", () => {
  it("gets the time between its PreToolUse and PostToolUse, whichever comes first", async () => {
    const pre = hook("PreToolUse", 2_000, { tool_use_id: "t9", tool_name: "Bash", target: "vitest" });
    const post = hook("PostToolUse", 2_250, { tool_use_id: "t9", tool_name: "Bash", target: "vitest" });
    for (const order of [[pre, post], [post, pre]]) {
      const r = await rig();
      await r.feed(order);
      expect(r.store.sessionTimeline("sess-a").toolCalls).toEqual([expect.objectContaining({ toolUseId: "t9", at: 2_000, durationMs: 250, officeRoom: null })]);
    }
  });
});

describe("a commit without gitOperation", () => {
  const commitCall = (cwd: string, command: string): FilteredHookRecord[] => [
    hook("PreToolUse", 3_000, { cwd, prompt_id: "p1", tool_use_id: "tg", tool_name: "Bash", target: "git" }),
    hook("PostToolUse", 3_300, { cwd, prompt_id: "p1", tool_use_id: "tg", tool_name: "Bash", target: "git", duration_ms: 300 }, { tool_input: JSON.stringify({ command, description: "commit" }) }),
  ];

  it("reads the branch from the repository's .git/HEAD (a worktree's own HEAD too), never a sha", async () => {
    const repo = join(HOME, "work", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/observatory\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    const worktree = join(HOME, "work", "repo-wt");
    const wtGitDir = join(repo, ".git", "worktrees", "repo-wt");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/fix/other\n");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

    const r = await rig();
    // The session's folder as the filter keeps it (`~`), deeper than the repository's root.
    await r.feed(commitCall("~/work/repo/src", 'git commit -m "wip"'));
    expect(r.store.sessionTimeline("sess-a").gitOps).toEqual([expect.objectContaining({ kind: "commit", branch: "feature/observatory", sha: null, promptId: "p1" })]);
    // Read again (the same spool line after a failed commit): still one row.
    await r.feed(commitCall("~/work/repo/src", 'git commit -m "wip"'));
    expect(r.store.sessionTimeline("sess-a").gitOps).toHaveLength(1);

    const wt = await rig();
    await wt.feed(commitCall(worktree, "git -C . commit --amend --no-edit"));
    expect(wt.store.sessionTimeline("sess-a").gitOps).toEqual([expect.objectContaining({ branch: "fix/other", sha: null })]);
  });

  it("writes no branch on a detached HEAD, and nothing for a git command that is not a commit", async () => {
    const repo = join(HOME, "work", "detached");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c\n");
    const r = await rig();
    await r.feed(commitCall("~/work/detached", "git commit -m x"));
    expect(r.store.sessionTimeline("sess-a").gitOps).toEqual([expect.objectContaining({ branch: null, sha: null })]);
    const status = await rig();
    await status.feed(commitCall("~/work/detached", "git status && git log --grep commit"));
    expect(status.store.sessionTimeline("sess-a").gitOps).toEqual([]);
  });
});

describe("the same event from two sources", () => {
  /** A session's events as the SDK callback gives them, and as the installed hooks' spool does (a little later). */
  const events = (shift: number): FilteredHookRecord[] => [
    hook("SessionStart", 10 + shift, { source: "startup" }),
    hook("InstructionsLoaded", 20 + shift, { file_path: "~/work/app/CLAUDE.md", memory_type: "Project", load_reason: "session_start" }),
    hook("UserPromptSubmit", 30 + shift, { prompt_id: "p1" }, { prompt: "go" }),
    hook("PreToolUse", 40 + shift, { prompt_id: "p1", tool_use_id: "t1", tool_name: "Edit" }),
    hook("PostToolUse", 60 + shift, { prompt_id: "p1", tool_use_id: "t1", tool_name: "Edit", duration_ms: 20 }),
    hook("SubagentStart", 70 + shift, { prompt_id: "p1", agent_id: "ag1" }),
    hook("PostToolUse", 90 + shift, { prompt_id: "p1", tool_use_id: "t2", tool_name: "Bash", target: "git", git_op: "commit", git_sha: "abc1234", git_branch: "main" }),
    hook("SessionEnd", 100 + shift, { reason: "other" }),
  ];
  const counts = (t: SessionTimeline): number[] => [t.prompts.length, t.toolCalls.length, t.subagents.length, t.instructionsLoaded.length, t.gitOps.length];

  it("is stored once: the spool copy of an SDK session is dropped, and after a restart the store's keys merge it", async () => {
    const r = await rig();
    await r.feed(events(0), "sdk");
    await r.feed(events(300), "spool");
    expect(r.ingest.stats.sdkSpoolSkipped).toBe(8);
    expect(counts(r.store.sessionTimeline("sess-a"))).toEqual([1, 2, 1, 1, 1]);
    // An agent restarted between the two: it no longer knows the session was the SDK's.
    const restarted = await rig(r.store);
    await restarted.feed(events(300), "spool");
    const t = r.store.sessionTimeline("sess-a");
    expect(counts(t)).toEqual([1, 2, 1, 1, 1]);
    expect(t.session).toMatchObject({ source: "sdk", startedAt: 10, endedAt: 400 });
  });

  it("numbers instruction loads on from the store after a restart: a new load is stored, a replayed one is not", async () => {
    const load = (at: number): FilteredHookRecord => hook("InstructionsLoaded", at, { file_path: "~/work/app/CLAUDE.md", memory_type: "Project", load_reason: "compact" });
    const first = await rig();
    await first.feed([load(10)]);
    // Restarted: a fresh ingest on the same database, the same spool line read again, then a load after a second compaction.
    const second = await rig(first.store);
    await second.feed([load(10)]);
    await second.feed([load(20_000)]);
    // The SDK callback's copy of that load, a little earlier than the spool's: the same row.
    await second.feed([load(19_700)], "sdk");
    const seqs = (): [number, number][] => first.store.sessionTimeline("sess-a").instructionsLoaded.map((l) => [l.seq, l.at]);
    expect(seqs()).toEqual([
      [0, 10],
      [1, 20_000],
    ]);
    // Restarted again: everything replayed is still one row each, and a third load gets the next number.
    const third = await rig(first.store);
    await third.feed([load(10), load(20_000), load(40_000)]);
    expect(seqs()).toEqual([
      [0, 10],
      [1, 20_000],
      [2, 40_000],
    ]);
  });

  it("keeps different events of one session apart", async () => {
    const r = await rig();
    await r.feed([
      hook("PreToolUse", 1, { tool_use_id: "t1", tool_name: "Read" }),
      hook("PreToolUse", 1, { tool_use_id: "t2", tool_name: "Read" }),
      hook("SubagentStart", 2, { agent_id: "ag1" }),
      hook("SubagentStart", 2, { agent_id: "ag2" }),
      // The same file for two reasons, and for one reason twice (after a compaction).
      hook("InstructionsLoaded", 3, { file_path: "~/work/app/CLAUDE.md", load_reason: "session_start" }),
      hook("InstructionsLoaded", 3, { file_path: "~/work/app/CLAUDE.md", load_reason: "nested_traversal" }),
      hook("InstructionsLoaded", 9, { file_path: "~/work/app/CLAUDE.md", load_reason: "session_start" }),
      hook("UserPromptSubmit", 4, { prompt_id: "p1" }),
      hook("UserPromptSubmit", 4, { prompt_id: "p2" }),
      hook("Stop", 5, { prompt_id: "p1" }),
      hook("Stop", 5, { prompt_id: "p2" }),
      // A commit then a push of the same sha.
      hook("PostToolUse", 6, { tool_use_id: "t3", tool_name: "Bash", git_op: "commit", git_sha: "abc1234" }),
      hook("PostToolUse", 7, { tool_use_id: "t4", tool_name: "Bash", git_op: "push", git_sha: "abc1234" }),
    ]);
    const t = r.store.sessionTimeline("sess-a");
    expect(counts(t)).toEqual([2, 4, 2, 3, 2]);
    expect(t.instructionsLoaded.map((l) => [l.loadReason, l.seq]).sort()).toEqual([
      ["nested_traversal", 0],
      ["session_start", 0],
      ["session_start", 1],
    ]);
  });
});

describe("/clear", () => {
  const ended = (id: string, at: number, cwd = "~/work/app"): FilteredHookRecord => ({ ...hook("SessionEnd", at, { reason: "clear", cwd }), f: { session_id: id, cwd, reason: "clear" } });
  const started = (id: string, at: number, cwd = "~/work/app"): FilteredHookRecord => ({ ...hook("SessionStart", at, { source: "clear", cwd }), f: { session_id: id, cwd, source: "clear" } });

  it("links the new session to the one it ended, flagged inferred, in either order; another folder is never linked", async () => {
    for (const order of [[ended("old", 1_000), started("new", 1_050)], [started("new", 1_050), ended("old", 1_000)]]) {
      const r = await rig();
      await r.feed(order);
      expect(r.store.sessionTimeline("new").session).toMatchObject({ previousSessionId: "old", previousSessionInferred: true });
      expect(r.store.sessionTimeline("old").session).toMatchObject({ previousSessionId: null, endedAt: 1_000 });
    }
    const apart = await rig();
    await apart.feed([ended("old", 1_000), started("elsewhere", 1_050, "~/work/other"), started("late", 1_000 + 31_000)]);
    expect(apart.store.sessionTimeline("elsewhere").session?.previousSessionId).toBeNull();
    expect(apart.store.sessionTimeline("late").session?.previousSessionId).toBeNull();
  });

  it("never replaces a certain link with its inferred one", async () => {
    const r = await rig();
    r.store.write([{ kind: "session", row: { sessionId: "new", source: "cli", startedAt: 1_050, previousSessionId: "told", previousSessionInferred: false } }]);
    await r.feed([ended("old", 1_000), started("new", 1_050)]);
    expect(r.store.sessionTimeline("new").session).toMatchObject({ previousSessionId: "told", previousSessionInferred: false });
  });
});

describe("the session's row", () => {
  it("is written before the session's events, so a project without content has none stored", async () => {
    const r = await rig();
    r.store.write([{ kind: "contentSetting", row: { projectKey: "github.com/example/app", storeContent: false, updatedAt: 1 } }]);
    await r.ingest.accept(hook("UserPromptSubmit", 5, { prompt_id: "p1" }, { prompt: "secret plans" }), "spool");
    expect(r.ops.map((op) => op.kind)).toEqual(["session", "prompt"]);
    r.store.write(r.ops.splice(0));
    expect(r.store.sessionTimeline("sess-a").prompts).toEqual([expect.objectContaining({ promptId: "p1", excerpt: null })]);
    // Every record writes it again first: the ingest cannot know it is still stored (after a wipe, a dropped write).
    await r.ingest.accept(hook("UserPromptSubmit", 6, { prompt_id: "p2" }), "spool");
    expect(r.ops.map((op) => op.kind)).toEqual(["session", "prompt"]);
  });
});

describe("records the normalizer does not understand", () => {
  it("are counted and logged by name, accepted, and write nothing wrong", async () => {
    const r = await rig();
    const strange: FilteredRecord[] = [
      hook("BrandNewEvent", 1, {}),
      otel("brand_new_event", 1, {}),
      hook("PreToolUse", 2, { tool_use_id: "t1", tool_name: "Read", brand_new_field: "x", duration_ms: 5 }),
      hook("PostToolUse", 3, { tool_use_id: "t1", tool_name: "Read", duration_ms: "slow" }),
      { v: 1, src: "hook", event: "UserPromptSubmit", at: 4, f: { prompt_id: "p1" } },
      hook("PreToolUse", 5, { tool_name: "Read" }),
    ];
    for (const record of strange) await expect(r.ingest.accept(record, "spool")).resolves.toBeUndefined();
    r.store.write(r.ops.splice(0));
    expect(r.ingest.stats).toMatchObject({ records: 6, unknownEvents: 2, missingKeys: 2, unknownFields: 2, mistypedFields: 1, failed: 0 });
    // The duration it could not read is worked out from its Pre and Post instead.
    expect(r.store.sessionTimeline("sess-a").toolCalls).toEqual([expect.objectContaining({ toolUseId: "t1", durationMs: 1 })]);
    expect(r.logs.some((l) => l.includes("BrandNewEvent"))).toBe(true);
    expect(r.logs.some((l) => l.includes("brand_new_field"))).toBe(true);
    // Logged once per name.
    await r.ingest.accept(hook("BrandNewEvent", 6, {}), "spool");
    expect(r.logs.filter((l) => l.includes("BrandNewEvent"))).toHaveLength(1);
  });
});

describe("telling a git commit from the command line", () => {
  it("reads the subcommand after git's global options, in any simple command of the line", () => {
    const commits = ['git commit -m "x"', "git -C repo commit --amend", 'cd app && GIT_AUTHOR_NAME=x git commit -am "y"', "git -c user.name=x commit", "/usr/bin/git commit", "git add . ; git commit -m z"];
    const others = ["git status", "git log --grep commit", "git -C commit status", 'echo "git commit"', "gitk commit", "git"];
    for (const c of commits) expect(runsGitCommit(c), c).toBe(true);
    for (const c of others) expect(runsGitCommit(c), c).toBe(false);
  });
});

describe("the class of a tool call", () => {
  it("is the station the privacy filter worked out, an unknown name read as CORE", () => {
    expect(classifyTool("Bash", "git", { station: "GIT", flags: StationFlag.push })).toEqual({ station: "GIT", stationFlags: StationFlag.push });
    expect(classifyTool("Edit", "rules/a.md", { station: "MEMORY", flags: undefined })).toEqual({ station: "MEMORY", stationFlags: 0 });
    expect(classifyTool("Bash", "x", { station: "SPACESHIP", flags: 0 })).toEqual({ station: "CORE", stationFlags: 0 });
  });

  it("is estimated from the filtered target when the record has no station (an older hook, OpenTelemetry)", () => {
    const est = StationFlag.estimated;
    const cases: [string, string | undefined, string, number, string?][] = [
      ["Read", "src/app.ts", "FILES", 0],
      ["Grep", undefined, "FILES", 0],
      ["WebFetch", "example.com", "EXTERNAL", 0],
      ["Edit", "src/app.ts", "FILES", StationFlag.write],
      ["Write", "~/CLAUDE.md", "MEMORY", StationFlag.write | StationFlag.memory],
      ["Skill", "review", "SKILLS", 0],
      ["TodoWrite", undefined, "ORCHESTRATOR", 0],
      ["Agent", "Explore", "ORCHESTRATOR", 0],
      ["Bash", "vitest", "TESTING", 0],
      ["Bash", "git", "GIT", 0],
      ["Bash", "", "SANDBOX", 0],
      ["mcp__github__create_issue", "github › create_issue", "MCP", 0, "github"],
      ["mcp__tunelo__advisor_weigh", undefined, "MCP", 0, "tunelo"],
      ["SomethingNew", undefined, "CORE", 0],
    ];
    for (const [name, target, station, flags, server] of cases) {
      expect(classifyTool(name, target), name).toEqual({ station, stationFlags: flags | est, ...(server ? { mcpServer: server } : {}) });
    }
  });
});

// An Advisor thread's session reads only, and tunelo decides it: every tool
// call each adapter hears of goes through advisor-guard.ts, refused at once
// (never an approval card, never a prompt waiting) when it is not reading
// inside the folder or one of Advisor's two tools; Claude also starts on none
// of the user's settings and only the reading built-ins.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanUseTool, HookCallback, HookInput, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ThreadState, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ADVISOR_GIT_ONLY, REFUSED_CONTENT_SEARCH, REFUSED_GLOB, REFUSED_OWN_TOOL, REFUSED_PATH, REFUSED_TOOL, advisorGuard } from "../src/advisor/advisor-guard.ts";
import { advisorGitHook, advisorRefusal, createClaudeProvider } from "../src/providers/claude/index.ts";
import { answerPermission, type PermissionContext } from "../src/providers/antigravity/permissions.ts";
import type { AcpPermissionParams } from "../src/providers/acp/acp-session.ts";
import type { AskUser } from "../src/providers/types.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";
import { fakeQuery } from "./fake-sdk.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const posix = process.platform !== "win32"; // Windows cannot create symlinks without Developer Mode.

const signal = new AbortController().signal;
const home = tempDir("advisor-guard-home-");
const dir = join(home, "work");
const isSensitive = createSensitiveCheck({ home });
const ctx = { dir, isSensitive };

describe("the guard", () => {
  it("lets reading and searching inside the folder go on, and Advisor's two tools", () => {
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, "src/a.ts")] }, ctx)).toBeUndefined();
    expect(advisorGuard({ kind: "search", own: "", paths: [] }, ctx)).toBeUndefined();
    expect(advisorGuard({ kind: "search", own: "", paths: ["src"] }, ctx)).toBeUndefined();
    expect(advisorGuard({ kind: "todo", own: "", paths: [] }, ctx)).toBeUndefined();
    expect(advisorGuard({ kind: "mcp", own: "advisor_weigh", paths: [] }, ctx)).toBeUndefined();
    expect(advisorGuard({ kind: "mcp", own: "advisor_git", paths: [] }, ctx)).toBeUndefined();
  });

  it("refuses writing, running, fetching, subagents, other tools of tunelo and other MCP servers", () => {
    for (const kind of ["edit", "shell", "web", "subagent", "other", "mcp"] as const) expect(advisorGuard({ kind, own: "", paths: [] }, ctx)).toBe(REFUSED_TOOL);
    expect(advisorGuard({ kind: "mcp", own: "chat_send_message", paths: [] }, ctx)).toBe(REFUSED_OWN_TOOL);
    expect(advisorGuard({ kind: "mcp", own: "request_secret", paths: [] }, ctx)).toBe(REFUSED_OWN_TOOL);
  });

  it("refuses reading outside the folder, a secret file, or a sensitive folder", () => {
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, ".env")] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, "keys", "id_rsa")] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "read", own: "", paths: ["../other/a.ts"] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "search", own: "", paths: ["/etc"] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "read", own: "", paths: [join(home, ".ssh", "config")] }, ctx)).toBe(REFUSED_PATH);
  });

  it.skipIf(!posix)("follows links: one to a secret file or out of the folder is refused, one inside is read", () => {
    const outside = join(home, "other");
    mkdirSync(outside, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(outside, ".env"), "PASSWORD=x\n");
    writeFileSync(join(outside, "plain.txt"), "x\n");
    writeFileSync(join(dir, "real.txt"), "x\n");
    symlinkSync(join(outside, ".env"), join(dir, "notes.txt"));
    symlinkSync(join(outside, "plain.txt"), join(dir, "plain-link.txt"));
    symlinkSync(outside, join(dir, "linked-dir"));
    symlinkSync(join(dir, "real.txt"), join(dir, "inside-link.txt"));
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, "notes.txt")] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, "plain-link.txt")] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "search", own: "", paths: [join(dir, "linked-dir")] }, ctx)).toBe(REFUSED_PATH);
    expect(advisorGuard({ kind: "read", own: "", paths: [join(dir, "inside-link.txt")] }, ctx)).toBeUndefined();
  });

  it("a search that prints lines is refused; its file filters stay in the folder and name no secret file", () => {
    expect(advisorGuard({ kind: "search", own: "", paths: [], contentSearch: true }, ctx)).toBe(REFUSED_CONTENT_SEARCH);
    expect(advisorGuard({ kind: "search", own: "", paths: [], globs: ["src/**/*.ts"] }, ctx)).toBeUndefined();
    for (const glob of ["**/{.npmrc,credentials,*.pem}", "**/.env*", "../**/*", "/etc/*", "~/x", "**/id_rsa"]) {
      expect(advisorGuard({ kind: "search", own: "", paths: [], globs: [glob] }, ctx)).toBe(REFUSED_GLOB);
    }
  });
});

describe("Claude: an Advisor session", () => {
  const policy = { dir, isSensitive };

  it("reads its tool names and a Glob pattern that leaves the folder", () => {
    expect(advisorRefusal("Read", { file_path: join(dir, "a.ts") }, policy)).toBeUndefined();
    expect(advisorRefusal("Grep", { pattern: "TODO" }, policy)).toBeUndefined();
    expect(advisorRefusal("Glob", { pattern: "**/*.ts" }, policy)).toBeUndefined();
    expect(advisorRefusal("Glob", { pattern: "../../**/*" }, policy)).toBe(REFUSED_PATH);
    expect(advisorRefusal("Glob", { pattern: "/etc/*" }, policy)).toBe(REFUSED_PATH);
    expect(advisorRefusal("Glob", { pattern: "~/.ssh/*" }, policy)).toBe(REFUSED_PATH);
    for (const tool of ["Bash", "Write", "Edit", "ExitPlanMode", "AskUserQuestion", "Task", "WebFetch"]) expect(advisorRefusal(tool, {}, policy)).toBe(REFUSED_TOOL);
    expect(advisorRefusal("mcp__tunelo__advisor_git", { command: "status" }, policy)).toBeUndefined();
    expect(advisorRefusal("mcp__tunelo__chat_send_message", {}, policy)).toBe(REFUSED_OWN_TOOL);
    expect(advisorRefusal("mcp__github__create_issue", {}, policy)).toBe(REFUSED_TOOL);
    expect(advisorRefusal("mcp__tunelo__advisor_grep", { query: "x" }, policy)).toBeUndefined();
  });

  it("Grep: file names and counts only, never lines; no path and no filter that names a secret file", () => {
    expect(advisorRefusal("Grep", { pattern: "PASSWORD|TOKEN|=", output_mode: "content" }, policy)).toBe(REFUSED_CONTENT_SEARCH);
    expect(advisorRefusal("Grep", { pattern: "TOKEN" }, policy)).toBeUndefined();
    expect(advisorRefusal("Grep", { pattern: "TOKEN", output_mode: "files_with_matches" }, policy)).toBeUndefined();
    expect(advisorRefusal("Grep", { pattern: "TOKEN", output_mode: "count" }, policy)).toBeUndefined();
    expect(advisorRefusal("Grep", { pattern: ".", glob: "**/{.npmrc,credentials,*.pem}" }, policy)).toBe(REFUSED_GLOB);
    expect(advisorRefusal("Grep", { pattern: ".", path: ".env" }, policy)).toBe(REFUSED_PATH);
    expect(advisorRefusal("Grep", { pattern: ".", path: "../" }, policy)).toBe(REFUSED_PATH);
  });

  it("through the core: no settings of the user's, only reading built-ins, refusals without a card, the thread never waits", async () => {
    const sdk = fakeQuery();
    const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "claude" });
    provider.detect = async () => ({ installed: true, version: "2.1.319", loginState: "ok" });
    const lease = () => ({ ticket: "t-1", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => undefined });
    const { core, work } = makeCore([provider], { sessionMcp: lease, more: { isKnownFolder: () => true, mcpServers: { github: { command: "gh-mcp" } } } });
    const t = await core.createAdvisor({ provider: "claude", model: "", dir: work, consent: { sensitive: false }, device: "phone" });
    await core.send(t.id, "why?", "q-1", [], { attachments: [], device: "phone" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    const options = sdk.log.options.at(-1);
    if (!options) throw new Error("no session");
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "ToolSearch"]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "ExitPlanMode", "AskUserQuestion"]));
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["tunelo"]);
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();

    const canUseTool = options.canUseTool as CanUseTool;
    const opts = { signal, toolUseID: "tu1" } as Parameters<CanUseTool>[2];
    const decide = (tool: string, input: Record<string, unknown>): Promise<PermissionResult | null> => canUseTool(tool, input, opts);
    for (const [tool, input] of [
      ["Bash", { command: "git push --force" }],
      ["ExitPlanMode", { plan: "do it" }],
      ["Write", { file_path: join(work, "a.ts"), content: "x" }],
      ["AskUserQuestion", { questions: [] }],
      ["Read", { file_path: join(work, ".env") }],
    ] as const) {
      expect(await decide(tool, input)).toMatchObject({ behavior: "deny" });
    }
    expect(await decide("Read", { file_path: join(work, "README.md") })).toMatchObject({ behavior: "allow" });

    const pre = options.hooks?.PreToolUse?.[0];
    expect(pre?.matcher).toBeUndefined();
    const hook = pre?.hooks[0] as HookCallback;
    const input = (tool: string, toolInput: Record<string, unknown>) =>
      ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: work, permission_mode: "bypassPermissions" }) as unknown as HookInput;
    expect(await hook(input("Bash", { command: "ls" }), undefined, { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: REFUSED_TOOL } });
    expect(await hook(input("Grep", { pattern: "x" }), undefined, { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });

    // Nothing ever waited for the user.
    const items = core.snapshot(t.id);
    expect(byCase(items, "approval")).toEqual([]);
    expect(byCase(items, "question")).toEqual([]);
    expect(core.list().find((x) => x.id === t.id)?.state).not.toBe(ThreadState.WAITING);
    await core.stop();
  });

  it("an ordinary session hears advisor_git is not for it, without a card", async () => {
    const run = (tool: string) =>
      advisorGitHook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/w", permission_mode: "default" } as unknown as HookInput, undefined, {
        signal,
      });
    expect(await run("mcp__tunelo__advisor_git")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_GIT_ONLY } });
    expect(await run("mcp__tunelo__advisor_grep")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_GIT_ONLY } });
    expect(await run("Read")).toEqual({});
  });
});

describe("agy: an Advisor session", () => {
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  const params = (name: string, kind: string, rawInput: Record<string, unknown>): AcpPermissionParams => ({ sessionId: "s1", toolCall: { toolCallId: "c1", name, kind, title: name, rawInput }, options });
  const context = (advisorSession: boolean) => {
    let cards = 0;
    const askUser = (async () => {
      cards += 1;
      return { decision: "allow" };
    }) as unknown as AskUser;
    const c: PermissionContext = { dir, askUser, isSensitive, rules: new Set(), onRule: () => undefined, ...(advisorSession ? { advisorSession: true } : {}) };
    return { c, cards: () => cards };
  };

  it("answers every request itself: reading in the folder goes on, the rest is refused, never a card", async () => {
    const { c, cards } = context(true);
    const decide = async (p: AcpPermissionParams) => (await answerPermission(p, c, signal)).outcome;
    expect(await decide(params("view_file", "read", { AbsolutePath: join(dir, "a.ts") }))).toEqual({ outcome: "selected", optionId: "allow" });
    expect(await decide(params("view_file", "read", { AbsolutePath: join(dir, ".env") }))).toEqual({ outcome: "selected", optionId: "deny" });
    expect(await decide(params("run_command", "execute", { CommandLine: "git push" }))).toEqual({ outcome: "selected", optionId: "deny" });
    expect(await decide(params("write_file", "edit", { TargetFile: join(dir, "a.ts") }))).toEqual({ outcome: "selected", optionId: "deny" });
    expect(await decide(params("mcp_tunelo_advisor_git", "other", { command: "status" }))).toEqual({ outcome: "selected", optionId: "allow" });
    expect(await decide(params("mcp_tunelo_chat_send_message", "other", {}))).toEqual({ outcome: "selected", optionId: "deny" });
    // A search printing lines (the default of grep_search) is refused; file names only go on, filters checked.
    expect(await decide(params("grep_search", "search", { Query: "TOKEN", SearchPath: dir }))).toEqual({ outcome: "selected", optionId: "deny" });
    expect(await decide(params("grep_search", "search", { Query: "TOKEN", SearchPath: dir, MatchPerLine: false }))).toEqual({ outcome: "selected", optionId: "allow" });
    expect(await decide(params("grep_search", "search", { Query: "TOKEN", SearchPath: dir, MatchPerLine: false, Includes: ["*.pem"] }))).toEqual({ outcome: "selected", optionId: "deny" });
    expect(await decide(params("mcp_tunelo_advisor_grep", "other", { query: "x" }))).toEqual({ outcome: "selected", optionId: "allow" });
    expect(cards()).toBe(0);
  });

  it("an ordinary session: advisor_git and advisor_grep refused without a card", async () => {
    const { c, cards } = context(false);
    expect((await answerPermission(params("mcp_tunelo_advisor_git", "other", {}), c, signal)).outcome).toEqual({ outcome: "selected", optionId: "deny" });
    expect((await answerPermission(params("mcp_tunelo_advisor_grep", "other", {}), c, signal)).outcome).toEqual({ outcome: "selected", optionId: "deny" });
    expect(cards()).toBe(0);
  });
});

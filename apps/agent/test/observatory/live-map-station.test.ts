// The Live Map station of a tool call from its raw input: every row of the
// table, and the shell command lines that are hard to read (past `cd`,
// package managers, `bash -c`, runners, a deploy script).
import { describe, expect, it } from "vitest";
import { commandClass } from "../../src/activity/command-class.ts";
import { StationFlag, isMemoryPath, stationOf, stationOfTarget } from "../../src/observatory/live-map/station-map.ts";

const { commit, push, deploy, write, memory, estimated } = StationFlag;

describe("stationOf", () => {
  it("places every kind of tool", () => {
    const cases: [string, unknown, string, number][] = [
      ["Read", { file_path: "/w/app/src/a.ts" }, "FILES", 0],
      ["Grep", { pattern: "x" }, "FILES", 0],
      ["Glob", { pattern: "**/*.ts" }, "FILES", 0],
      ["LS", { path: "/w" }, "FILES", 0],
      ["Read", { file_path: "/w/app/CLAUDE.md" }, "FILES", 0],
      ["Edit", { file_path: "/w/app/src/a.ts" }, "FILES", write],
      ["Write", { file_path: "/w/app/src/b.ts" }, "FILES", write],
      ["MultiEdit", { file_path: "/w/app/src/b.ts" }, "FILES", write],
      ["NotebookEdit", { notebook_path: "/w/n.ipynb" }, "FILES", write],
      ["Edit", { file_path: "/w/app/CLAUDE.md" }, "MEMORY", write | memory],
      ["Write", { file_path: "/w/app/.claude/rules/style.md" }, "MEMORY", write | memory],
      ["Write", { file_path: "/home/u/.claude/projects/x/memory/MEMORY.md" }, "MEMORY", write | memory],
      ["Edit", { file_path: "/w/app/.claude/agent-memory/reviewer.md" }, "MEMORY", write | memory],
      ["Edit", { file_path: "C:\\Users\\u\\.claude\\projects\\x\\memory\\notes.md" }, "MEMORY", write | memory],
      ["Edit", { file_path: ".claude/rules/a.md" }, "MEMORY", write | memory],
      ["Bash", { command: "pnpm test" }, "TESTING", 0],
      ["Bash", { command: "git commit -m x" }, "GIT", commit],
      ["Bash", { command: "git push origin main" }, "GIT", push],
      ["Bash", { command: "git status" }, "GIT", 0],
      ["Bash", { command: "gh pr create" }, "GIT", 0],
      ["Bash", { command: "./infra/deploy.sh prod" }, "GIT", deploy],
      ["Bash", { command: "ls -la" }, "SANDBOX", 0],
      ["PowerShell", { command: "Get-ChildItem" }, "SANDBOX", 0],
      ["mcp__tunelo__send_message", {}, "MCP", 0],
      ["mcp__github__create_issue", {}, "MCP", 0],
      ["WebFetch", { url: "https://example.com" }, "EXTERNAL", 0],
      ["WebSearch", { query: "x" }, "EXTERNAL", 0],
      ["Skill", { skill: "review" }, "SKILLS", 0],
      ["Task", { subagent_type: "Explore" }, "ORCHESTRATOR", 0],
      ["Agent", { subagent_type: "Explore" }, "ORCHESTRATOR", 0],
      ["TodoWrite", { todos: [] }, "ORCHESTRATOR", 0],
      ["EnterPlanMode", {}, "ORCHESTRATOR", 0],
      ["ExitPlanMode", { plan: "x" }, "ORCHESTRATOR", 0],
      ["SomethingNew", {}, "CORE", 0],
      ["Edit", "not an object", "FILES", write],
    ];
    for (const [name, input, station, flags] of cases) expect(stationOf(name, input), `${name} ${JSON.stringify(input)}`).toEqual({ station, flags });
  });

  it("reads the command a line really runs", () => {
    const cases: [string, string][] = [
      ["cd apps/web && pnpm run test", "check"],
      ["pnpm --filter @x/agent test", "check"],
      ['bash -c "npx vitest run"', "check"],
      ["npx vitest", "check"],
      ["go test ./...", "check"],
      ["go build ./...", "shell"],
      ["git -C ../repo commit -m x", "commit"],
      ["git push", "push"],
      ["git log --oneline", "git"],
      ["rsync -a dist/ host:/srv", "deploy"],
      ["pnpm deploy:web", "deploy"],
      ["make deploy", "deploy"],
      ["echo hi", "shell"],
      ["", "shell"],
    ];
    for (const [line, cls] of cases) expect(commandClass(line), line).toBe(cls);
  });
});

describe("isMemoryPath", () => {
  it("knows instruction and memory files, not files that merely look alike", () => {
    for (const p of ["CLAUDE.md", "a/CLAUDE.md", "MEMORY.md", ".claude/rules/x.md", "a\\.claude\\agent-memory\\b.md", "x/memory/y.md"]) expect(isMemoryPath(p), p).toBe(true);
    for (const p of ["CLAUDE.md.bak", "src/memory.ts", "docs/rules/x.md", "a/memorybank/y.md"]) expect(isMemoryPath(p), p).toBe(false);
  });
});

describe("stationOfTarget", () => {
  it("places a call by its filtered target, flagged estimated", () => {
    expect(stationOfTarget("Bash", "vitest")).toEqual({ station: "TESTING", flags: estimated });
    expect(stationOfTarget("Bash", "git")).toEqual({ station: "GIT", flags: estimated });
    expect(stationOfTarget("Edit", "app/CLAUDE.md")).toEqual({ station: "MEMORY", flags: write | memory | estimated });
    expect(stationOfTarget("Read", undefined)).toEqual({ station: "FILES", flags: estimated });
  });
});

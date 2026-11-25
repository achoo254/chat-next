// The Live Map station of a tool call from its raw input: every row of the
// table, and the shell command lines that are hard to read (past `cd`,
// package managers, `bash -c`, runners, a deploy script).
import { describe, expect, it } from "vitest";
import { commandClass } from "../../src/activity/command-class.ts";
import { StationFlag, isMemoryPath, stationOf, stationOfTarget } from "../../src/observatory/live-map/station-map.ts";

const { commit, push, deploy, write, memory, estimated, ci } = StationFlag;

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
      ["Bash", { command: "gh run watch" }, "GIT", ci],
      ["Bash", { command: "gh pr checks 12" }, "GIT", ci],
      ["Bash", { command: "glab ci status" }, "GIT", ci],
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
    // The wire field is a uint32: the CI bit is the next free one.
    expect(ci).toBe(128);
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
      ["gh run watch", "ci"],
      ["gh run view 123 --log-failed", "ci"],
      ["gh run list --limit 5", "ci"],
      ["gh run rerun 123 --failed", "ci"],
      ["gh pr checks 12", "ci"],
      ["gh pr checks --watch", "ci"],
      ["gh pr create --fill", "git"],
      ["gh pr view 12", "git"],
      ["gh run download 123", "git"],
      ["gh api repos/x/y", "git"],
      ["glab ci status", "ci"],
      ["glab ci view", "ci"],
      ["glab pipeline list", "ci"],
      ["glab mr create", "shell"],
      ["rsync -a dist/ host:/srv", "deploy"],
      ["pnpm deploy:web", "deploy"],
      ["make deploy", "deploy"],
      ["echo hi", "shell"],
      ["", "shell"],
    ];
    for (const [line, cls] of cases) expect(commandClass(line), line).toBe(cls);
  });
});

describe("a shell call started in the background", () => {
  it("carries the background flag, whatever station its command is at", () => {
    expect(stationOf("Bash", { command: "npm run dev", run_in_background: true })).toEqual({ station: "SANDBOX", flags: 64 });
    expect(stationOf("PowerShell", { command: "pnpm test", run_in_background: true })).toEqual({ station: "TESTING", flags: 64 });
    expect(stationOf("Bash", { command: "npm run dev", run_in_background: false })).toEqual({ station: "SANDBOX", flags: 0 });
    // Reading or ending a shell is not starting one.
    expect(stationOf("BashOutput", { run_in_background: true }).flags).toBe(0);
  });
});

describe("a chained shell line", () => {
  it("keeps the flags of every command it chains", () => {
    expect(stationOf("Bash", { command: "git add -A && git commit -m x" })).toEqual({ station: "GIT", flags: commit });
    expect(stationOf("Bash", { command: "git commit -m x && git push" })).toEqual({ station: "GIT", flags: commit | push });
    expect(stationOf("Bash", { command: "git push && gh run watch" })).toEqual({ station: "GIT", flags: push | ci });
    expect(stationOf("Bash", { command: "pnpm test && gh pr checks 12 --watch" })).toEqual({ station: "GIT", flags: ci });
    expect(stationOf("Bash", { command: "npm run build && npm run deploy" })).toEqual({ station: "GIT", flags: deploy });
    expect(stationOf("Bash", { command: "pnpm lint; pnpm test" })).toEqual({ station: "TESTING", flags: 0 });
    expect(stationOf("Bash", { command: "cat a.log | grep error" })).toEqual({ station: "SANDBOX", flags: 0 });
  });

  it("knows the common deploy tools", () => {
    for (const command of ["wrangler deploy", "fly deploy", "vercel --prod", "kubectl apply -f k8s.yaml", "docker push img:1", "helm upgrade app ./chart"]) {
      expect(stationOf("Bash", { command }), command).toEqual({ station: "GIT", flags: deploy });
    }
    for (const command of ["wrangler dev", "kubectl get pods", "docker build ."]) expect(stationOf("Bash", { command }).station, command).toBe("SANDBOX");
  });

  it("reads a heredoc of megabytes in bounded time", () => {
    const command = `cat <<'EOF' > big.txt\n${"x ".repeat(1_000_000)}\nEOF`;
    const t = performance.now();
    expect(stationOf("Bash", { command }).station).toBe("SANDBOX");
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("isMemoryPath", () => {
  it("knows instruction and memory files, not files that merely look alike", () => {
    for (const p of ["CLAUDE.md", "a/claude.md", "a/CLAUDE.local.md", "MEMORY.md", ".claude/rules/x.md", "a\\.claude\\agent-memory\\b.md", "x/memory/y.md"]) expect(isMemoryPath(p), p).toBe(true);
    for (const p of ["CLAUDE.md.bak", "src/memory.ts", "src/memory/cache.ts", "docs/rules/x.md", "a/memorybank/y.md"]) expect(isMemoryPath(p), p).toBe(false);
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

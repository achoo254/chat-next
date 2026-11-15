// The office's rooms: every row of the tool table and of the command table
// in docs/office-wire.md, part 4.
import { OfficeAnimGroup, OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { classifyActivity, classifyCommand, commandHead } from "../src/office/office-activity-map.ts";
import { toolKind } from "../src/providers/claude/tool-map.ts";

const place = (name: string, command?: string) => classifyActivity({ kind: toolKind(name), name, ...(command !== undefined ? { command } : {}) });

describe("rooms by tool", () => {
  it.each([
    ["Read", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["NotebookRead", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["Grep", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["Glob", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["LS", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["LSP", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["ToolSearch", OfficeAnimGroup.READ, OfficeRoom.LIBRARY],
    ["WebFetch", OfficeAnimGroup.PHONE, OfficeRoom.LIBRARY],
    ["WebSearch", OfficeAnimGroup.PHONE, OfficeRoom.LIBRARY],
    ["Write", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
    ["Edit", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
    ["MultiEdit", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
    ["NotebookEdit", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
    ["TodoWrite", OfficeAnimGroup.TYPE, OfficeRoom.PLANNING],
    ["mcp__github__create_issue", OfficeAnimGroup.TYPE, OfficeRoom.POST],
    ["mcp__tunelo__chat_send", OfficeAnimGroup.TYPE, OfficeRoom.LOBBY],
    ["Agent", OfficeAnimGroup.ARRIVE, OfficeRoom.LOBBY],
    ["Task", OfficeAnimGroup.ARRIVE, OfficeRoom.LOBBY],
    ["Skill", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
    ["SomethingNew", OfficeAnimGroup.TYPE, OfficeRoom.WORK],
  ])("%s", (name, group, room) => {
    expect(place(name)).toEqual({ group, room });
  });

  it("shell tools stand at a machine, in the room of their command", () => {
    for (const name of ["Bash", "PowerShell", "Monitor", "BashOutput", "KillShell"]) {
      expect(place(name, "git push").group).toBe(OfficeAnimGroup.MACHINE);
    }
    expect(place("Bash", "git push").room).toBe(OfficeRoom.POST);
    expect(place("Bash", "pnpm test").room).toBe(OfficeRoom.QA);
    expect(place("Bash", "ls -la").room).toBe(OfficeRoom.SERVER);
    expect(place("Bash").room).toBe(OfficeRoom.SERVER);
  });

  it("Antigravity's kinds land in the same rooms", () => {
    expect(classifyActivity({ kind: "shell", name: "run_command", command: "go test ./..." })).toEqual({ group: OfficeAnimGroup.MACHINE, room: OfficeRoom.QA });
    expect(classifyActivity({ kind: "web", name: "search_web" }).room).toBe(OfficeRoom.LIBRARY);
    expect(classifyActivity({ kind: "mcp", name: "server__tool" }).room).toBe(OfficeRoom.POST);
  });
});

describe("rooms by command", () => {
  it.each([
    // POST: git, gh, copies to other hosts, deploys
    ["git status", OfficeRoom.POST],
    ["git push origin main", OfficeRoom.POST],
    ["gh pr create --fill", OfficeRoom.POST],
    ["rsync -a dist/ host:/srv/app", OfficeRoom.POST],
    ["scp build.tgz host:", OfficeRoom.POST],
    ["./infra/deploy.sh prod", OfficeRoom.POST],
    ["pnpm run deploy:web", OfficeRoom.POST],
    ["/usr/bin/git log --oneline", OfficeRoom.POST],
    ["git.exe status", OfficeRoom.POST],
    // QA: tests, lint, typecheck
    ["pnpm test", OfficeRoom.QA],
    ["pnpm run test", OfficeRoom.QA],
    ["npm run typecheck", OfficeRoom.QA],
    ["yarn lint:fix", OfficeRoom.QA],
    ["pnpm --filter @app/web test", OfficeRoom.QA],
    ["pnpm -r --if-present test", OfficeRoom.QA],
    ["bun test", OfficeRoom.QA],
    ["npx vitest run test/a.test.ts", OfficeRoom.QA],
    ["npx tsc --noEmit", OfficeRoom.QA],
    ["vitest", OfficeRoom.QA],
    ["jest --watch=false", OfficeRoom.QA],
    ["pytest -q", OfficeRoom.QA],
    ["python -m pytest tests", OfficeRoom.QA],
    ["eslint . --max-warnings=0", OfficeRoom.QA],
    ["go test ./...", OfficeRoom.QA],
    ["cargo test --all", OfficeRoom.QA],
    // SERVER: everything else
    ["ls -la", OfficeRoom.SERVER],
    ["pnpm install", OfficeRoom.SERVER],
    ["node scripts/build.ts", OfficeRoom.SERVER],
    ["go build ./...", OfficeRoom.SERVER],
    ["frobnicate --all", OfficeRoom.SERVER],
    ["", OfficeRoom.SERVER],
  ])("%s", (command, room) => {
    expect(classifyCommand(command)).toBe(room);
  });

  it("takes the first command of a compound one", () => {
    expect(classifyCommand("git add -A && pnpm test")).toBe(OfficeRoom.POST);
    expect(classifyCommand("pnpm test; git push")).toBe(OfficeRoom.QA);
    expect(classifyCommand("pnpm lint || true")).toBe(OfficeRoom.QA);
    expect(classifyCommand("ls | grep test")).toBe(OfficeRoom.SERVER);
    expect(classifyCommand("cd app\ngit status")).toBe(OfficeRoom.SERVER);
  });

  it("skips environment assignments and runners in front", () => {
    expect(classifyCommand("CI=1 NODE_ENV=test pnpm test")).toBe(OfficeRoom.QA);
    expect(classifyCommand("sudo git pull")).toBe(OfficeRoom.POST);
    expect(classifyCommand("env FOO=1 git status")).toBe(OfficeRoom.POST);
    expect(classifyCommand("time npx tsc -p .")).toBe(OfficeRoom.QA);
  });
});

describe("a command's first word", () => {
  it("drops assignments, sudo and the program's folder", () => {
    expect(commandHead("FOO=1 BAR=2 pnpm test")).toBe("pnpm");
    expect(commandHead("sudo /usr/local/bin/git status")).toBe("git");
    expect(commandHead("C:\\tools\\node.exe x.js")).toBe("node");
    expect(commandHead("")).toBe("");
  });
});

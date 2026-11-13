// A commit message written by an AI of the machine for what a workspace has
// staged, against real repositories and a stand-in AI: the AI reads the
// staged list and patch (a secret file by name, never its content), each file
// gets its share of the patch budget, the AI is the one the device names
// (there is no default), and failures come back as reasons a device can say.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { writerArgs } from "../src/providers/claude/one-shot-writer.ts";
import type { AgentProvider, Detected, WriteRequest } from "../src/providers/types.ts";
import { cleanMessage, writeCommitMessage } from "../src/workspace/commit-message.ts";
import { argBatches, shareBudget } from "../src/workspace/git-ops.ts";
import { tempDir } from "./harness.ts";
import { commitAll, git, reasonOf, repo, workspaces } from "./support/workspace-fixture.ts";

const stageAll = (dir: string) => git(dir, "add", "--all");

function setup() {
  const dir = repo(join(tempDir("ws-msg-"), "work"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  commitAll(dir, "first");
  return { dir, ...workspaces({ w: dir }) };
}

/** A stand-in AI that records what it was asked and answers `answer`. */
function fakeAi(id: string, answer: string | Error, opts: { writer?: boolean } = {}) {
  const asked: WriteRequest[] = [];
  const provider = {
    id,
    name: `AI ${id}`,
    ...(opts.writer === false
      ? {}
      : {
          writer: {
            write: (req: WriteRequest) => {
              asked.push(req);
              return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
            },
          },
        }),
  } as unknown as AgentProvider;
  return { provider, asked };
}

const ok: Detected = { installed: true, loginState: "ok" };

describe("the staged changes an AI reads", () => {
  it("lists every staged file and shows the patch of all but secret files", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, ".env"), "TOKEN=hunter2\n");
    stageAll(dir);
    const staged = await ws.stagedChanges("w");
    expect(staged.files.split("\n")).toEqual(["A\t.env (secret file: content not shown)", "M\ta.txt"]);
    expect(staged.patch).toContain("+changed");
    expect(staged.patch).not.toContain("hunter2");
  });

  it("says nothing is staged when only secret files, or none, are", async () => {
    const { ws, dir } = setup();
    expect((await reasonOf(ws.stagedChanges("w"))).reason).toBe(ErrorReason.NOTHING_STAGED);
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    stageAll(dir);
    expect((await reasonOf(ws.stagedChanges("w"))).reason).toBe(ErrorReason.NOTHING_STAGED);
  });

  it("splits many paths into command lines Windows can run", () => {
    expect(argBatches(["aaaa", "bbbb", "cccc", "d".repeat(20)], 10)).toEqual([["aaaa", "bbbb"], ["cccc"], ["d".repeat(20)]]);
  });

  it("shares the patch budget so one large file cannot take it all", () => {
    const small = "diff --git a/s b/s\n+small\n";
    const large = `diff --git a/l b/l\n${"+x\n".repeat(1000)}`;
    const out = shareBudget(large + small, 400);
    expect(out).toContain(small);
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("cut: this file's change is longer");
    expect(out.indexOf("a/l")).toBeLessThan(out.indexOf("a/s"));
  });
});

describe("writing the message", () => {
  const deps = (providers: AgentProvider[], ws: ReturnType<typeof setup>["ws"], detected: Detected = ok) => ({
    providers,
    staged: (id: string) => ws.stagedChanges(id),
    detect: () => Promise.resolve(detected),
    account: () => ({ id: "work", dir: "/profiles/work" }),
  });

  it("asks the AI the device names, as the picked account, and cleans its answer", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    stageAll(dir);
    const first = fakeAi("first", "never asked");
    const named = fakeAi("other", "```\nfix: change a\n```");
    const message = await writeCommitMessage(deps([first.provider, named.provider], ws), { workspaceId: "w", provider: "other", model: "" });
    expect(message).toBe("fix: change a");
    expect(first.asked).toEqual([]);
    expect(named.asked).toHaveLength(1);
    expect(named.asked[0]).toMatchObject({ account: { id: "work", dir: "/profiles/work" } });
    expect(named.asked[0]?.model).toBeUndefined();
    expect(named.asked[0]?.prompt).toContain("M\ta.txt");
  });

  it("has no default AI, and says which AI cannot or is not ready", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    stageAll(dir);
    const ai = fakeAi("a", "fix: x");
    const mute = fakeAi("mute", "", { writer: false });
    const failing = fakeAi("f", new Error("rate limited"));
    expect((await reasonOf(writeCommitMessage(deps([ai.provider], ws), { workspaceId: "w", provider: "", model: "" }))).reason).toBe(ErrorReason.PROVIDER_REQUIRED);
    expect((await reasonOf(writeCommitMessage(deps([mute.provider], ws), { workspaceId: "w", provider: "mute", model: "" }))).reason).toBe(ErrorReason.UNSUPPORTED_REQUEST);
    expect((await reasonOf(writeCommitMessage(deps([ai.provider], ws, { installed: false, loginState: "unknown" }), { workspaceId: "w", provider: "a", model: "" }))).reason).toBe(ErrorReason.AI_NOT_INSTALLED);
    expect((await reasonOf(writeCommitMessage(deps([ai.provider], ws, { installed: true, loginState: "needs-login" }), { workspaceId: "w", provider: "a", model: "" }))).reason).toBe(ErrorReason.AI_NEEDS_LOGIN);
    const failed = await reasonOf(writeCommitMessage(deps([failing.provider], ws), { workspaceId: "w", provider: "f", model: "" }));
    expect(failed).toMatchObject({ reason: ErrorReason.AI_START_FAILED, subject: "rate limited" });
    expect(ai.asked).toEqual([]);
  });

  it("drops quotes and code fences around an answer", () => {
    expect(cleanMessage('  "feat: add x"  ')).toBe("feat: add x");
    expect(cleanMessage("```text\nfeat: add x\n\nbody\n```")).toBe("feat: add x\n\nbody");
    expect(cleanMessage("feat: keep \"quotes\" inside")).toBe('feat: keep "quotes" inside');
  });

  it("runs Claude with no tool, setting, MCP server, command or saved session", () => {
    const args = writerArgs("haiku");
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  });
});

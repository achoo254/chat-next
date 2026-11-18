// Git for Advisor, against real repositories: a failed git write of a
// workspace is kept for 10 minutes with git's whole output and named to the
// device by a failure id (the refused push of a diverged branch keeps what
// git said too); advisor_git reads with bounded arguments through the
// workspaces' runner, never shows a secret file's content, never runs a
// program the repository's config names, and only in an Advisor thread.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { gitArgs, registerAdvisorGitTool, registerAdvisorGrepTool, runAdvisorGit, runAdvisorGrep, unquoteGitName, withoutSecretFiles } from "../src/advisor/advisor-git-tool.ts";
import { FAILURE_TTL_MS, GitFailureMemory } from "../src/advisor/git-failure-memory.ts";
import { AgentError } from "../src/core/agent-core.ts";
import { errorBody } from "../src/link/connection.ts";
import { ToolTable } from "../src/mcp/groups.ts";
import { gitRunner } from "../src/workspace/git-run.ts";
import { tempDir } from "./harness.ts";
import { TEST_GIT_CONFIG, commitAll, git, repo, workspaces } from "./support/workspace-fixture.ts";

const posix = process.platform !== "win32"; // Windows cannot create symlinks without Developer Mode.

const textOf = (r: { content: { type: string; text?: string }[] }): string => r.content.map((c) => c.text ?? "").join("");

/** A workspace with a remote, and another clone that pushed first: the workspace's own commit cannot be pushed. */
function diverged(now?: () => number) {
  const base = tempDir("adv-git-");
  const dir = repo(join(base, "work"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  commitAll(dir, "first");
  const bare = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", bare, other]);
  writeFileSync(join(other, "b.txt"), "theirs\n");
  commitAll(other, "theirs");
  git(other, "push", "-q");
  writeFileSync(join(dir, "c.txt"), "ours\n");
  commitAll(dir, "ours");
  return { dir, ...workspaces({ w: dir }, now ? { now } : {}) };
}

describe("a failed git write, kept for Advisor", () => {
  it("names the failure to the device and keeps git's whole output, also when the push is refused as diverged", async () => {
    let now = 1_000_000;
    const { ws, dir } = diverged(() => now);
    const err = await ws.push("w", "dev").then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof AgentError)) throw new Error("the push did not fail");
    expect(err.reason).toBe(ErrorReason.GIT_DIVERGED);
    const id = err.failureId ?? "";
    expect(id).not.toBe("");
    expect(errorBody(err)).toMatchObject({ reason: ErrorReason.GIT_DIVERGED, failureId: id });
    const kept = ws.failures.get(id);
    expect(kept).toMatchObject({ workspaceId: "w", action: "git_push", root: dir });
    // git's own words, more than its last line.
    expect(kept?.output).toMatch(/rejected/);
    expect(kept?.output.split("\n").filter((l) => l.trim() !== "").length).toBeGreaterThan(1);
    now += FAILURE_TTL_MS;
    expect(ws.failures.get(id)).toBeUndefined();
  });

  it("a write refused before git printed anything keeps the refusal's own words; a read is never kept", async () => {
    const { ws } = diverged();
    const err = await ws.branchCreate("w", "bad..name", "", false, "dev").then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof AgentError)) throw new Error("the branch was made");
    expect(ws.failures.get(err.failureId ?? "")?.output).toContain(err.message);
    const read = await ws.log("w", "no-such-branch", 0, 5).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(read instanceof AgentError && read.failureId).toBeFalsy();
  });

  it("forgets the oldest past its size and never takes a malformed id", () => {
    const m = new GitFailureMemory();
    const first = m.record({ workspaceId: "w", root: "/r", action: "git_push", output: "x" });
    for (let i = 0; i < 60; i++) m.record({ workspaceId: "w", root: "/r", action: "git_push", output: String(i) });
    expect(m.get(first)).toBeUndefined();
    expect(m.get("../etc")).toBeUndefined();
  });
});

describe("advisor_git", () => {
  /** An empty hooks folder of the test's own, as the service keeps one. */
  const hooks = () => {
    const d = join(tempDir("adv-hooks-"), "empty");
    mkdirSync(d, { recursive: true });
    return d;
  };

  function project() {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, ".env"), "API_TOKEN=first\n");
    commitAll(dir, "first");
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, ".env"), "API_TOKEN=second-value-that-is-secret\n");
    return dir;
  }

  it("reads status, log, diff, show and branches in the folder; a secret file's content is never shown", async () => {
    const dir = project();
    const hooksDir = hooks();
    const run = gitRunner({ hooksDir, extraConfig: TEST_GIT_CONFIG });
    const status = textOf(await runAdvisorGit(run, dir, { command: "status" }));
    expect(status).toContain("## main");
    expect(status).toContain("a.txt");
    const diff = textOf(await runAdvisorGit(run, dir, { command: "diff" }));
    expect(diff).toContain("+two");
    expect(diff).toContain("diff --git a/.env b/.env");
    expect(diff).not.toContain("second-value");
    expect(diff).not.toContain(dir);
    const log = textOf(await runAdvisorGit(run, dir, { command: "log", limit: 1 }));
    expect(log).toContain("first");
    const show = textOf(await runAdvisorGit(run, dir, { command: "show", ref: "HEAD" }));
    expect(show).toContain("+one");
    expect(show).not.toContain("API_TOKEN=first");
    expect(textOf(await runAdvisorGit(run, dir, { command: "branch" }))).toContain("main");
  });

  it("never runs a program the repository's config names (a textconv driver) and refuses options, file reads and paths outside", async () => {
    const dir = project();
    const marker = join(dir, "..", "textconv-ran");
    git(dir, "config", "diff.mine.textconv", `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=mine\n");
    const hooksDir = hooks();
    const run = gitRunner({ hooksDir, extraConfig: TEST_GIT_CONFIG });
    await runAdvisorGit(run, dir, { command: "diff" });
    await runAdvisorGit(run, dir, { command: "show" });
    expect(existsSync(marker)).toBe(false);
    for (const args of [
      { command: "log" as const, ref: "--output=/tmp/x" },
      { command: "show" as const, ref: "HEAD:.env" },
      { command: "diff" as const, path: "../other" },
      { command: "diff" as const, path: ".env" },
      { command: "log" as const, path: "/etc/passwd" },
    ]) {
      expect(typeof gitArgs(args)).toBe("string");
      expect((await runAdvisorGit(run, dir, args)).isError).toBe(true);
    }
    expect(gitArgs({ command: "log", ref: "origin/main..HEAD", path: "src/a.ts", limit: 5 })).toEqual([
      "log",
      "--max-count=5",
      "--date=short",
      "--format=%h %ad %an%d %s",
      "--no-color",
      "origin/main..HEAD",
      "--",
      "src/a.ts",
    ]);
  });

  it.skipIf(!posix)("advisor_grep: matching lines of the folder, never a secret file, a file in a sensitive folder or a link out of the folder", async () => {
    const outside = tempDir("adv-outside-");
    writeFileSync(join(outside, ".env"), "NEEDLE_PASSWORD=hunter2\n");
    writeFileSync(join(outside, "notes.txt"), "NEEDLE outside\n");
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "NEEDLE in a\n");
    writeFileSync(join(dir, ".npmrc"), "//registry/:_authToken=NEEDLE-abc\n");
    writeFileSync(join(dir, ".env"), "NEEDLE=short\n");
    mkdirSync(join(dir, "private"));
    writeFileSync(join(dir, "private", "x.txt"), "NEEDLE private\n");
    symlinkSync(join(outside, ".env"), join(dir, "docs-notes.txt"));
    symlinkSync(join(outside, "notes.txt"), join(dir, "linked.txt"));
    commitAll(dir, "files");
    const run = gitRunner({ hooksDir: hooks(), extraConfig: TEST_GIT_CONFIG });
    const isSensitive = (p: string) => p.startsWith(join(dir, "private"));
    const out = textOf(await runAdvisorGrep(run, dir, { query: "NEEDLE" }, isSensitive));
    expect(out).toContain("a.txt:1: NEEDLE in a");
    for (const leak of ["hunter2", "_authToken", "short", "private", "outside", dir]) expect(out).not.toContain(leak);
    expect(textOf(await runAdvisorGrep(run, dir, { query: "nothing-like-this" }, isSensitive))).toBe("(no match)");
  });

  it("outside a git work tree: git's refusal, no machine path", async () => {
    const dir = tempDir("adv-plain-");
    const hooksDir = hooks();
    const r = await runAdvisorGit(gitRunner({ hooksDir }), dir, { command: "status" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not a git work tree");
    expect(textOf(r)).not.toContain(dir);
  });

  it("only in an Advisor thread", async () => {
    const table = new ToolTable();
    const hooks = { sessionDir: () => undefined, git: async () => Promise.reject(new Error("never")), isSensitive: () => false };
    registerAdvisorGitTool(table, { hooks, threadId: "t1" });
    registerAdvisorGrepTool(table, { hooks, threadId: "t1" });
    const r = await table.call("advisor_git", { command: "status" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("only for Advisor's own session");
    const g = await table.call("advisor_grep", { query: "x" });
    expect(g.isError).toBe(true);
    expect(textOf(g)).toContain("advisor_grep is only for Advisor's own session");
  });

  it("a merge commit shows against its first parent: a secret file changed on both sides still shows no content", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".env"), "TOKEN=base\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    commitAll(dir, "base");
    git(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, ".env"), "TOKEN=side-secret-value\n");
    commitAll(dir, "side");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, ".env"), "TOKEN=main-secret-value\n");
    commitAll(dir, "main");
    try {
      git(dir, "merge", "-q", "--no-edit", "side");
    } catch {
      writeFileSync(join(dir, ".env"), "TOKEN=merged-secret-value\n");
      commitAll(dir, "merge");
    }
    const show = textOf(await runAdvisorGit(gitRunner({ hooksDir: hooks(), extraConfig: TEST_GIT_CONFIG }), dir, { command: "show", ref: "HEAD" }));
    expect(show).not.toMatch(/secret-value/);
    expect(show).not.toContain("diff --cc");
  });

  it("drops each secret file's part of a diff, quoted names and combined diffs included; a header it cannot read hides its part", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "+x",
      "diff --git a/config/.env.local b/config/.env.local",
      "+SECRET=1",
      'diff --git "a/sp\\303\\251c\\t/.env" "b/sp\\303\\251c\\t/.env"',
      "+QUOTED=1",
      "diff --cc .env",
      "+COMBINED=1",
      'diff --git "a/odd\\q" b/x',
      "+UNREADABLE=1",
      "diff --weird thing",
      "+STRANGE=1",
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "+cafe",
      "diff --git a/b.txt b/b.txt",
      "+y",
    ].join("\n");
    const out = withoutSecretFiles(diff);
    expect(out).toContain("+x");
    expect(out).toContain("+y");
    expect(out).toContain("+cafe");
    for (const hidden of ["SECRET", "QUOTED", "COMBINED", "UNREADABLE", "STRANGE"]) expect(out).not.toContain(hidden);
    expect(unquoteGitName('"sp\\303\\251c\\t/.env"')).toBe("spéc\t/.env");
    expect(unquoteGitName('"bad\\q"')).toBeUndefined();
  });
});

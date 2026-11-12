// Source Control on a workspace, against real repositories: status read
// from porcelain v2 (renames, conflicts, untracked, the 1000 cap), stage,
// unstage, discard (untracked files to the trash), commit with no hook ever
// run, branches, fetch, pull and push against a local bare repository, log,
// what a branch committed since its base, diffs and the pull request page.
// A repository whose own config names a program is refused before any
// write or network command, and reads run with those programs off. Nothing
// a file holds, no path and no commit message reaches the consent log.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseRiskyConfig } from "../src/workspace/git-run.ts";
import { parseBranches, parseLog, parseNameStatus, prLink, remoteRepo } from "../src/workspace/git-ops.ts";
import { parseNumstatZ, parseStatusV2 } from "../src/workspace/git-status.ts";
import { tempDir } from "./harness.ts";
import { TEST_GIT_CONFIG, commitAll, git, reasonOf, repo, workspaces } from "./support/workspace-fixture.ts";

const posix = process.platform !== "win32";

/** A workspace "w" with one commit (a.txt, b.txt). */
function setup(extra: Parameters<typeof workspaces>[1] = {}) {
  const base = tempDir("ws-git-");
  const dir = repo(join(base, "work"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  commitAll(dir, "first");
  return { base, dir, ...workspaces({ w: dir }, extra) };
}

/** A bare "remote" with main pushed from `dir`, set as origin and upstream. */
function withRemote(base: string, dir: string): string {
  const bare = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  return bare;
}

/** A hook that leaves `marker` behind if it ever runs. */
function plantHook(hooksDir: string, name: string, marker: string): void {
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`);
  chmodSync(join(hooksDir, name), 0o755);
}

describe("parsing git's output", () => {
  it("reads porcelain v2 with renames, conflicts, untracked files and odd names", () => {
    const out = [
      "# branch.oid 1234",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaa bbb staged only.txt",
      "1 .M N... 100644 100644 100644 aaa bbb a\nnewline",
      "1 MM N... 100644 100644 100644 aaa bbb both.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
      "? fresh $(x).txt",
      "",
    ].join("\0");
    const s = parseStatusV2(out);
    expect(s).toMatchObject({ branch: "feature/x", head: "1234", upstream: { name: "origin/feature/x", ahead: 2, behind: 1 }, truncated: false });
    expect(s.entries.map((e) => [e.area, e.state, e.path, e.oldPath])).toEqual([
      ["staged", "modified", "staged only.txt", ""],
      ["unstaged", "modified", "a\nnewline", ""],
      ["staged", "modified", "both.txt", ""],
      ["unstaged", "modified", "both.txt", ""],
      ["staged", "renamed", "new name.txt", "old name.txt"],
      ["conflicted", "conflicted", "conflict.txt", ""],
      ["untracked", "untracked", "fresh $(x).txt", ""],
    ]);
    expect(parseStatusV2(out, 3)).toMatchObject({ truncated: true });
    expect(parseStatusV2(out, 3).entries.length).toBe(3);
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head (detached)\0")).toMatchObject({ head: "", branch: "" });
  });

  it("reads numstat with renames and binary files, name-status, log and branches", () => {
    expect([...parseNumstatZ("3\t1\ta.txt\0-\t-\tpic.png\0" + "5\t0\t\0old.txt\0new.txt\0")]).toEqual([
      ["a.txt", { added: 3, removed: 1 }],
      ["pic.png", null],
      ["new.txt", { added: 5, removed: 0 }],
    ]);
    expect(parseNameStatus("M\0a.txt\0R090\0old\0new\0A\0n.txt\0")).toEqual([
      { path: "a.txt", oldPath: "", state: "modified" },
      { path: "new", oldPath: "old", state: "renamed" },
      { path: "n.txt", oldPath: "", state: "added" },
    ]);
    expect(parseLog("abc\x1f100\x1fAnn\x1fHEAD -> main, origin/main\x1fsubject with \x1f in it\0\ndef\x1f200\x1fBob\x1f\x1fsecond")).toEqual([
      { oid: "abc", at: 100_000, author: "Ann", refs: ["HEAD -> main", "origin/main"], subject: "subject with \x1f in it" },
      { oid: "def", at: 200_000, author: "Bob", refs: [], subject: "second" },
    ]);
    expect(parseBranches("refs/heads/main\0origin/main\0ahead 2, behind 3\0*\nrefs/heads/old\0origin/old\0gone\0 \nrefs/remotes/origin/HEAD\0\0\0 \nrefs/remotes/origin/main\0\0\0 ")).toEqual({
      current: "main",
      local: [
        { name: "main", upstream: "origin/main", ahead: 2, behind: 3, gone: false },
        { name: "old", upstream: "origin/old", ahead: 0, behind: 0, gone: true },
      ],
      remote: ["origin/main"],
    });
  });

  it("finds the repository's own programs in its config, and leaves the user's alone", () => {
    const list = [
      "global", "credential.helper\nosxkeychain",
      "local", "credential.helper\n!evil",
      "local", "filter.Evil.clean\nevil",
      "worktree", "core.sshcommand\nevil",
      "local", "url.ext::sh -c evil.insteadof\ngh:",
      "local", "url.https://mirror/.insteadof\nhttps://github.com/",
      "local", "protocol.ext.allow\nalways",
      "local", "protocol.allow\nnever",
      "local", "user.name\nAnn",
      "command", "core.hookspath\n/dev/null",
      "",
    ].join("\0");
    expect(parseRiskyConfig(list)).toEqual([
      { key: "credential.helper", neutral: true, refuse: "write" },
      { key: "filter.Evil.clean", neutral: true, refuse: "write" },
      { key: "core.sshcommand", neutral: true, refuse: "write" },
      { key: "url.ext::sh -c evil.insteadof", neutral: false, refuse: "write" },
      { key: "protocol.ext.allow", neutral: false, refuse: "write" },
    ]);
  });
});

describe("pull request pages", () => {
  it("builds GitHub and GitLab pages from any remote form, without credentials", () => {
    expect(prLink("git@github.com:achoo254/chat-next.git", "feat/x y", "main")).toEqual({
      provider: "github",
      url: "https://github.com/achoo254/chat-next/compare/main...feat/x%20y?expand=1",
    });
    expect(prLink("https://user:tok@github.com/a/b", "f", "dev")?.url).toBe("https://github.com/a/b/compare/dev...f?expand=1");
    expect(prLink("ssh://git@gitlab.example.vn:2222/group/sub/app.git", "f", "main")).toEqual({
      provider: "gitlab",
      url: "https://gitlab.example.vn/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=f&merge_request%5Btarget_branch%5D=main",
    });
    for (const bad of ["https://bitbucket.org/a/b", "javascript:alert(1)//github.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://gith ub.com/a/b", "https://github.com/../b", "file:///x/github/a/b"]) {
      expect(prLink(bad, "f", "main"), bad).toBeUndefined();
    }
    expect(remoteRepo("git@github.com:a/b.git")).toEqual({ host: "github.com", path: ["a", "b"] });
  });
});

describe("status", () => {
  it("lists staged, unstaged, renamed, untracked and conflicted files with their line counts", async () => {
    const { ws, dir } = setup();
    git(dir, "switch", "-q", "-c", "side");
    writeFileSync(join(dir, "b.txt"), "side\n");
    commitAll(dir, "side");
    git(dir, "switch", "-q", "main");
    writeFileSync(join(dir, "b.txt"), "main\n");
    commitAll(dir, "main");
    try {
      git(dir, "merge", "-q", "side");
    } catch {
      // the conflict is the point
    }
    git(dir, "mv", "a.txt", "renamed a.txt");
    writeFileSync(join(dir, "renamed a.txt"), "one\nmore\n");
    writeFileSync(join(dir, "new $(x).txt"), "n\n");
    const s = await ws.status("w");
    expect(s).toMatchObject({ git: true, branch: "main", truncated: false });
    expect(s.head).toMatch(/^[0-9a-f]{40}$/);
    const rows = s.entries.map((e) => [e.area, e.state, e.path, e.oldPath, e.added, e.removed]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["staged", "renamed", "renamed a.txt", "a.txt", 0, 0],
        ["unstaged", "modified", "renamed a.txt", "", 1, 0],
        ["conflicted", "conflicted", "b.txt", "", 0, 0],
        ["untracked", "untracked", "new $(x).txt", "", 0, 0],
      ]),
    );
  });

  it("caps the list at 1000 entries and says so", async () => {
    const { ws, dir } = setup();
    for (let i = 0; i < 1005; i++) writeFileSync(join(dir, `n${i}.txt`), "");
    const s = await ws.status("w");
    expect(s.entries.length).toBe(1000);
    expect(s.truncated).toBe(true);
  });

  it("marks secret files without hiding them, and says when the folder is not in git", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    expect((await ws.status("w")).entries).toMatchObject([{ path: ".env", sensitive: true }]);
    const plain = join(tempDir("ws-plain-"), "p");
    mkdirSync(plain);
    const other = workspaces({ p: plain }).ws;
    expect(await other.status("p")).toMatchObject({ git: false, entries: [] });
    expect((await reasonOf(other.stage("p", ["x"], false, "dev"))).reason).toBe(ErrorReason.NOT_A_GIT_REPOSITORY);
    expect((await reasonOf(other.log("p", "", 0, 0))).reason).toBe(ErrorReason.NOT_A_GIT_REPOSITORY);
  });

  it("reports the upstream with ahead and behind", async () => {
    const { ws, dir, base } = setup();
    const bare = withRemote(base, dir);
    const other = join(base, "other");
    execFileSync("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "c.txt"), "c\n");
    commitAll(other, "theirs");
    git(other, "push", "-q");
    writeFileSync(join(dir, "d.txt"), "d\n");
    commitAll(dir, "ours");
    git(dir, "fetch", "-q");
    expect((await ws.status("w")).upstream).toEqual({ name: "origin/main", ahead: 1, behind: 1 });
  });
});

describe("stage, unstage, discard", () => {
  it("stages and unstages files, or everything", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "-rf"), "dash\n");
    writeFileSync(join(dir, "c d.txt"), "space\n");
    let s = await ws.stage("w", ["a.txt", "-rf"], false, "dev");
    expect(s.entries.filter((e) => e.area === "staged").map((e) => e.path).sort()).toEqual(["-rf", "a.txt"]);
    s = await ws.unstage("w", ["-rf"], false, "dev");
    expect(s.entries.filter((e) => e.area === "staged").map((e) => e.path)).toEqual(["a.txt"]);
    s = await ws.stage("w", [], true, "dev");
    expect(s.entries.every((e) => e.area === "staged")).toBe(true);
    s = await ws.unstage("w", [], true, "dev");
    expect(s.entries.some((e) => e.area === "staged")).toBe(false);
    for (const bad of [[], ["../x"], ["/etc/passwd"], [".git/config"], ["a/../../x"]]) {
      expect((await reasonOf(ws.stage("w", bad, false, "dev"))).code, JSON.stringify(bad)).toBe(ErrorCode.INVALID);
    }
  });

  it("unstages before the first commit", async () => {
    const dir = repo();
    writeFileSync(join(dir, "x.txt"), "x\n");
    const { ws } = workspaces({ w: dir });
    await ws.stage("w", [], true, "dev");
    expect((await ws.unstage("w", ["x.txt"], false, "dev")).entries).toMatchObject([{ area: "untracked", path: "x.txt" }]);
  });

  it("discards only with confirmation: tracked files from the index, untracked ones to the trash", async () => {
    const { ws, dir, trashDir, trashed } = setup();
    writeFileSync(join(dir, "a.txt"), "staged\n");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "staged then changed\n");
    writeFileSync(join(dir, "b.txt"), "changed\n");
    mkdirSync(join(dir, "newdir"));
    writeFileSync(join(dir, "newdir", "n.txt"), "untracked\n");
    const refused = await reasonOf(ws.discard("w", ["b.txt"], false, "dev"));
    expect(refused).toMatchObject({ code: ErrorCode.NEEDS_CONSENT, reason: ErrorReason.DISCARD_NOT_CONFIRMED });
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("changed\n");
    const s = await ws.discard("w", ["a.txt", "b.txt", "newdir"], true, "dev");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("two\n");
    // The staged change stays; only what came after it goes.
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("staged\n");
    expect(s.entries.map((e) => [e.area, e.path])).toEqual([["staged", "a.txt"]]);
    expect(existsSync(join(dir, "newdir", "n.txt"))).toBe(false);
    expect(trashed).toEqual([join(dir, "newdir", "n.txt")]);
    expect(readdirSync(trashDir)).toEqual(["0-n.txt"]);
  });

  it("never moves anything outside the workspace to the trash", async () => {
    const { ws, dir, base, trashed } = setup();
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(base, "elsewhere", "keep.txt"), "keep\n");
    expect((await reasonOf(ws.discard("w", ["../elsewhere/keep.txt"], true, "dev"))).reason).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
    if (posix) {
      execFileSync("ln", ["-s", join(base, "elsewhere"), join(dir, "link")]);
      // Through the link: git lists nothing beyond a symbolic link, so nothing moves.
      await ws.discard("w", ["link/keep.txt"], true, "dev");
      expect(trashed).toEqual([]);
      // The link goes to the trash; the folder it points to stays where it is.
      await ws.discard("w", ["link"], true, "dev");
      expect(trashed).toEqual([join(dir, "link")]);
      expect(existsSync(join(dir, "link"))).toBe(false);
    }
    expect(readFileSync(join(base, "elsewhere", "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("runs no hook placed in the agent's hooks folder: it refuses while that folder is not empty", async () => {
    const base = tempDir("ws-hooks-");
    const dir = repo(join(base, "work"));
    const hooksDir = join(base, "agent-hooks");
    const { ws } = workspaces({ w: dir }, { hooksDir });
    writeFileSync(join(dir, "a.txt"), "x\n");
    await ws.stage("w", ["a.txt"], false, "dev");
    plantHook(hooksDir, "pre-commit", join(base, "hook-ran"));
    expect(await reasonOf(ws.commit("w", "m", "dev"))).toMatchObject({ reason: ErrorReason.GIT_UNSAFE_CONFIG, subject: "core.hooksPath" });
    expect(existsSync(join(base, "hook-ran"))).toBe(false);
  });
});

describe("commit", () => {
  it("commits what is staged and runs no hook, whether in .git/hooks or core.hooksPath", async () => {
    const { ws, dir, base } = setup();
    const marker = join(base, "hook-ran");
    for (const h of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      plantHook(join(dir, ".git", "hooks"), h, marker);
      plantHook(join(base, "hooks"), h, marker);
    }
    git(dir, "config", "core.hooksPath", join(base, "hooks"));
    writeFileSync(join(dir, "a.txt"), "changed\n");
    await ws.stage("w", ["a.txt"], false, "dev");
    const c = await ws.commit("w", "Change a\n\nwith a body", "dev");
    expect(c.oid).toBe(git(dir, "rev-parse", "HEAD").trim());
    expect(c).toMatchObject({ subject: "Change a", author: "Test", refs: ["HEAD -> main"] });
    expect(git(dir, "log", "-1", "--format=%B").trim()).toBe("Change a\n\nwith a body");
    expect(existsSync(marker)).toBe(false);
    // The hook is a real one: run by git directly, it leaves the marker.
    if (posix) {
      writeFileSync(join(dir, "a.txt"), "again\n");
      git(dir, "commit", "-qam", "direct");
      expect(existsSync(marker)).toBe(true);
    }
  });

  it("refuses an empty message, and says when nothing is staged", async () => {
    const { ws } = setup();
    expect((await reasonOf(ws.commit("w", "  \n ", "dev"))).reason).toBe(ErrorReason.EMPTY_MESSAGE);
    expect((await reasonOf(ws.commit("w", "x".repeat(70_000), "dev"))).code).toBe(ErrorCode.INVALID);
    expect((await reasonOf(ws.commit("w", "nothing", "dev"))).reason).toBe(ErrorReason.GIT_FAILED);
  });

  it("lets one git write of a workspace run at a time", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "x\n");
    const first = ws.stage("w", ["a.txt"], false, "dev");
    const second = await reasonOf(ws.stage("w", ["a.txt"], false, "dev"));
    expect(second.reason).toBe(ErrorReason.GIT_BUSY);
    await first;
  });
});

describe("a repository that names programs in its own config", () => {
  const cases: [string, string][] = [
    ["credential.helper", "!touch MARKER"],
    ["core.sshCommand", "touch MARKER"],
    ["core.gitProxy", "touch MARKER"],
    ["core.askPass", "touch MARKER"],
    ["core.alternateRefsCommand", "touch MARKER"],
    ["gpg.program", "touch MARKER"],
    ["gpg.ssh.program", "touch MARKER"],
    ["filter.evil.clean", "touch MARKER"],
    ["filter.evil.smudge", "touch MARKER"],
    ["filter.evil.process", "touch MARKER"],
    ["diff.evil.textconv", "touch MARKER"],
    ["diff.external", "touch MARKER"],
    ["merge.evil.driver", "touch MARKER"],
    ["remote.origin.uploadpack", "touch MARKER"],
    ["remote.origin.receivepack", "touch MARKER"],
    ["url.ext::sh -c touch% MARKER.insteadOf", "evil:"],
    ["protocol.ext.allow", "always"],
  ];

  it.each(cases)("refuses writes and network commands when it sets %s, running nothing", async (key, value) => {
    const { ws, dir, base } = setup();
    withRemote(base, dir);
    const marker = join(base, "MARKER");
    git(dir, "config", key, value.replace("MARKER", marker));
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil merge=evil\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    for (const op of [
      () => ws.stage("w", ["a.txt"], false, "dev"),
      () => ws.unstage("w", [], true, "dev"),
      () => ws.discard("w", ["a.txt"], true, "dev"),
      () => ws.commit("w", "m", "dev"),
      () => ws.checkout("w", "main", "dev"),
      () => ws.branchCreate("w", "x", "", true, "dev"),
      () => ws.fetch("w"),
      () => ws.pull("w", "dev"),
      () => ws.push("w", "dev"),
    ]) {
      const r = await reasonOf(op());
      expect(r.reason).toBe(ErrorReason.GIT_UNSAFE_CONFIG);
      expect(r.subject.toLowerCase()).toBe(key.toLowerCase());
    }
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(marker)).toBe(false);
  });

  it("reads status and diffs with the repository's filters and diff drivers off", async () => {
    const { ws, dir, base } = setup();
    const marker = join(base, "MARKER");
    git(dir, "config", "filter.evil.clean", `touch ${marker}; cat`);
    git(dir, "config", "diff.evil.textconv", `touch ${marker}; cat`);
    git(dir, "config", "diff.evil.command", `touch ${marker}`);
    writeFileSync(join(dir, ".gitattributes"), "* filter=evil diff=evil\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const s = await ws.status("w");
    expect(s.entries.find((e) => e.path === "a.txt")).toMatchObject({ area: "unstaged", added: 1, removed: 1 });
    const d = await ws.diff("w", { path: "a.txt", oldPath: "", source: "unstaged", commit: "", base: "" });
    expect(d.unified).toContain("+changed");
    expect(existsSync(marker)).toBe(false);
    // The filter is a real one: git run directly runs it.
    if (posix) {
      git(dir, "diff");
      expect(existsSync(marker)).toBe(true);
    }
  });

  it("leaves the user's own (global) helpers alone", async () => {
    const { ws, dir } = setup();
    const before = process.env.GIT_CONFIG_GLOBAL ?? "";
    const own = join(tempDir("ws-global-"), "gitconfig");
    writeFileSync(own, `${readFileSync(before, "utf8")}[credential]\n\thelper = cache\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", own);
    try {
      writeFileSync(join(dir, "a.txt"), "changed\n");
      expect((await ws.stage("w", ["a.txt"], false, "dev")).entries).toMatchObject([{ area: "staged", path: "a.txt" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("remotes", () => {
  it("pushes, sets the upstream of a new branch, fetches and pulls fast-forward only", async () => {
    const { ws, dir, base, auditFile } = setup();
    const marker = join(base, "hook-ran");
    const bare = withRemote(base, dir);
    plantHook(join(dir, ".git", "hooks"), "pre-push", marker);
    plantHook(join(dir, ".git", "hooks"), "post-merge", marker);
    writeFileSync(join(dir, "a.txt"), "pushed\n");
    await ws.stage("w", [], true, "dev");
    await ws.commit("w", "to push", "dev");
    expect((await ws.push("w", "dev")).upstream).toEqual({ name: "origin/main", ahead: 0, behind: 0 });
    expect(git(bare, "log", "-1", "--format=%s", "main").trim()).toBe("to push");
    await ws.branchCreate("w", "feature/one", "", true, "dev");
    const pushed = await ws.push("w", "dev");
    expect(pushed).toMatchObject({ branch: "feature/one", upstream: { name: "origin/feature/one" } });
    expect(git(bare, "branch", "--list", "feature/one").trim()).toBe("feature/one");
    // Someone else pushes to main; fetch sees it, pull fast-forwards.
    const other = join(base, "other");
    execFileSync("git", ["clone", "-q", bare, other]);
    writeFileSync(join(other, "c.txt"), "c\n");
    commitAll(other, "theirs");
    git(other, "push", "-q");
    await ws.checkout("w", "main", "dev");
    expect((await ws.fetch("w")).upstream).toEqual({ name: "origin/main", ahead: 0, behind: 1 });
    expect((await ws.pull("w", "dev")).upstream).toEqual({ name: "origin/main", ahead: 0, behind: 0 });
    expect(existsSync(join(dir, "c.txt"))).toBe(true);
    // Diverged: no merge commit, no rebase; git says why.
    writeFileSync(join(other, "c.txt"), "theirs again\n");
    commitAll(other, "theirs 2");
    git(other, "push", "-q");
    writeFileSync(join(dir, "d.txt"), "ours\n");
    commitAll(dir, "ours");
    const diverged = await reasonOf(ws.pull("w", "dev"));
    expect(diverged.reason).toBe(ErrorReason.GIT_FAILED);
    expect(git(dir, "log", "-1", "--format=%s").trim()).toBe("ours");
    // Never forced either.
    expect((await reasonOf(ws.push("w", "dev"))).reason).toBe(ErrorReason.GIT_FAILED);
    expect(git(bare, "log", "-1", "--format=%s", "main").trim()).toBe("theirs 2");
    expect(existsSync(marker)).toBe(false);
    const actions = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { action: string }).action);
    expect(actions).toEqual(expect.arrayContaining(["git_push", "git_pull", "git_branch_create", "git_checkout", "git_commit", "git_stage"]));
  });

  it("checks out a remote branch by its short name and refuses names git would not take", async () => {
    const { ws, dir, base } = setup();
    const bare = withRemote(base, dir);
    const other = join(base, "other");
    execFileSync("git", ["clone", "-q", bare, other]);
    git(other, "switch", "-q", "-c", "theirs");
    git(other, "push", "-q", "-u", "origin", "theirs");
    await ws.fetch("w");
    expect((await ws.checkout("w", "theirs", "dev")).upstream?.name).toBe("origin/theirs");
    const b = await ws.branches("w");
    expect(b.current).toBe("theirs");
    expect(b.local.map((x) => x.name).sort()).toEqual(["main", "theirs"]);
    expect(b.remote.sort()).toEqual(["origin/main", "origin/theirs"]);
    for (const bad of ["-f", "a..b", "HEAD", "a b", "x~1", "", "--orphan=x", "a\nb"]) {
      expect((await reasonOf(ws.checkout("w", bad, "dev"))).reason, bad).toBe(ErrorReason.NAME_INVALID);
      expect((await reasonOf(ws.branchCreate("w", bad, "", false, "dev"))).reason, bad).toBe(ErrorReason.NAME_INVALID);
    }
    expect((await reasonOf(ws.branchCreate("w", "ok", "--all", false, "dev"))).reason).toBe(ErrorReason.NAME_INVALID);
    expect((await reasonOf(ws.branchCreate("w", "ok", "nope", false, "dev"))).reason).toBe(ErrorReason.NAME_INVALID);
  });

  describe("without a sign-in", () => {
    let server: Server | undefined;
    afterAll(() => server?.close());

    it("fails at once with a typed error instead of asking", async () => {
      server = createServer((_req, res) => {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        res.end();
      });
      await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const { ws, dir } = setup({ extraGitConfig: [...TEST_GIT_CONFIG, "-c", "protocol.http.allow=always"] });
      git(dir, "remote", "add", "origin", `http://127.0.0.1:${port}/repo.git`);
      const started = Date.now();
      expect((await reasonOf(ws.fetch("w"))).reason).toBe(ErrorReason.GIT_NEEDS_CREDENTIALS);
      expect((await reasonOf(ws.push("w", "dev"))).reason).toBe(ErrorReason.GIT_NEEDS_CREDENTIALS);
      expect(Date.now() - started).toBeLessThan(20_000);
    });
  });

  it("refuses transports other than https and ssh", async () => {
    const { ws, dir, base } = setup({ extraGitConfig: [] });
    const bare = join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(dir, "remote", "add", "origin", bare);
    expect((await reasonOf(ws.push("w", "dev"))).reason).toBe(ErrorReason.GIT_FAILED);
    expect(git(bare, "branch", "--list").trim()).toBe("");
  });
});

describe("history", () => {
  it("pages the log and tells what a branch committed since its base", async () => {
    const { ws, dir } = setup();
    git(dir, "switch", "-q", "-c", "feature");
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
      commitAll(dir, `feature ${i}`);
    }
    git(dir, "mv", "a.txt", "moved.txt");
    commitAll(dir, "move");
    const page = await ws.log("w", "", 0, 2);
    expect(page.commits.map((c) => c.subject)).toEqual(["move", "feature 2"]);
    expect(page.hasMore).toBe(true);
    const rest = await ws.log("w", "", 2, 50);
    expect(rest.commits.map((c) => c.subject)).toEqual(["feature 1", "feature 0", "first"]);
    expect(rest.hasMore).toBe(false);
    expect((await ws.log("w", "main", 0, 0)).commits.map((c) => c.subject)).toEqual(["first"]);
    expect((await reasonOf(ws.log("w", "main..feature", 0, 0))).reason).toBe(ErrorReason.NAME_INVALID);
    expect((await reasonOf(ws.log("w", "--all", 0, 0))).reason).toBe(ErrorReason.NAME_INVALID);
    const c = await ws.branchCompare("w", "");
    expect(c).toMatchObject({ base: "main", ahead: 4, behind: 0, truncated: false });
    expect(c.files.map((f) => [f.state, f.path, f.oldPath, f.added]).sort()).toEqual([
      ["added", "f0.txt", "", 1],
      ["added", "f1.txt", "", 1],
      ["added", "f2.txt", "", 1],
      ["renamed", "moved.txt", "a.txt", 0],
    ]);
    expect((await reasonOf(ws.branchCompare("w", "nope"))).reason).toBe(ErrorReason.NAME_INVALID);
  });

  it("gives one file's diff from the working tree, the index, a commit or the branch", async () => {
    const { ws, dir } = setup();
    const first = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "one\nstaged\n");
    git(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "one\nstaged\nunstaged\n");
    writeFileSync(join(dir, "new.txt"), "brand new\n");
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    const d = (source: "unstaged" | "staged" | "commit" | "branch", path: string, commit = "") => ws.diff("w", { path, oldPath: "", source, commit, base: "" });
    expect(await d("unstaged", "a.txt")).toMatchObject({ added: 1, removed: 0, binary: false });
    expect((await d("unstaged", "a.txt")).unified).toContain("+unstaged");
    expect((await d("staged", "a.txt")).unified).toContain("+staged");
    expect((await d("staged", "a.txt")).unified).not.toContain("+unstaged");
    expect(await d("unstaged", "new.txt")).toMatchObject({ state: "untracked", added: 1 });
    expect(await d("unstaged", ".env")).toMatchObject({ sensitive: true, unified: "" });
    const root = await d("commit", "a.txt", first);
    expect(root).toMatchObject({ state: "added", added: 1 });
    expect((await reasonOf(d("commit", "a.txt", "HEAD"))).reason).toBe(ErrorReason.NAME_INVALID);
    git(dir, "commit", "-qm", "second");
    git(dir, "switch", "-q", "-c", "topic");
    commitAll(dir, "topic");
    expect((await d("branch", "a.txt")).unified).toContain("+unstaged");
  });
});

describe("the consent log", () => {
  it("names the action and the workspace, never a path, a file's content or a commit message", async () => {
    const { ws, dir, base, auditFile } = setup();
    withRemote(base, dir);
    const secretName = "private-plans-2027.txt";
    writeFileSync(join(dir, secretName), "TOPSECRET-CONTENT\n");
    writeFileSync(join(dir, "a.txt"), "TOPSECRET-EDIT\n");
    writeFileSync(join(dir, "b.txt"), "TOPSECRET-B\n");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    await ws.stage("w", [secretName, "a.txt"], false, "dev");
    await ws.unstage("w", ["a.txt"], false, "dev");
    await ws.stage("w", ["a.txt"], false, "dev");
    await ws.commit("w", "MSG-SECRET subject\n\nMSG-SECRET body", "dev");
    await ws.discard("w", ["b.txt"], true, "dev");
    await ws.push("w", "dev");
    const written = readFileSync(auditFile, "utf8");
    for (const leak of ["TOPSECRET", "MSG-SECRET", secretName, "a.txt", "b.txt"]) expect(written, leak).not.toContain(leak);
    const entries = written.trim().split("\n").map((l) => JSON.parse(l) as { action: string; detail: string; device: string });
    expect(entries.map((e) => e.action)).toEqual(["git_stage", "git_unstage", "git_stage", "git_commit", "git_discard", "git_push"]);
    expect(entries[0]?.detail).toBe("workspace w: 2 files");
    expect(entries.every((e) => e.device === "dev" && e.detail.startsWith("workspace w"))).toBe(true);
    const printed = [...log.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(printed).not.toContain("TOPSECRET");
    expect(printed).not.toContain("MSG-SECRET");
    log.mockRestore();
    error.mockRestore();
  });
});

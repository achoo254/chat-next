// Projects on the machine: kept in tunelo's config, added from a folder,
// created (with git init) or cloned only from https/ssh without running a
// repository's commands, never into an existing or sensitive folder; removing
// keeps the folder; a project whose folder went says so; git status is cheap
// and read again after a turn.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { cloneUrlName, gitStatus, parseStatus } from "../src/projects/git.ts";
import { type CloneProgress, Projects, cleanName } from "../src/projects/projects.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { tempDir } from "./harness.ts";

function setup(opts: { sensitive?: (p: string) => boolean; status?: ConstructorParameters<typeof Projects>[0]["status"] } = {}) {
  const root = tempDir("projects-");
  const config = new ConfigStore(join(root, "cfg"));
  const audit = new AuditLog(join(root, "audit.jsonl"));
  const work = join(root, "work");
  mkdirSync(work);
  const projects = new Projects({
    config,
    audit,
    isSensitive: opts.sensitive ?? ((p) => p.includes(".ssh")),
    home: root,
    sessionDirs: async () => [
      { dir: work, sessions: 3 },
      { dir: join(root, "gone"), sessions: 9 },
      { dir: root, sessions: 20 },
    ],
    ...(opts.status ? { status: opts.status } : {}),
  });
  return { root, config, audit, work, projects };
}

const reason = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    return (err as { reason?: ErrorReason }).reason;
  }
  return undefined;
};

describe("clone URLs", () => {
  it("takes https and ssh, and the repository's name for the folder", () => {
    expect(cloneUrlName("https://github.com/achoo254/chat-next.git")).toBe("chat-next");
    expect(cloneUrlName("git@github.com:achoo254/chat-next.git")).toBe("chat-next");
    expect(cloneUrlName("ssh://git@host.example:2222/team/app")).toBe("app");
  });

  it("refuses other transports, options, passwords and odd paths", () => {
    for (const bad of [
      "file:///etc",
      "/etc/passwd",
      "../repo",
      "ext::sh -c touch% /tmp/pwned",
      "--upload-pack=touch /tmp/x",
      "-u x",
      "https://user:secret@github.com/a/b.git",
      "https://token@github.com/a/b.git",
      "http://github.com/a/b.git",
      "git://github.com/a/b.git",
      "C:\\repo",
      "https://github.com/a/..",
      "https://github.com/a/b c",
      "",
    ]) {
      expect(cloneUrlName(bad), bad).toBeUndefined();
    }
  });
});

describe("git status", () => {
  it("reads branch, changes, ahead and behind", () => {
    const s = parseStatus(["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 .M N... a", "? new.txt", "! ignored"].join("\n"));
    expect(s).toEqual({ git: true, branch: "main", changed: 2, ahead: 2, behind: 1, upstream: true });
  });

  it("never runs a repository's fsmonitor", async () => {
    const root = tempDir("git-");
    execFileSync("git", ["init", "-q", root]);
    const marker = join(root, "..", `fsmonitor-ran-${Date.now()}`);
    execFileSync("git", ["-C", root, "config", "core.fsmonitor", `touch ${marker}`]);
    writeFileSync(join(root, "a.txt"), "x");
    const s = await gitStatus(root);
    expect(s?.changed).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect((await gitStatus(tempDir("plain-")))?.git).toBe(false);
  });
});

describe("projects", () => {
  it("adds a folder, keeps it in tunelo's config, and suggests folders with sessions", async () => {
    const { projects, work, config } = setup({ status: async () => ({ git: true, branch: "main", changed: 3, ahead: 0, behind: 0, upstream: false }) });
    expect((await projects.list()).suggestions.map((s) => s.sessions)).toEqual([3]);
    const id = projects.add({ dir: work, name: "", sensitive: false, device: "phone" });
    const list = await projects.list();
    expect(list.projects.map((p) => [p.id, p.name, p.git?.branch, p.git?.changed])).toEqual([[id, "work", "main", 3]]);
    expect(list.suggestions).toEqual([]);
    expect(config.get().projects?.[0]?.dir).toBe(work);
    expect(JSON.parse(readFileSync(config.file, "utf8")).projects).toHaveLength(1);
    expect(await reason(() => projects.add({ dir: work, name: "x", sensitive: false, device: "phone" }))).toBe(ErrorReason.PROJECT_EXISTS);
  });

  it("asks before adding a sensitive folder and logs it", async () => {
    const { projects, root, audit } = setup();
    const ssh = join(root, ".ssh");
    mkdirSync(ssh);
    expect(await reason(() => projects.add({ dir: ssh, name: "", sensitive: false, device: "phone" }))).toBe(ErrorReason.SENSITIVE_FOLDER);
    projects.add({ dir: ssh, name: "keys", sensitive: true, device: "phone" });
    expect(audit.list(5).some((e) => e.action === "project_add" && e.path === ssh)).toBe(true);
  });

  it("creates a new folder with git init, never one that exists or a path that leaves the parent", async () => {
    const { projects, work } = setup();
    await projects.create({ parent: work, name: "app", gitInit: true });
    expect(existsSync(join(work, "app", ".git"))).toBe(true);
    expect(await reason(() => projects.create({ parent: work, name: "app", gitInit: false }))).toBe(ErrorReason.PROJECT_EXISTS);
    for (const bad of ["../escape", "a/b", "..", "", "x\\..\\y"]) {
      expect(await reason(() => projects.create({ parent: work, name: bad, gitInit: false })), bad).toBe(ErrorReason.NAME_INVALID);
    }
    expect(existsSync(join(work, "..", "escape"))).toBe(false);
    expect(await reason(() => projects.create({ parent: join(work, "nope"), name: "x", gitInit: false }))).toBe(ErrorReason.FOLDER_NOT_FOUND);
  });

  it("refuses to create or clone into a sensitive folder", async () => {
    const { projects, root } = setup();
    mkdirSync(join(root, ".ssh"));
    expect(await reason(() => projects.create({ parent: join(root, ".ssh"), name: "x", gitInit: false }))).toBe(ErrorReason.SENSITIVE_FOLDER);
    expect(await reason(() => projects.clone({ url: "https://github.com/a/b.git", parent: join(root, ".ssh"), name: "", cloneId: "clone-0001" }, () => undefined))).toBe(
      ErrorReason.SENSITIVE_FOLDER,
    );
    expect(await reason(() => projects.clone({ url: "file:///etc", parent: root, name: "", cloneId: "clone-0002" }, () => undefined))).toBe(ErrorReason.CLONE_URL_INVALID);
  });

  it("a failed clone leaves no folder and says why", async () => {
    const { projects, work } = setup();
    const done = new Promise<CloneProgress>((resolve) =>
      projects.clone({ url: "https://127.0.0.1:1/none/repo.git", parent: work, name: "", cloneId: "clone-0003" }, (p) => p.done && resolve(p)),
    );
    const p = await done;
    expect(p.reason).toBe(ErrorReason.CLONE_FAILED);
    expect(p.projectId).toBe("");
    expect(existsSync(join(work, "repo"))).toBe(false);
  }, 20_000);

  it("renames, pins, sets defaults, reorders and removes without touching the folder", async () => {
    const { projects, work, root } = setup();
    const other = join(root, "other");
    mkdirSync(other);
    const a = projects.add({ dir: work, name: "A", sensitive: false, device: "p" });
    const b = projects.add({ dir: other, name: "B", sensitive: false, device: "p" });
    const modes = (provider: string) => (provider === "claude" ? ["default", "plan"] : undefined);
    projects.update({ id: b, name: "  Bee  ", pinned: true, defaults: { provider: "claude", model: "sonnet", permissionMode: "plan", projectSettings: true } }, modes);
    expect((await projects.list()).projects.map((p) => [p.name, p.pinned])).toEqual([
      ["Bee", true],
      ["A", false],
    ]);
    expect((await projects.list()).projects.find((p) => p.name === "Bee")?.defaults).toMatchObject({ provider: "claude", model: "sonnet", permissionMode: "plan" });
    expect(await reason(() => projects.update({ id: a, defaults: { provider: "claude", model: "", permissionMode: "bypassPermissions", projectSettings: false } }, modes))).toBe(
      ErrorReason.PERMISSION_MODE_NOT_ALLOWED,
    );
    // A model or a mode needs the AI it belongs to; an AI the machine does not know is refused.
    expect(await reason(() => projects.update({ id: a, defaults: { provider: "", model: "sonnet", permissionMode: "", projectSettings: false } }, modes))).toBe(
      ErrorReason.PROVIDER_REQUIRED,
    );
    expect(await reason(() => projects.update({ id: a, defaults: { provider: "nope", model: "", permissionMode: "", projectSettings: false } }, modes))).toBe(ErrorReason.UNKNOWN_AI);
    expect(await reason(() => projects.update({ id: a, name: "\u0001\u0002" }, modes))).toBe(ErrorReason.NAME_INVALID);
    projects.update({ id: b, pinned: false }, modes);
    projects.reorder([b, a]);
    expect((await projects.list()).projects.map((p) => p.name)).toEqual(["Bee", "A"]);
    expect(await reason(() => projects.reorder([a]))).toBe(ErrorReason.PROJECT_NOT_FOUND);
    projects.remove(a);
    expect(existsSync(work)).toBe(true);
    expect(await reason(() => projects.remove(a))).toBe(ErrorReason.PROJECT_NOT_FOUND);
  });

  it("says when a project's folder is gone", async () => {
    const { projects, root } = setup();
    const dir = join(root, "temp-project");
    mkdirSync(dir);
    projects.add({ dir, name: "", sensitive: false, device: "p" });
    rmSync(dir, { recursive: true });
    const [p] = (await projects.list()).projects;
    expect(p?.missing).toBe(true);
    expect(p?.git).toBeUndefined();
  });

  it("reads a project's git status again only after a turn there ended", async () => {
    let reads = 0;
    const { projects, work } = setup({
      status: async () => {
        reads += 1;
        return { git: true, branch: "main", changed: reads, ahead: 0, behind: 0, upstream: false };
      },
    });
    projects.add({ dir: work, name: "", sensitive: false, device: "p" });
    await projects.list();
    await projects.list();
    expect(reads).toBe(1);
    expect(projects.invalidate(join(work, "src"))).toBe(true);
    expect((await projects.list()).projects[0]?.git?.changed).toBe(2);
    expect(projects.invalidate("/elsewhere")).toBe(false);
  });

  it("cleans names", () => {
    expect(cleanName("  my   app ")).toBe("my app");
    expect(cleanName("")).toBeUndefined();
    expect(cleanName("x".repeat(65))).toBeUndefined();
  });
});

describe("a session started with a project's defaults", () => {
  it("starts in the permission mode asked for, and refuses one the AI does not offer", async () => {
    const { fakeProvider } = await import("./fake-provider.ts");
    const { makeCore } = await import("./harness.ts");
    const p = fakeProvider();
    const { core, work } = makeCore([p]);
    await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: false }, device: "d", permissionMode: "plan" });
    expect(p.log.starts[0]?.permissionMode).toBe("plan");
    await expect(
      core.create({ provider: "fake", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: false }, device: "d", permissionMode: "bypassPermissions" }),
    ).rejects.toMatchObject({ reason: ErrorReason.PERMISSION_MODE_NOT_ALLOWED });
    await core.stop();
  });
});

// What a folder reports about its repository: the origin URL as git has it
// (never with a password or an http(s) user) and the branch, read with git
// itself and no shell, so a hostile folder name or remote value runs
// nothing; projects and suggested folders carry them to devices.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { projectListBody } from "../src/link/connection.ts";
import { gitBranch, gitOriginUrl, reportableRemote } from "../src/projects/git.ts";
import { Projects } from "../src/projects/projects.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { tempDir } from "./harness.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

/** A repository on branch `main` whose origin is `remote`. */
function repo(dir: string, remote?: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "pipe" });
  if (remote !== undefined) git(dir, "config", "remote.origin.url", remote);
  return dir;
}

describe("reportable remotes", () => {
  it("keeps the URL as git has it", () => {
    for (const url of ["git@github.com:achoo254/chat-next.git", "https://github.com/achoo254/chat-next.git", "ssh://git@host.example:2222/team/app", "my-alias:team/app"]) {
      expect(reportableRemote(url), url).toBe(url);
    }
  });

  it("drops passwords, and the user of http(s) where hosts put tokens", () => {
    expect(reportableRemote("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(reportableRemote("https://ghp_secret@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(reportableRemote("HTTP://user:pw@host/a")).toBe("HTTP://host/a");
    expect(reportableRemote("ssh://git:pw@host/a/b")).toBe("ssh://git@host/a/b");
    expect(reportableRemote("ssh://:pw@host/a/b")).toBe("ssh://host/a/b");
  });

  it("refuses control characters, extra lines and overlong values", () => {
    expect(reportableRemote("https://github.com/a/b\u0007")).toBeUndefined();
    expect(reportableRemote("https://github.com/a/\u009bb")).toBeUndefined();
    expect(reportableRemote(`https://github.com/${"a".repeat(2048)}`)).toBeUndefined();
    expect(reportableRemote("")).toBeUndefined();
    expect(reportableRemote("https://github.com/a/b\nhttps://evil.example/x")).toBe("https://github.com/a/b");
  });
});

describe("reading a folder's remote and branch", () => {
  it("reads origin and branch, and nothing outside git", async () => {
    const dir = repo(join(tempDir("git-info-"), "app"), "git@github.com:achoo254/app.git");
    expect(await gitOriginUrl(dir)).toBe("git@github.com:achoo254/app.git");
    expect(await gitBranch(dir)).toBe("main");
    const plain = tempDir("plain-");
    expect(await gitOriginUrl(plain)).toBeUndefined();
    expect(await gitBranch(plain)).toBeUndefined();
    expect(await gitOriginUrl(join(plain, "missing"))).toBeUndefined();
    expect(await gitOriginUrl(repo(join(plain, "no-remote")))).toBeUndefined();
  });

  it("runs nothing for a hostile folder name, remote value or repository config", async () => {
    const root = tempDir("git-hostile-");
    const marker = join(root, "pwned");
    const names = [`-C ${root}`, `$(touch ${marker})`, `\`touch ${marker}\``, `a; touch ${marker}`, `'"| touch ${marker} &`];
    for (const name of names) {
      const remote = `https://github.com/a/b$(touch ${marker})\`touch ${marker}\`;touch ${marker}`;
      const dir = repo(join(root, "work", name.replaceAll("/", "_")), remote);
      // Programs a repository may name: git must run none of them here.
      git(dir, "config", "core.fsmonitor", `touch ${marker}`);
      git(dir, "config", "core.hooksPath", root);
      git(dir, "config", "core.sshCommand", `touch ${marker}`);
      expect(await gitOriginUrl(dir), name).toBe(remote);
      expect(await gitBranch(dir), name).toBe("main");
    }
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["work"]);
  });

  it("never reports the credentials of the origin URL", async () => {
    const dir = repo(join(tempDir("git-cred-"), "app"), "https://user:token123@github.com/a/b.git");
    expect(await gitOriginUrl(dir)).toBe("https://github.com/a/b.git");
  });
});

describe("projects and suggestions carry remote and branch", () => {
  function setup(reads: { remote: number; branch: number }) {
    const root = tempDir("projects-git-");
    const work = repo(join(root, "work"), "git@github.com:achoo254/work.git");
    const other = repo(join(root, "other"), "https://github.com/achoo254/other");
    const plain = join(root, "plain");
    mkdirSync(plain);
    const projects = new Projects({
      config: new ConfigStore(join(root, "cfg")),
      audit: new AuditLog(join(root, "audit.jsonl")),
      isSensitive: () => false,
      home: root,
      sessionDirs: async () => [
        { dir: other, sessions: 2 },
        { dir: plain, sessions: 1 },
      ],
      status: async () => ({ git: true, branch: "main", changed: 0, ahead: 0, behind: 0, upstream: false }),
      remote: async (dir) => {
        reads.remote += 1;
        return gitOriginUrl(dir);
      },
      branch: async (dir) => {
        reads.branch += 1;
        return gitBranch(dir);
      },
    });
    return { projects, work, other, plain };
  }

  it("reports them for added folders and the folders of sessions, and devices get them", async () => {
    const reads = { remote: 0, branch: 0 };
    const { projects, work, other, plain } = setup(reads);
    projects.add({ dir: work, name: "", sensitive: false, device: "d" });
    const list = await projects.list();
    expect(list.projects.map((p) => [p.dir, p.gitRemote, p.git?.branch])).toEqual([[work, "git@github.com:achoo254/work.git", "main"]]);
    expect(list.suggestions).toEqual([
      { dir: other, sessions: 2, gitRemote: "https://github.com/achoo254/other", branch: "main" },
      { dir: plain, sessions: 1 },
    ]);
    const body = projectListBody(list);
    expect(body.projects[0]?.gitRemote).toBe("git@github.com:achoo254/work.git");
    expect(body.suggestions).toEqual([
      { dir: other, sessions: 2, gitRemote: "https://github.com/achoo254/other", branch: "main" },
      { dir: plain, sessions: 1, gitRemote: "", branch: "" },
    ]);
  });

  it("reads them once a minute, and again after a turn there", async () => {
    const reads = { remote: 0, branch: 0 };
    const { projects, other } = setup(reads);
    await projects.list();
    await projects.list();
    expect(reads).toEqual({ remote: 2, branch: 2 });
    expect(projects.invalidate(other)).toBe(false);
    git(other, "checkout", "-q", "-b", "feature");
    const again = await projects.list();
    expect(again.suggestions[0]?.branch).toBe("feature");
    expect(reads).toEqual({ remote: 3, branch: 3 });
  });
});

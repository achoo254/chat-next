// The repository key of a working directory, from git's own files only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRepoKey, originFromConfig, repoKeyOf } from "../../src/usage/repo-key.ts";
import { tempDir } from "../harness.ts";

function repo(dir: string, remote?: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n${remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}`);
}

describe("repository key of a working directory", () => {
  it("is the origin remote of the nearest repository, without the user or password of an https remote", () => {
    const root = tempDir("repo-key-");
    const outer = join(root, "outer");
    repo(outer, "https://someone:hunter2@git.example.com/team/app.git");
    mkdirSync(join(outer, "src", "deep"), { recursive: true });
    expect(gitRepoKey(join(outer, "src", "deep"))).toBe("https://git.example.com/team/app.git");
    // A repository inside another one has its own key.
    const inner = join(outer, "vendor", "lib");
    repo(inner, "git@git.example.com:team/lib.git");
    expect(gitRepoKey(inner)).toBe("git@git.example.com:team/lib.git");
  });

  it("follows a worktree to its main repository, and names a repository without a remote by its folder", () => {
    const root = tempDir("repo-key-");
    const main = join(root, "main-repo");
    repo(main);
    const wtGit = join(main, ".git", "worktrees", "feature");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(root, "feature-tree");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    expect(gitRepoKey(wt)).toBe("local:main-repo");
    writeFileSync(join(main, ".git", "config"), '[remote "origin"]\n  url = https://git.example.com/team/main.git\n');
    expect(gitRepoKey(wt)).toBe("https://git.example.com/team/main.git");
  });

  it("is local:<folder> for a folder that is gone or outside git, and scratch for temp folders", () => {
    expect(gitRepoKey("/no/such/place/project-x")).toBe("local:project-x");
    expect(repoKeyOf("/tmp/anything")).toBe("scratch");
    expect(repoKeyOf("/private/tmp/a/b")).toBe("scratch");
    expect(repoKeyOf("/private/var/folders/xy/T/run")).toBe("scratch");
    expect(repoKeyOf("/home/someone/agent/scratchpad/job")).toBe("scratch");
    expect(repoKeyOf("")).toBe("scratch");
  });

  it("reads only the origin remote's url", () => {
    expect(originFromConfig('[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = b\n')).toBe("b");
    expect(originFromConfig("[core]\n\turl = a\n")).toBeUndefined();
  });
});

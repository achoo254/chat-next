import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRoot, listDir } from "../src/safety/dirs.ts";
import { createSensitiveCheck, mentionsSensitive } from "../src/safety/sensitive-paths.ts";
import { tempDir } from "./harness.ts";

describe("sensitive paths", () => {
  const home = join(tempDir(), "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "code", "app"), { recursive: true });
  const check = createSensitiveCheck({ home, configDir: join(home, "cfg") });

  it("flags home itself, key folders and the agent's config, not ordinary projects", () => {
    expect(check(home)).toBe(true);
    expect(check(join(home, ".ssh"))).toBe(true);
    expect(check(join(home, ".ssh", "id_ed25519"))).toBe(true);
    expect(check(join(home, "cfg", "config.json"))).toBe(true);
    expect(check(join(home, "code"))).toBe(false);
    expect(check(join(home, "code", "app"))).toBe(false);
  });

  it("sees through .. and links", () => {
    expect(check(join(home, "code", "..", ".ssh"))).toBe(true);
    const link = join(home, "code", "keys");
    symlinkSync(join(home, ".ssh"), link, "junction");
    expect(check(link)).toBe(true);
    expect(check(join(link, "id_ed25519"))).toBe(true);
  });

  it("finds sensitive paths inside a command or JSON input", () => {
    expect(mentionsSensitive(`cat ${join(home, ".ssh", "id")}`, check, { home })).toBe(true);
    expect(mentionsSensitive(JSON.stringify({ file_path: join(home, ".ssh", "config") }), check, { home })).toBe(true);
    expect(mentionsSensitive("cat ~/.ssh/config", check, { home })).toBe(true);
    expect(mentionsSensitive(`ls ${join(home, "code")}`, check, { home })).toBe(false);
    expect(mentionsSensitive("npm test", check, { home })).toBe(false);
    expect(mentionsSensitive("cat ../../.ssh/id_rsa", check, { home, cwd: join(home, "code", "app") })).toBe(true);
    expect(mentionsSensitive("cat $HOME/.ssh/id_rsa", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo.exe login", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo config local-forward off", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo config mcp-local-writes on", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo config -s https://evil.example", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo config -k tunelo_anon", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo logout --force", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo uninstall", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo trust ~/code", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo untrust .", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo stop", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo run --port 1", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo trusted", check, { home })).toBe(false);
    expect(mentionsSensitive("tunelo http 3000", check, { home })).toBe(false);
    expect(mentionsSensitive("cat ~/.tunelo/config.json", check, { home })).toBe(true);
    expect(mentionsSensitive("tunelo status", check, { home })).toBe(false);
  });

  it("flags the sign-in of the Tunelo CLI 1.x and tunelo's sealed session", () => {
    expect(check(join(home, ".tunelo"))).toBe(true);
    expect(check(join(home, ".tunelo", "config.json"))).toBe(true);
    expect(check(join(home, "cfg", "session.json"))).toBe(true);
    expect(check(join(home, "cfg", "session-key"))).toBe(true);
  });

  it("flags the agent's config folder", () => {
    const appData = join(home, "AppData", "Roaming");
    const saved = process.env.APPDATA;
    process.env.APPDATA = appData;
    try {
      const plain = createSensitiveCheck({ home });
      const d = process.platform === "win32" ? join(appData, "tunelo") : join(home, ".config", "tunelo");
      expect(plain(d)).toBe(true);
      expect(plain(join(d, "tunelo-session.json"))).toBe(true);
      expect(plain(join(d, "session.json"))).toBe(true);
      expect(plain(join(home, ".config", "other-app"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = saved;
    }
  });
});

describe("folder browser", () => {
  it("lists folders only, never file names, and marks git repos", () => {
    const root = tempDir();
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "secret.txt"), "x");
    const l = listDir(root, { showHidden: false, isSensitive: () => false });
    expect(l.entries).toEqual([{ name: "repo", git: true, branch: "main", sensitive: false }]);
    expect(listDir(root, { showHidden: true, isSensitive: () => false }).entries.map((e) => e.name)).toEqual([".hidden", "repo"]);
    expect(JSON.stringify(l)).not.toContain("secret.txt");
  });
});

describe("git work tree of a folder", () => {
  it("is the nearest folder up with a .git, the folder itself included", () => {
    const root = tempDir();
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "backend", "src"), { recursive: true });
    expect(gitRoot(join(root, "repo", "backend", "src"))).toBe(join(root, "repo"));
    expect(gitRoot(join(root, "repo"))).toBe(join(root, "repo"));
  });

  it("stops at a worktree or submodule (.git as a file)", () => {
    const root = tempDir();
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "sub", "lib"), { recursive: true });
    writeFileSync(join(root, "repo", "sub", ".git"), "gitdir: ../.git/modules/sub\n");
    expect(gitRoot(join(root, "repo", "sub", "lib"))).toBe(join(root, "repo", "sub"));
  });

  it("is empty outside git", () => {
    const root = tempDir();
    mkdirSync(join(root, "plain", "deep"), { recursive: true });
    // The temp folder lives outside any repository.
    expect(gitRoot(join(root, "plain", "deep"))).toBe("");
    expect(gitRoot("")).toBe("");
  });
});

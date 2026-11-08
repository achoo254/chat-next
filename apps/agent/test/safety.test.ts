import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDir } from "../src/safety/dirs.ts";
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
    expect(mentionsSensitive("hda pair", check, { home })).toBe(true);
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

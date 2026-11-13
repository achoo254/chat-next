// A profile's home on a fake machine: shared folders link back to the
// machine's Claude folder, settings are copied, .claude.json takes only the
// projects and MCP servers, earlier data is kept aside, unsafe paths are
// refused, deleting a profile never reaches through a link, and a cut
// prompt-history link is noticed and made again without losing a line.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureHistoryLink, historyLinked } from "../src/profiles/history-link.ts";
import { assertProfileId, assertSafeHome, makeProfileHome, profileDir } from "../src/profiles/paths.ts";
import { removeTreeSafely } from "../src/profiles/remove.ts";
import { SHARED_DIRS, ensureSharedDirs, setupProfileHome } from "../src/profiles/setup.ts";
import { tempDir } from "./harness.ts";

const posix = process.platform !== "win32";

/** A machine's Claude folder with some data, a tunelo config folder, and one prepared profile. */
function machine() {
  const root = tempDir("profiles-");
  const claudeHome = join(root, "claude-home");
  const configDir = join(root, "tunelo");
  mkdirSync(join(claudeHome, "projects", "-work-app"), { recursive: true });
  writeFileSync(join(claudeHome, "projects", "-work-app", "s1.jsonl"), "{}\n");
  mkdirSync(join(claudeHome, "skills", "mine"), { recursive: true });
  writeFileSync(join(claudeHome, "skills", "mine", "SKILL.md"), "# skill\n");
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
  writeFileSync(join(claudeHome, "CLAUDE.md"), "shared memory\n");
  writeFileSync(join(claudeHome, "history.jsonl"), '{"display":"first"}\n');
  const machineJson = {
    oauthAccount: { emailAddress: "owner@example.com", organizationUuid: "org-owner" },
    userID: "user-id-of-owner",
    cachedGrowthBookFeatures: { x: 1 },
    projects: { "/work/app": { allowedTools: ["Bash(ls)"] } },
    mcpServers: { files: { command: "files-mcp" } },
  };
  writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify(machineJson));
  const home = makeProfileHome(configDir, "p1", claudeHome);
  return { root, claudeHome, configDir, home, machineJson };
}

describe("profile setup", () => {
  it.skipIf(!posix)("links the shared folders, copies settings and keeps the profile's sign-in its own", () => {
    const { claudeHome, home, machineJson } = machine();
    const { warnings } = setupProfileHome(home, claudeHome);
    expect(warnings).toEqual([]);
    for (const name of SHARED_DIRS) {
      expect(lstatSync(join(home, name)).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(home, name))).toBe(realpathSync(join(claudeHome, name)));
    }
    expect(readFileSync(join(home, "projects", "-work-app", "s1.jsonl"), "utf8")).toBe("{}\n");
    expect(lstatSync(join(home, "sessions")).isDirectory()).toBe(true);
    expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(false);
    expect(historyLinked(home, claudeHome)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ permissions: { defaultMode: "acceptEdits" } });
    expect(lstatSync(join(home, "settings.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe(`@${join(claudeHome, "CLAUDE.md")}\n`);

    const own = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(own).toEqual({ projects: machineJson.projects, mcpServers: machineJson.mcpServers });
    expect(own.oauthAccount).toBeUndefined();
    expect(own.userID).toBeUndefined();
    // The machine's own .claude.json is only read.
    expect(JSON.parse(readFileSync(join(claudeHome, ".claude.json"), "utf8"))).toEqual(machineJson);
  });

  it.skipIf(!posix)("keeps a profile's earlier data beside the link and is safe to run again", () => {
    const { claudeHome, home } = machine();
    mkdirSync(join(home, "plans"));
    writeFileSync(join(home, "plans", "mine.md"), "own plan\n");
    const first = setupProfileHome(home, claudeHome);
    expect(first.warnings.some((w) => w.startsWith("plans:"))).toBe(true);
    expect(readFileSync(join(home, "plans.merge", "mine.md"), "utf8")).toBe("own plan\n");
    expect(lstatSync(join(home, "plans")).isSymbolicLink()).toBe(true);
    expect(setupProfileHome(home, claudeHome).warnings).toEqual([]);
  });

  it("refuses ids and folders that could mix with the machine's Claude folder", () => {
    const { configDir, claudeHome } = machine();
    expect(() => assertProfileId("../x")).toThrow();
    expect(() => assertProfileId("")).toThrow();
    expect(() => assertSafeHome(configDir, join(claudeHome, "p"), claudeHome)).toThrow(/inside/);
    expect(() => assertSafeHome(configDir, join(configDir, "elsewhere", "home"), claudeHome)).toThrow(/claude-profiles/);
    expect(() => makeProfileHome(join(claudeHome, "nested-config"), "p2", join(claudeHome, "nested-config", "claude-profiles", "p2"))).toThrow();
  });

  it.skipIf(!posix)("refuses a profile reached through a link", () => {
    const { root, configDir, claudeHome } = machine();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(configDir, "claude-profiles", "p3"), "dir");
    expect(() => makeProfileHome(configDir, "p3", claudeHome)).toThrow(/link/);
  });
});

describe("profile removal", () => {
  it.skipIf(!posix)("deletes links as links: the machine's Claude folder keeps every file", () => {
    const { claudeHome, configDir, home } = machine();
    setupProfileHome(home, claudeHome);
    writeFileSync(join(home, "sessions", "own.json"), "{}");
    const before = readdirSync(claudeHome, { recursive: true }).sort();
    removeTreeSafely(profileDir(configDir, "p1"));
    expect(existsSync(profileDir(configDir, "p1"))).toBe(false);
    expect(readdirSync(claudeHome, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(join(claudeHome, "skills", "mine", "SKILL.md"), "utf8")).toBe("# skill\n");
    expect(readFileSync(join(claudeHome, "history.jsonl"), "utf8")).toBe('{"display":"first"}\n');
  });

  it("is fine with a folder that is already gone", () => {
    expect(() => removeTreeSafely(join(tempDir(), "missing"))).not.toThrow();
  });
});

describe("shared prompt history", () => {
  it("notices a file claude wrote in place of the link, keeps its new lines and links again", () => {
    const { claudeHome, home } = machine();
    expect(ensureHistoryLink(home, claudeHome)).toBe("linked");
    // claude rewrote the file: a plain file with one line the shared one lacks.
    unlinkSync(join(home, "history.jsonl"));
    writeFileSync(join(home, "history.jsonl"), '{"display":"first"}\n{"display":"from the profile"}\n');
    expect(historyLinked(home, claudeHome)).toBe(false);
    expect(ensureHistoryLink(home, claudeHome)).toBe("repaired");
    expect(historyLinked(home, claudeHome)).toBe(true);
    expect(readFileSync(join(claudeHome, "history.jsonl"), "utf8")).toBe('{"display":"first"}\n{"display":"from the profile"}\n');
    expect(ensureHistoryLink(home, claudeHome)).toBe("linked");
    expect(existsSync(join(home, "..", "history-link.json"))).toBe(false);
  });
});

describe.runIf(posix)("shared folders checked at session start", () => {
  it("links a profile's own projects folder again, its sessions moved into the shared one", () => {
    const { claudeHome, home } = machine();
    setupProfileHome(home, claudeHome);
    // claude (or an earlier version) left a folder of its own where the link was.
    unlinkSync(join(home, "projects"));
    mkdirSync(join(home, "projects", "-work-app"), { recursive: true });
    writeFileSync(join(home, "projects", "-work-app", "s2.jsonl"), "{}\n");
    writeFileSync(join(home, "projects", "-work-app", "s1.jsonl"), "profile copy\n");
    const warnings: string[] = [];
    expect(ensureSharedDirs(home, claudeHome, warnings)).toEqual(["projects"]);
    expect(lstatSync(join(home, "projects")).isSymbolicLink()).toBe(true);
    // A session started under the profile is now where any profile resumes it from.
    expect(existsSync(join(claudeHome, "projects", "-work-app", "s2.jsonl"))).toBe(true);
    // A file both had keeps the machine's copy; the profile's is kept aside, not lost.
    expect(readFileSync(join(claudeHome, "projects", "-work-app", "s1.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(`${join(home, "projects")}.merge`, "-work-app", "s1.jsonl"), "utf8")).toBe("profile copy\n");
    // Once linked, nothing more to do.
    expect(ensureSharedDirs(home, claudeHome, [])).toEqual([]);
  });

  it("links a shared folder the profile never had", () => {
    const { claudeHome, home } = machine();
    setupProfileHome(home, claudeHome);
    unlinkSync(join(home, "skills"));
    expect(ensureSharedDirs(home, claudeHome, [])).toEqual(["skills"]);
    expect(realpathSync(join(home, "skills"))).toBe(realpathSync(join(claudeHome, "skills")));
  });
});

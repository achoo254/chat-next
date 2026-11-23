// Which Claude settings `tunelo observatory install|uninstall` and
// `tunelo uninstall` change: the machine's, also when the command runs in a
// session of a tunelo profile (whose CLAUDE_CONFIG_DIR names the profile's
// home); a CLAUDE_CONFIG_DIR the user set elsewhere is still followed. An
// uninstall run from a profile's session cleans the machine's file, and one
// that leaves hooks behind there says so and fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeSettingsTarget, machineClaudeHome } from "../../src/commands/observatory-command.ts";
import { recordInstall } from "../../src/observatory/install/install-state-file.ts";
import { uninstallObservatory } from "../../src/observatory/install/observatory-install.ts";
import { observatoryHookCounts, parseSettings } from "../../src/observatory/install/observatory-settings-markers.ts";
import { addObservatory } from "../../src/observatory/install/settings-json-observatory.ts";
import { profileHome } from "../../src/providers/claude/accounts/paths.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const SETTINGS = '{\n  "model": "opus"\n}\n';

function machine() {
  const root = obsTempDir("claude-home");
  const home = join(root, "user");
  const config = join(root, "tunelo");
  const machineHome = join(home, ".claude");
  const profile = profileHome(config, "p1");
  for (const dir of [machineHome, profile]) mkdirSync(dir, { recursive: true });
  return { root, home, config, machineHome, profile, data: join(root, "data") };
}

describe("the machine's Claude folder", () => {
  it("is ~/.claude when CLAUDE_CONFIG_DIR names a tunelo profile's home, or nothing", () => {
    const m = machine();
    expect(machineClaudeHome(m.config, { CLAUDE_CONFIG_DIR: m.profile }, m.home)).toBe(join(m.home, ".claude"));
    expect(machineClaudeHome(m.config, {}, m.home)).toBe(join(m.home, ".claude"));
    if (process.platform === "win32") expect(machineClaudeHome(m.config, { CLAUDE_CONFIG_DIR: m.profile.toUpperCase() }, m.home, "win32")).toBe(join(m.home, ".claude"));
  });

  it("follows a CLAUDE_CONFIG_DIR the user set outside tunelo", () => {
    const m = machine();
    const own = join(m.root, "my-claude");
    expect(machineClaudeHome(m.config, { CLAUDE_CONFIG_DIR: own }, m.home)).toBe(own);
    // A sibling whose name only starts like the profiles' folder is not inside it.
    expect(machineClaudeHome(m.config, { CLAUDE_CONFIG_DIR: `${m.config}-other` }, m.home)).toBe(`${m.config}-other`);
  });
});

describe("an uninstall run in a profile's session", () => {
  it("cleans the machine's settings.json, and the profile follows", async () => {
    const m = machine();
    const machineFile = join(m.machineHome, "settings.json");
    const installed = addObservatory(SETTINGS, ["/opt/tunelo/tunelo"], undefined);
    writeFileSync(machineFile, installed.text);
    writeFileSync(join(m.profile, "settings.json"), installed.text);
    const lines: string[] = [];
    const target = claudeSettingsTarget(m.config, (l) => lines.push(l), { env: { CLAUDE_CONFIG_DIR: m.profile }, home: m.home, dataDir: m.data });
    expect(target.claudeHome).toBe(m.machineHome);
    expect(target.profileHomes()).toEqual([m.profile]);
    await recordInstall(target.stateFile, machineFile, installed);
    expect(await uninstallObservatory(target)).toBe(0);
    expect(readFileSync(machineFile, "utf8")).toBe(SETTINGS);
    expect(readFileSync(join(m.profile, "settings.json"), "utf8")).toBe(SETTINGS);
  });

  it("fails, naming the file, when hooks stay in a settings file it checks", async () => {
    const m = machine();
    const machineFile = join(m.machineHome, "settings.json");
    const installed = addObservatory(SETTINGS, ["/opt/tunelo"], undefined);
    writeFileSync(machineFile, installed.text);
    writeFileSync(join(m.profile, "settings.json"), installed.text);
    const lines: string[] = [];
    const target = claudeSettingsTarget(m.config, (l) => lines.push(l), { env: { CLAUDE_CONFIG_DIR: m.profile }, home: m.home, dataDir: m.data });
    // A profile the sync cannot bring in line keeps its hooks: the command says so and fails.
    target.syncProfile = () => undefined;
    expect(await uninstallObservatory(target)).toBe(1);
    expect(lines.join("\n")).toMatch(/NOT uninstalled/);
    expect(lines.join("\n")).toContain(join(m.profile, "settings.json"));
    expect(observatoryHookCounts(parseSettings(readFileSync(machineFile, "utf8")) ?? {})).toEqual({});
  });
});

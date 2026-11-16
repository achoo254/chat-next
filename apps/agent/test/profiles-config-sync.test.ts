// A profile's configuration is the machine's, both ways, with only the account
// its own: the machine's preferences reach the profile, what a profile's
// session changes reaches the machine, the account keys of either side never
// cross, a sync with nothing new writes nothing, and a file caught half
// written is left alone.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAccountKey, syncProfileConfig } from "../src/providers/claude/accounts/config-sync.ts";
import { tempDir } from "./harness.ts";

type Json = Record<string, unknown>;

const read = (file: string): Json => JSON.parse(readFileSync(file, "utf8")) as Json;
const write = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value));

function setup() {
  const root = tempDir("config-sync-");
  const claudeHome = join(root, "claude-home");
  const home = join(root, "profile", "home");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  const machineJson = join(claudeHome, ".claude.json");
  const profileJson = join(home, ".claude.json");
  write(machineJson, {
    oauthAccount: { emailAddress: "owner@example.com" },
    userID: "owner-id",
    cachedGrowthBookFeatures: { owner: true },
    modelAccessCache: { owner: true },
    claudeInChromeDefaultEnabled: true,
    theme: "dark",
    projects: { "/work/a": { allowedTools: ["Bash(ls)"] } },
    mcpServers: { files: { command: "files-mcp" } },
  });
  write(profileJson, {
    oauthAccount: { emailAddress: "max@example.com" },
    userID: "max-id",
    cachedGrowthBookFeatures: { max: true },
  });
  write(join(claudeHome, "settings.json"), { model: "opus" });
  return { claudeHome, home, machineJson, profileJson };
}

describe("account keys", () => {
  it("are the sign-in and what is cached for it, never a preference", () => {
    for (const key of ["oauthAccount", "userID", "cachedGrowthBookFeatures", "modelAccessCache", "groveConfigCache", "passesEligibilityCache", "orgModelDefaultCache", "metricsStatusCacheByPrincipal", "clientDataCacheSlots"]) {
      expect(isAccountKey(key), key).toBe(true);
    }
    for (const key of ["claudeInChromeDefaultEnabled", "theme", "projects", "mcpServers", "autoUpdates", "numStartups", "tipsHistory", "chromeExtension", "editorMode"]) {
      expect(isAccountKey(key), key).toBe(false);
    }
  });
});

describe("syncing a profile's configuration with the machine", () => {
  it("gives the profile every preference of the machine and keeps its own account", () => {
    const s = setup();
    syncProfileConfig(s.home, s.claudeHome);
    const own = read(s.profileJson);
    expect(own).toEqual({
      oauthAccount: { emailAddress: "max@example.com" },
      userID: "max-id",
      cachedGrowthBookFeatures: { max: true },
      claudeInChromeDefaultEnabled: true,
      theme: "dark",
      projects: { "/work/a": { allowedTools: ["Bash(ls)"] } },
      mcpServers: { files: { command: "files-mcp" } },
    });
    expect(read(join(s.home, "settings.json"))).toEqual({ model: "opus" });
    expect(read(s.machineJson).oauthAccount).toEqual({ emailAddress: "owner@example.com" });
  });

  it("takes what a profile's session changed to the machine, account left out", () => {
    const s = setup();
    syncProfileConfig(s.home, s.claudeHome);
    const own = read(s.profileJson);
    own.claudeInChromeDefaultEnabled = false;
    own.projects = { "/work/a": { allowedTools: ["Bash(ls)"] }, "/work/b": { hasTrustDialogAccepted: true } };
    own.cachedGrowthBookFeatures = { max: 2 };
    write(s.profileJson, own);
    write(join(s.home, "settings.json"), { model: "sonnet" });
    // Meanwhile the machine changed another preference and another folder.
    const machine = read(s.machineJson);
    machine.theme = "light";
    machine.projects = { "/work/a": { allowedTools: ["Bash(ls)", "Bash(cat)"] } };
    write(s.machineJson, machine);

    syncProfileConfig(s.home, s.claudeHome);

    const after = read(s.machineJson);
    expect(after.claudeInChromeDefaultEnabled).toBe(false);
    expect(after.theme).toBe("light");
    expect(after.projects).toEqual({ "/work/a": { allowedTools: ["Bash(ls)", "Bash(cat)"] }, "/work/b": { hasTrustDialogAccepted: true } });
    expect(after.oauthAccount).toEqual({ emailAddress: "owner@example.com" });
    expect(after.cachedGrowthBookFeatures).toEqual({ owner: true });
    expect(read(join(s.claudeHome, "settings.json"))).toEqual({ model: "sonnet" });
    const mine = read(s.profileJson);
    expect(mine.theme).toBe("light");
    expect(mine.projects).toEqual(after.projects);
    expect(mine.cachedGrowthBookFeatures).toEqual({ max: 2 });
  });

  it("takes a preference the profile removed off the machine too", () => {
    const s = setup();
    syncProfileConfig(s.home, s.claudeHome);
    const own = read(s.profileJson);
    Reflect.deleteProperty(own, "theme");
    write(s.profileJson, own);
    syncProfileConfig(s.home, s.claudeHome);
    expect("theme" in read(s.machineJson)).toBe(false);
  });

  it("lets the machine win on the first sync of a profile made by an earlier version", () => {
    const s = setup();
    write(join(s.home, "settings.json"), { model: "old" });
    syncProfileConfig(s.home, s.claudeHome);
    expect(read(join(s.claudeHome, "settings.json"))).toEqual({ model: "opus" });
    expect(read(join(s.home, "settings.json"))).toEqual({ model: "opus" });
  });

  it("writes nothing when nothing changed", () => {
    const s = setup();
    syncProfileConfig(s.home, s.claudeHome);
    const before = [statSync(s.machineJson).mtimeMs, statSync(s.profileJson).mtimeMs, statSync(join(s.home, "settings.json")).mtimeMs];
    const machineText = readFileSync(s.machineJson, "utf8");
    syncProfileConfig(s.home, s.claudeHome);
    expect([statSync(s.machineJson).mtimeMs, statSync(s.profileJson).mtimeMs, statSync(join(s.home, "settings.json")).mtimeMs]).toEqual(before);
    expect(readFileSync(s.machineJson, "utf8")).toBe(machineText);
  });

  it("leaves a .claude.json caught half written for the next sync", () => {
    const s = setup();
    syncProfileConfig(s.home, s.claudeHome);
    writeFileSync(s.profileJson, '{"theme": "li');
    syncProfileConfig(s.home, s.claudeHome);
    expect(readFileSync(s.profileJson, "utf8")).toBe('{"theme": "li');
    expect(read(s.machineJson).theme).toBe("dark");
  });
});

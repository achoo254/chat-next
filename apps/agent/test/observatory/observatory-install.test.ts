// `tunelo observatory install|uninstall` on a sample machine in a temp
// folder: the machine's settings.json (the user's hooks, statusLine, env) and
// two Claude profiles that copy it through config-sync. Install asks, backs
// the file up, writes it once however often it runs, and every profile ends
// with exactly one group per event; uninstall gives back the file's bytes.
// Managed settings blocking hooks or setting OpenTelemetry, the user's own
// OpenTelemetry, an old Claude Code: refused, nothing written. The token is
// never printed. The real ~/.claude is never touched.
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkManagedSettings } from "../../src/observatory/install/managed-settings-check.ts";
import { type InstallDeps, installObservatory, installState, refreshInstalledToken, uninstallObservatory } from "../../src/observatory/install/observatory-install.ts";
import { MIN_CLAUDE_VERSION, versionAtLeast } from "../../src/observatory/install/observatory-install-checks.ts";
import { OBSERVED_HOOK_EVENTS, observatoryHookCounts, observatoryOtelEnv, parseSettings } from "../../src/observatory/install/observatory-settings-markers.ts";
import { withObservatory } from "../../src/observatory/install/settings-json-observatory.ts";
import { syncProfileConfig } from "../../src/providers/claude/accounts/config-sync.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const TOKEN = "5e".repeat(32);
const SETTINGS = `{
  "model": "sonnet",
  "statusLine": { "type": "command", "command": "my-status" },
  "env": { "MY_VAR": "kept" },
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "my-stop" }] }]
  }
}
`;

type Machine = { root: string; claudeHome: string; profiles: string[]; managed: string; lines: string[]; asked: string[][]; deps: (over?: Partial<InstallDeps>) => InstallDeps };

/** `settings`: the machine's settings.json, or none when null. */
function machine(settings: string | null = SETTINGS): Machine {
  const root = obsTempDir("install");
  const claudeHome = join(root, "claude");
  mkdirSync(claudeHome, { recursive: true });
  if (settings !== null) writeFileSync(join(claudeHome, "settings.json"), settings);
  const profiles = ["p1", "p2"].map((p) => join(root, "profiles", p, "home"));
  for (const home of profiles) {
    mkdirSync(home, { recursive: true });
    // Profiles already in line with the machine, as tunelo keeps them.
    syncProfileConfig(home, claudeHome);
  }
  const managed = join(root, "managed");
  mkdirSync(managed, { recursive: true });
  const lines: string[] = [];
  const asked: string[][] = [];
  return {
    root,
    claudeHome,
    profiles,
    managed,
    lines,
    asked,
    deps: (over = {}) => ({
      claudeHome,
      profileHomes: () => profiles,
      syncProfile: (home) => syncProfileConfig(home, claudeHome),
      stateFile: join(root, "data", "install-state.json"),
      print: (line) => lines.push(line),
      hookCommand: [join(root, "bin dir", "tunelo.exe")],
      otlpClient: async () => ({ port: 47_311, token: TOKEN }),
      claudeVersion: async () => "2.1.330 (Claude Code)\n",
      managed: () => checkManagedSettings(managed),
      env: {},
      confirm: async (change) => {
        asked.push([...change]);
        return true;
      },
      now: () => Date.UTC(2026, 10, 22, 13, 45, 7),
      ...over,
    }),
  };
}

const read = (file: string): string => readFileSync(file, "utf8");
const counts = (file: string): Record<string, number> => observatoryHookCounts(parseSettings(read(file)) ?? {});

describe("installing for Claude Code sessions outside tunelo", () => {
  it("shows the change without the token, backs the file up, writes once, and every profile copies it exactly once", async () => {
    const m = machine();
    expect(await installObservatory(m.deps())).toBe(0);
    const file = join(m.claudeHome, "settings.json");
    for (const target of [file, ...m.profiles.map((h) => join(h, "settings.json"))]) {
      const c = counts(target);
      for (const event of OBSERVED_HOOK_EVENTS) expect(c[event]).toBe(1);
    }
    expect(m.asked).toHaveLength(1);
    const shown = (m.asked[0] ?? []).join("\n");
    expect(shown).toContain(file);
    expect(shown).toContain("Authorization=Bearer [hidden]");
    expect(shown).not.toContain(TOKEN);
    expect(m.lines.join("\n")).not.toContain(TOKEN);
    const backups = readdirSync(m.claudeHome).filter((n) => n.startsWith("settings.json.tunelo-backup-"));
    expect(backups).toEqual(["settings.json.tunelo-backup-20261122T134507Z"]);
    expect(read(join(m.claudeHome, backups[0] ?? ""))).toBe(SETTINGS);
    if (process.platform !== "win32") expect(statSync(join(m.claudeHome, backups[0] ?? "")).mode & 0o777).toBe(0o600);
    expect(await installState(m.claudeHome)).toEqual({ hooks: true, otel: true });

    // Twice: nothing asked, nothing written, still exactly one each.
    const after = read(file);
    expect(await installObservatory(m.deps())).toBe(0);
    expect(m.asked).toHaveLength(1);
    expect(read(file)).toBe(after);
    for (const home of m.profiles) expect(counts(join(home, "settings.json")).Stop).toBe(1);
    expect(readdirSync(m.claudeHome).filter((n) => n.includes("tunelo-backup")).length).toBe(1);
  });

  it("uninstall gives back the machine's file byte for byte and the profiles follow", async () => {
    const m = machine();
    expect(await installObservatory(m.deps())).toBe(0);
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(join(m.claudeHome, "settings.json"))).toBe(SETTINGS);
    for (const home of m.profiles) expect(read(join(home, "settings.json"))).toBe(SETTINGS);
    expect(await installState(m.claudeHome)).toEqual({ hooks: false, otel: false });
    // Uninstall never restores the backup: a change made meanwhile stays.
    expect(await installObservatory(m.deps())).toBe(0);
    const file = join(m.claudeHome, "settings.json");
    writeFileSync(file, read(file).replace('"sonnet"', '"opus"'));
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(file)).toBe(SETTINGS.replace('"sonnet"', '"opus"'));
  });

  it("a profile's own change made before the install reaches the machine first and is kept", async () => {
    const m = machine();
    const p1 = join(m.profiles[0] ?? "", "settings.json");
    writeFileSync(p1, SETTINGS.replace('"sonnet"', '"haiku"'));
    expect(await installObservatory(m.deps())).toBe(0);
    for (const target of [join(m.claudeHome, "settings.json"), p1]) {
      expect(read(target)).toContain('"haiku"');
      expect(counts(target).SessionStart).toBe(1);
    }
  });

  it("with no settings.json yet, makes one and takes it back to an empty object", async () => {
    const m = machine(null);
    expect(await installObservatory(m.deps())).toBe(0);
    expect(readdirSync(m.claudeHome)).toEqual(["settings.json"]);
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(parseSettings(read(join(m.claudeHome, "settings.json")))).toEqual({});
  });

  it("nothing changes when the person says no or no one is at a terminal", async () => {
    const m = machine();
    expect(await installObservatory(m.deps({ confirm: async () => false }))).toBe(1);
    expect(read(join(m.claudeHome, "settings.json"))).toBe(SETTINGS);
    expect(readdirSync(m.claudeHome).some((n) => n.includes("tunelo-backup"))).toBe(false);
  });

  const refusals: [string, (m: Machine) => Partial<InstallDeps> | undefined, RegExp][] = [
    ["Claude Code is missing", () => ({ claudeVersion: async () => undefined }), /not found/],
    ["Claude Code is too old for exec-form hooks", () => ({ claudeVersion: async () => "2.1.138 (Claude Code)" }), /older than 2\.1\.139/],
    [
      "managed settings block hooks",
      (m) => {
        writeFileSync(join(m.managed, "managed-settings.json"), '{ "allowManagedHooksOnly": true }');
        return undefined;
      },
      /block hooks.*allowManagedHooksOnly/,
    ],
    [
      "a managed drop-in sets OpenTelemetry",
      (m) => {
        mkdirSync(join(m.managed, "managed-settings.d"));
        writeFileSync(join(m.managed, "managed-settings.d", "10-otel.json"), '{ "env": { "OTEL_EXPORTER_OTLP_ENDPOINT": "https://corp" } }');
        return undefined;
      },
      /managed settings set OpenTelemetry/,
    ],
    ["the shell exports OpenTelemetry", () => ({ env: { OTEL_LOGS_EXPORTER: "console" } }), /this shell sets OpenTelemetry/],
    [
      "settings.json has the user's own OpenTelemetry",
      (m) => {
        writeFileSync(join(m.claudeHome, "settings.json"), '{ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_METRICS_EXPORTER": "otlp" } }');
        return undefined;
      },
      /sets OpenTelemetry already \(CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_METRICS_EXPORTER\)/,
    ],
    ["the receiver has no port yet", () => ({ otlpClient: async () => Promise.reject(new Error("start tunelo first")) }), /start tunelo first/],
  ];
  for (const [what, setup, message] of refusals) {
    it(`refuses when ${what}, writing nothing`, async () => {
      const m = machine();
      const over = setup(m);
      const before = read(join(m.claudeHome, "settings.json"));
      expect(await installObservatory(m.deps(over))).toBe(1);
      expect(m.lines.join("\n")).toMatch(message);
      expect(read(join(m.claudeHome, "settings.json"))).toBe(before);
      expect(m.asked).toEqual([]);
      for (const home of m.profiles) expect(counts(join(home, "settings.json"))).toEqual({});
    });
  }
});

describe("a settings.json that changes while the person reads the question", () => {
  it("keeps what was written meanwhile, and the backup holds exactly the content the change starts from", async () => {
    const m = machine();
    const file = join(m.claudeHome, "settings.json");
    const meanwhile = SETTINGS.replace('"sonnet"', '"opus"').replace('"model"', '"theme": "dark",\n  "model"');
    expect(
      await installObservatory(
        m.deps({
          confirm: async () => {
            // Claude Code's /config, or the person in an editor, while the question is open.
            writeFileSync(file, meanwhile);
            return true;
          },
        }),
      ),
    ).toBe(0);
    const after = parseSettings(read(file));
    expect(after?.model).toBe("opus");
    expect(after?.theme).toBe("dark");
    expect(counts(file).SessionStart).toBe(1);
    const backup = readdirSync(m.claudeHome).find((n) => n.startsWith("settings.json.tunelo-backup-"));
    expect(read(join(m.claudeHome, backup ?? ""))).toBe(meanwhile);
    // And the uninstall gives back exactly that content.
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(file)).toBe(meanwhile);
  });

  it("refuses, writing nothing, when the content written meanwhile cannot take Observatory", async () => {
    const m = machine();
    const file = join(m.claudeHome, "settings.json");
    const broken = "{ not json";
    const code = await installObservatory(
      m.deps({
        confirm: async () => {
          writeFileSync(file, broken);
          return true;
        },
      }),
    );
    expect(code).toBe(1);
    expect(read(file)).toBe(broken);
    expect(readdirSync(m.claudeHome).some((n) => n.includes("tunelo-backup"))).toBe(false);
  });
});

describe("containers the user had, even empty", () => {
  for (const original of ["{}", "{ }\n", '{\n  "hooks": {}\n}\n', '{\n  "env": {}\n}\n', '{\n  "hooks": {\n    "Stop": []\n  }\n}\n', '{"model":"opus","hooks":{"Stop":[]},"env":{}}']) {
    it(`come back byte for byte after install and uninstall: ${JSON.stringify(original)}`, async () => {
      const m = machine(original);
      expect(await installObservatory(m.deps())).toBe(0);
      expect(await installObservatory(m.deps())).toBe(0);
      expect(await uninstallObservatory(m.deps())).toBe(0);
      expect(read(join(m.claudeHome, "settings.json"))).toBe(original);
      for (const home of m.profiles) expect(read(join(home, "settings.json"))).toBe(original);
    });
  }
});

describe("a settings.json that is a link or read-only", () => {
  it("is refused before asking: nothing written, no backup", async () => {
    const m = machine();
    const file = join(m.claudeHome, "settings.json");
    chmodSync(file, 0o444);
    try {
      expect(await installObservatory(m.deps())).toBe(1);
      expect(m.lines.join("\n")).toMatch(/read-only/);
      expect(m.asked).toEqual([]);
      expect(read(file)).toBe(SETTINGS);
      expect(readdirSync(m.claudeHome)).toEqual(["settings.json"]);
    } finally {
      chmodSync(file, 0o644);
    }
    // Installed, then locked: the uninstall says so and leaves it.
    expect(await installObservatory(m.deps())).toBe(0);
    const installed = read(file);
    chmodSync(file, 0o444);
    try {
      expect(await uninstallObservatory(m.deps())).toBe(1);
      expect(read(file)).toBe(installed);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("refuses a link, keeping it a link", async (ctx) => {
    const m = machine(null);
    const target = join(m.root, "dotfiles", "settings.json");
    mkdirSync(join(m.root, "dotfiles"), { recursive: true });
    writeFileSync(target, SETTINGS);
    const link = join(m.claudeHome, "settings.json");
    try {
      symlinkSync(target, link);
    } catch {
      // Windows without the right to make links.
      ctx.skip();
    }
    expect(await installObservatory(m.deps())).toBe(1);
    expect(m.lines.join("\n")).toMatch(/is a link/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(target)).toBe(SETTINGS);
    expect(m.asked).toEqual([]);
  });
});

describe("an install record that is missing or out of date", () => {
  it("without a record, the uninstall keeps every container, the user's empty ones among them", async () => {
    const original = '{\n  "hooks": {\n    "Stop": []\n  },\n  "env": {}\n}\n';
    const m = machine(original);
    expect(await installObservatory(m.deps())).toBe(0);
    rmSync(join(m.root, "data", "install-state.json"));
    expect(await uninstallObservatory(m.deps())).toBe(0);
    const after = parseSettings(read(join(m.claudeHome, "settings.json")));
    expect(after?.env).toEqual({});
    expect((after?.hooks as Record<string, unknown[]>).Stop).toEqual([]);
    expect(observatoryHookCounts(after ?? {})).toEqual({});
  });

  it("a record left from an earlier install does not claim containers the user made since", async () => {
    const m = machine('{\n  "model": "opus"\n}\n');
    const file = join(m.claudeHome, "settings.json");
    expect(await installObservatory(m.deps())).toBe(0);
    // The user took Observatory out by hand and keeps empty `hooks` and `env` of their own; the record still names both.
    const theirs = '{\n  "model": "opus",\n  "hooks": {},\n  "env": {}\n}\n';
    writeFileSync(file, theirs);
    for (const home of m.profiles) syncProfileConfig(home, m.claudeHome);
    expect(await installObservatory(m.deps())).toBe(0);
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(file)).toBe(theirs);
  });
});

describe("an install made while the machine's Claude folder was another one", () => {
  /** A second Claude folder (CLAUDE_CONFIG_DIR named it at install time), with its own settings.json. */
  function otherFolder(m: Machine, name: string, settings: string): { home: string; file: string; deps: InstallDeps } {
    const home = join(m.root, name);
    mkdirSync(home, { recursive: true });
    const file = join(home, "settings.json");
    writeFileSync(file, settings);
    // The profiles follow the folder in use at each run; here only the folder itself matters.
    return { home, file, deps: m.deps({ claudeHome: home, profileHomes: () => [], syncProfile: () => undefined }) };
  }

  it("is taken out by the uninstall too, byte for byte, the machine's folder, its profiles and any other settings.json left as they are", async () => {
    const m = machine();
    const alt = otherFolder(m, "custom-claude", SETTINGS.replace('"sonnet"', '"opus"'));
    const untouched = otherFolder(m, "never-installed", SETTINGS);
    expect(await installObservatory(alt.deps)).toBe(0);
    expect(counts(alt.file).SessionStart).toBe(1);
    // Never written there: the hand-made copy of the hooks stays (install did not put it there).
    writeFileSync(untouched.file, read(alt.file));
    const handMade = read(untouched.file);
    const machineFile = join(m.claudeHome, "settings.json");
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(alt.file)).toBe(SETTINGS.replace('"sonnet"', '"opus"'));
    expect(read(machineFile)).toBe(SETTINGS);
    for (const home of m.profiles) expect(read(join(home, "settings.json"))).toBe(SETTINGS);
    expect(read(untouched.file)).toBe(handMade);
    expect(m.lines.at(-1)).toBe(`Observatory is uninstalled from ${alt.file}.`);
    // Nothing recorded any more: a second uninstall finds nothing to take out.
    expect(read(join(m.root, "data", "install-state.json"))).toBe('{"files":{}}');
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(m.lines.at(-1)).toBe("Observatory was not installed for Claude Code sessions outside tunelo.");
  });

  it("whose folder is gone since is forgotten, and one that cannot be written fails the uninstall, telling where", async () => {
    const m = machine();
    const gone = otherFolder(m, "gone", SETTINGS);
    const locked = otherFolder(m, "locked", SETTINGS);
    expect(await installObservatory(gone.deps)).toBe(0);
    expect(await installObservatory(locked.deps)).toBe(0);
    rmSync(gone.home, { recursive: true });
    chmodSync(locked.file, 0o444);
    try {
      expect(await uninstallObservatory(m.deps())).toBe(1);
      expect(m.lines.join("\n")).toContain(locked.file);
      expect(counts(locked.file).SessionStart).toBe(1);
    } finally {
      chmodSync(locked.file, 0o644);
    }
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(read(locked.file)).toBe(SETTINGS);
    expect(read(join(m.root, "data", "install-state.json"))).toBe('{"files":{}}');
  });
});

describe("a settings.json that is a hard link", () => {
  it("is refused by install, uninstall and a token refresh, leaving both names linked and nothing behind", async () => {
    const m = machine(null);
    const source = join(m.root, "dotfiles", "settings.json");
    mkdirSync(join(m.root, "dotfiles"), { recursive: true });
    writeFileSync(source, SETTINGS);
    const file = join(m.claudeHome, "settings.json");
    linkSync(source, file);
    expect(await installObservatory(m.deps())).toBe(1);
    expect(m.lines.join("\n")).toMatch(/hard link/);
    expect(m.asked).toEqual([]);
    expect(statSync(file).nlink).toBe(2);
    expect(readdirSync(m.claudeHome)).toEqual(["settings.json"]);
    // Installed by hand in the source: uninstall and a refresh leave it as it is.
    const installed = withObservatory(SETTINGS, ["/opt/tunelo"], observatoryOtelEnv({ port: 47_311, token: TOKEN }));
    writeFileSync(source, installed);
    expect(await uninstallObservatory(m.deps())).toBe(1);
    expect(await refreshInstalledToken(m.deps(), { port: 47_311, token: "ab".repeat(32) })).toBe(false);
    expect(read(file)).toBe(installed);
    expect(statSync(file).nlink).toBe(2);
  });
});

describe("the edges of a write", () => {
  it("a file changed between the read and the write is left alone: no backup, no record", async () => {
    const m = machine();
    const file = join(m.claudeHome, "settings.json");
    const other = '{\n  "model": "haiku"\n}\n';
    let calls = 0;
    const code = await installObservatory(
      m.deps({
        // Called once, as the backup is named: right before the write, someone else writes the file.
        now: () => {
          if (++calls === 1) writeFileSync(file, other);
          return Date.UTC(2026, 10, 22, 13, 45, 7);
        },
      }),
    );
    expect(code).toBe(1);
    expect(m.lines.join("\n")).toMatch(/changed while tunelo was writing it/);
    expect(read(file)).toBe(other);
    expect(readdirSync(m.claudeHome)).toEqual(["settings.json"]);
    expect(existsSync(join(m.root, "data", "install-state.json")) ? read(join(m.root, "data", "install-state.json")) : '{"files":{}}').toBe('{"files":{}}');
  });

  it("two installs in the same second keep two backups", async () => {
    const m = machine();
    expect(await installObservatory(m.deps())).toBe(0);
    expect(await uninstallObservatory(m.deps())).toBe(0);
    expect(await installObservatory(m.deps())).toBe(0);
    expect(readdirSync(m.claudeHome).filter((n) => n.includes("tunelo-backup")).sort()).toEqual(["settings.json.tunelo-backup-20261122T134507Z", "settings.json.tunelo-backup-20261122T134507Z-2"]);
  });

  it("a file naming `hooks` or `env` twice is refused before asking", async () => {
    for (const text of ['{"hooks": {}, "hooks": {"Stop": []}}', '{"env": {"A": "1"}, "env": {}}']) {
      const m = machine(text);
      expect(await installObservatory(m.deps())).toBe(1);
      expect(m.lines.join("\n")).toMatch(/more than once/);
      expect(m.asked).toEqual([]);
      expect(read(join(m.claudeHome, "settings.json"))).toBe(text);
    }
  });
});

describe("the minimum Claude Code", () => {
  it("compares the version claude prints", () => {
    expect(versionAtLeast("2.1.139 (Claude Code)", MIN_CLAUDE_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.330", MIN_CLAUDE_VERSION)).toBe(true);
    expect(versionAtLeast("2.2.0", MIN_CLAUDE_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.99", MIN_CLAUDE_VERSION)).toBe(false);
    expect(versionAtLeast("1.9.999", MIN_CLAUDE_VERSION)).toBe(false);
    expect(versionAtLeast("garbage", MIN_CLAUDE_VERSION)).toBe(false);
  });
});

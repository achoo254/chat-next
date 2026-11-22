// `tunelo observatory install|uninstall`: Observatory for the Claude Code
// sessions started outside tunelo. Only the machine's settings.json is
// written (the machine's Claude folder); the profiles copy it
// (providers/claude/accounts/config-sync.ts), which this command runs before
// the change (so a profile's own pending change reaches the machine first) and
// after it, then checks that each profile holds exactly one Observatory group
// per event, or none after an uninstall.
//
// Install checks first (observatory-install-checks.ts), prints exactly what it
// adds (the token hidden) and asks. Then it reads the file again: what anyone
// wrote while the person read the question is kept, the change made on that
// content. The backup holds exactly the text the change starts from, and the
// file is replaced only if it still holds that text right before (otherwise
// nothing is written and the backup goes). The containers the install made
// are recorded (install-state-file.ts); the uninstall takes out exactly what
// install added, giving the file its bytes back, and never restores a backup
// over the file.
import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { forgetCreated, installRecord, recordInstall } from "./install-state-file.ts";
import type { ManagedVerdict } from "./managed-settings-check.ts";
import { type InstallCheckDeps, describeChange, machineRefusal, settingsFileProblem, settingsRefusal, settingsTextRefusal } from "./observatory-install-checks.ts";
import { OBSERVED_HOOK_EVENTS, observatoryEnvKeys, observatoryHookCounts, observatoryOtelEnv, parseSettings } from "./observatory-settings-markers.ts";
import { addObservatory, samePath, stillOnlyObservatory, withRefreshedObservatoryEnv, withoutObservatory } from "./settings-json-observatory.ts";

export type SettingsTarget = {
  /** The machine's Claude folder; its settings.json is the only file written. */
  claudeHome: string;
  /** The homes of the Claude profiles, which copy the machine's settings. */
  profileHomes: () => string[];
  /** Makes a profile's settings the machine's again (config-sync.ts syncProfileConfig). */
  syncProfile: (profileHome: string) => void;
  /** Where the install records the containers it made (install-state-file.ts). */
  stateFile: string;
  print: (line: string) => void;
};

export type InstallDeps = SettingsTarget &
  InstallCheckDeps & {
    /** tunelo and the arguments before `observatory hook <event>` (service.ts selfCommand). */
    hookCommand: readonly string[];
    /** The receiver's port and token; rejects with a message for the user when there is none yet. */
    otlpClient: () => Promise<{ port: number; token: string }>;
    managed: () => Promise<ManagedVerdict>;
    /** Shows the change and asks; true to go on. */
    confirm: (change: readonly string[]) => Promise<boolean>;
    now: () => number;
  };

const settingsFile = (home: string): string => join(home, "settings.json");

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The file changed after it was read for the change; nothing was written. */
class ChangedMeanwhile extends Error {
  override readonly name = "ChangedMeanwhile";
}

/**
 * Replaces `file` with `text` at once (a temp file renamed), keeping its mode
 * (0600 for a new file), only while it still holds `expected` (undefined: no
 * file); throws ChangedMeanwhile otherwise, writing nothing.
 */
async function writeWhole(file: string, text: string, expected: string | undefined): Promise<void> {
  const mode = await stat(file).then(
    (s) => s.mode & 0o777,
    () => 0o600,
  );
  const tmp = `${file}.tunelo-${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    if ((await readText(file)) !== expected) throw new ChangedMeanwhile(`${file} changed while tunelo was writing it; nothing was written, run the command again`);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Writes `content` beside `file` as a timestamped backup (0600), never over an earlier one; its path. */
async function writeBackup(file: string, content: string, now: number): Promise<string> {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  for (let n = 1; ; n++) {
    const backup = `${file}.tunelo-backup-${stamp}${n > 1 ? `-${n}` : ""}`;
    try {
      await writeFile(backup, content, { mode: 0o600, flag: "wx" });
      await chmod(backup, 0o600);
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw err;
    }
  }
}

function syncProfiles(t: SettingsTarget): void {
  for (const home of t.profileHomes()) {
    try {
      t.syncProfile(home);
    } catch (err) {
      t.print(`  Warning: could not bring the profile at ${home} in line with the machine (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
}

/** The places holding the wrong number of Observatory groups: each event once after an install (`expected` 1), none after an uninstall. */
async function misplaced(t: SettingsTarget, expected: 0 | 1): Promise<string[]> {
  const wrong: string[] = [];
  for (const home of [t.claudeHome, ...t.profileHomes()]) {
    const settings = parseSettings(await readText(settingsFile(home)).catch(() => undefined));
    if (!settings) {
      wrong.push(`${settingsFile(home)} (not readable)`);
      continue;
    }
    const counts = observatoryHookCounts(settings);
    const ok = expected === 1 ? OBSERVED_HOOK_EVENTS.every((e) => counts[e] === 1) : Object.keys(counts).length === 0;
    if (!ok) wrong.push(settingsFile(home));
  }
  return wrong;
}

const refuse = (t: SettingsTarget, why: string): number => {
  t.print(`tunelo: cannot install Observatory: ${why}`);
  return 1;
};

/** Installs the hooks and the OTel environment into the machine's settings.json; resolves with the exit code. */
export async function installObservatory(deps: InstallDeps): Promise<number> {
  const file = settingsFile(deps.claudeHome);
  syncProfiles(deps);
  const problem = await settingsFileProblem(file);
  if (problem) return refuse(deps, `${problem}.`);
  const shown = (await readText(file)) ?? "";
  const why = (await machineRefusal(deps)) ?? settingsRefusal(file, shown);
  if (why) return refuse(deps, why);
  let client: { port: number; token: string };
  try {
    client = await deps.otlpClient();
  } catch (err) {
    return refuse(deps, err instanceof Error ? err.message : String(err));
  }
  const env = observatoryOtelEnv(client);
  const earlier = await installRecord(deps.stateFile, file);
  let changed = false;
  if (addObservatory(shown, deps.hookCommand, env, earlier?.indent).text !== shown) {
    if (!(await deps.confirm(describeChange(file, deps.hookCommand, env)))) {
      deps.print("Nothing changed.");
      return 1;
    }
    // Read again: what was written while the person read the question stays, the change is made on it.
    const problemNow = await settingsFileProblem(file);
    if (problemNow) return refuse(deps, `${problemNow}.`);
    const current = await readText(file);
    const base = current ?? "";
    const whyNow = settingsRefusal(file, base);
    if (whyNow) return refuse(deps, whyNow);
    const plan = addObservatory(base, deps.hookCommand, env, earlier?.indent);
    if (plan.text !== base) {
      // What an earlier install made and still holds only Observatory's entries stays recorded; what the user changed since does not.
      const kept = (earlier?.created ?? []).filter((path) => stillOnlyObservatory(base, path));
      const made = plan.created.filter((path) => !kept.some((k) => samePath(k, path)));
      const record = { created: [...kept, ...made], indent: earlier?.indent ?? plan.indent };
      // The record first: a settings file changed with nothing recorded could not be given back byte for byte.
      await recordInstall(deps.stateFile, file, record);
      const backup = current !== undefined && current !== "" ? await writeBackup(file, current, deps.now()) : undefined;
      try {
        await writeWhole(file, plan.text, current);
      } catch (err) {
        if (backup) await rm(backup, { force: true });
        await (earlier ? recordInstall(deps.stateFile, file, earlier) : forgetCreated(deps.stateFile, file)).catch(() => undefined);
        if (err instanceof ChangedMeanwhile) return refuse(deps, err.message);
        throw err;
      }
      if (backup) deps.print(`  Backed up ${file} to ${backup}.`);
      changed = true;
    }
  }
  syncProfiles(deps);
  const wrong = await misplaced(deps, 1);
  if (wrong.length > 0) {
    deps.print(`tunelo: Observatory's hooks are not in place exactly once in: ${wrong.join(", ")}. Run \`tunelo observatory install\` again; \`tunelo observatory uninstall\` takes them out.`);
    return 1;
  }
  deps.print(changed ? "Observatory is installed: Claude Code sessions started from now on report to tunelo. `tunelo observatory uninstall` takes it out." : "Observatory is already installed for Claude Code sessions outside tunelo.");
  return 0;
}

/** Takes Observatory's hook groups and OTel keys out of the machine's settings.json; resolves with the exit code. */
export async function uninstallObservatory(t: SettingsTarget): Promise<number> {
  const file = settingsFile(t.claudeHome);
  syncProfiles(t);
  const text = await readText(file);
  if (text === undefined) return 0;
  const textWhy = settingsTextRefusal(file, text);
  if (textWhy) {
    t.print(`tunelo: cannot uninstall Observatory: ${textWhy} Observatory's entries were left in it.`);
    return 1;
  }
  const next = withoutObservatory(text, await installRecord(t.stateFile, file));
  if (next !== text) {
    const problem = await settingsFileProblem(file);
    if (problem) {
      t.print(`tunelo: cannot uninstall Observatory: ${problem}; remove the hooks running \`tunelo observatory hook\` there yourself.`);
      return 1;
    }
    try {
      await writeWhole(file, next, text);
    } catch (err) {
      if (!(err instanceof ChangedMeanwhile)) throw err;
      t.print(`tunelo: ${err.message}`);
      return 1;
    }
  }
  await forgetCreated(t.stateFile, file);
  syncProfiles(t);
  const wrong = await misplaced(t, 0);
  if (wrong.length > 0) {
    t.print(`tunelo: Observatory is NOT uninstalled: its hooks are still in ${wrong.join(", ")}. Remove the hooks running \`tunelo observatory hook\` there, or run \`tunelo observatory uninstall\` again.`);
    return 1;
  }
  t.print(next === text ? "Observatory was not installed for Claude Code sessions outside tunelo." : `Observatory is uninstalled from ${file}.`);
  return 0;
}

/**
 * After a token rotation: the token in the machine's settings.json (when
 * install wrote one) becomes the new one, and the profiles copy it. Resolves
 * with whether the file changed; a link, a read-only file or a file changed
 * meanwhile is left as it is, with a line telling so.
 */
export async function refreshInstalledToken(t: SettingsTarget, client: { port: number; token: string }): Promise<boolean> {
  const file = settingsFile(t.claudeHome);
  syncProfiles(t);
  const text = await readText(file);
  if (text === undefined) return false;
  if (settingsTextRefusal(file, text) !== undefined) return false;
  const next = withRefreshedObservatoryEnv(text, observatoryOtelEnv(client));
  if (next === text) return false;
  const problem = await settingsFileProblem(file);
  try {
    if (problem) throw new ChangedMeanwhile(problem);
    await writeWhole(file, next, text);
  } catch (err) {
    if (!(err instanceof ChangedMeanwhile)) throw err;
    t.print(`  Warning: the installed settings keep the previous token (${err.message}); sessions outside tunelo stop reporting after the next rotation unless \`tunelo observatory install\` runs again.`);
    return false;
  }
  syncProfiles(t);
  return true;
}

/** Whether the machine's settings.json holds Observatory's hooks and OTel keys. */
export async function installState(claudeHome: string): Promise<{ hooks: boolean; otel: boolean } | undefined> {
  const settings = parseSettings(await readText(settingsFile(claudeHome)).catch(() => undefined));
  if (!settings) return undefined;
  return { hooks: Object.keys(observatoryHookCounts(settings)).length > 0, otel: observatoryEnvKeys(settings.env).length > 0 };
}

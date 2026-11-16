// A profile is the machine's Claude with another sign-in, nothing more: its
// settings, key bindings and every preference of .claude.json are the
// machine's own, both ways. A change made on the machine reaches the profile,
// and a change a profile's session makes (a toggle, /model, a trusted folder,
// an MCP server) reaches the machine and from there every other profile.
//
// Only the account stays the profile's: the sign-in itself (claude keeps it in
// the Keychain or a credentials file, which tunelo never touches) and the keys
// of .claude.json that describe or cache the account (isAccountKey).
//
// What was last made equal is remembered beside the profile's home
// (config-sync.json, digests only), so a sync knows which side changed: what
// the profile changed since then goes to the machine first, then the profile
// takes the machine's. A file is only written when its content differs, so a
// sync answering its own write finds nothing to do.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { claudeJsonOf } from "./paths.ts";

/** Files of the machine's Claude folder a profile keeps equal to the machine's, whole. */
export const MACHINE_SETTINGS_FILES = ["settings.json", "keybindings.json"] as const;

/** The global config file in a profile's home (claude reads it there under CLAUDE_CONFIG_DIR). */
export const CLAUDE_JSON = ".claude.json";

/** Where a profile remembers what was last made equal; beside its home, tunelo's own. */
export const SYNC_STATE = "config-sync.json";

/** Keys of .claude.json that are who the profile is signed in as. */
const ACCOUNT_KEYS = new Set([
  "oauthAccount",
  "userID",
  "anonymousId",
  "primaryApiKey",
  "customApiKeyResponses",
  "claudeCodeFirstTokenDate",
  "claudeAiMcpEverConnected",
  "mcpNeedsAuthNoticed",
  "hasAvailableSubscription",
  "recommendedSubscription",
  "managedSettingsNoticeSeenOrg",
  "fable51OrgPickMoveDone",
]);

/**
 * Keys that cache what the account may use (plan, organization, models,
 * feature flags, usage). claude fetches them again for whoever is signed in,
 * so sharing one would only show another account's answer for a while.
 */
const ACCOUNT_CACHE = /^cached|cache$|cacheslots$|byprincipal$|^grove|subscription|eligibility|^s1m|^org[A-Z]|apikey|oauth/i;

/** True for a .claude.json key that belongs to the account, not to the machine. */
export function isAccountKey(key: string): boolean {
  return ACCOUNT_KEYS.has(key) || ACCOUNT_CACHE.test(key);
}

type Json = Record<string, unknown>;

type SyncState = {
  files: Record<string, string>;
  /** Digest of each shared top-level key; "projects" is kept per folder. */
  keys: Record<string, string>;
  projects: Record<string, string>;
};

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** A JSON object file; {} when missing. undefined when it cannot be read as one (claude may be writing it). */
function readJson(file: string): Json | undefined {
  const text = readText(file);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Writes through a temp file and a rename, as claude does; nothing when the content is already there. */
function writeIfChanged(file: string, content: string): boolean {
  if (readText(file) === content) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

function readState(file: string): SyncState | undefined {
  const raw = readJson(file);
  if (!raw || !isRecord(raw.files) || !isRecord(raw.keys) || !isRecord(raw.projects)) return undefined;
  return { files: raw.files as Record<string, string>, keys: raw.keys as Record<string, string>, projects: raw.projects as Record<string, string> };
}

/** The shared part of a .claude.json: everything but the account. */
function sharedPart(json: Json): Json {
  return Object.fromEntries(Object.entries(json).filter(([key]) => !isAccountKey(key)));
}

/** The settings files: what the profile changed goes to the machine, then the profile takes the machine's. */
function syncFiles(home: string, claudeHome: string, last: SyncState | undefined, next: SyncState): void {
  for (const name of MACHINE_SETTINGS_FILES) {
    const mine = join(home, name);
    const machine = join(claudeHome, name);
    const own = readText(mine);
    const before = last?.files[name];
    if (own !== undefined && before !== undefined && digest(own) !== before && own !== readText(machine)) {
      writeIfChanged(machine, own);
    }
    const shared = readText(machine);
    if (shared === undefined) rmSync(mine, { force: true });
    else writeIfChanged(mine, shared);
    next.files[name] = digest(shared ?? null);
  }
}

/** The keys (and project folders) the profile changed since the last sync, applied onto the machine's. */
function pushChanges(own: Json, machine: Json, last: SyncState): boolean {
  let changed = false;
  const ownShared = sharedPart(own);
  const keys = new Set([...Object.keys(ownShared), ...Object.keys(last.keys)]);
  for (const key of keys) {
    if (key === "projects") continue;
    if (digest(ownShared[key] ?? null) === (last.keys[key] ?? digest(null))) continue;
    if (key in ownShared) machine[key] = ownShared[key];
    else Reflect.deleteProperty(machine, key);
    changed = true;
  }
  const ownProjects = isRecord(own.projects) ? own.projects : {};
  const machineProjects = isRecord(machine.projects) ? { ...machine.projects } : {};
  let projectsChanged = false;
  for (const path of new Set([...Object.keys(ownProjects), ...Object.keys(last.projects)])) {
    if (digest(ownProjects[path] ?? null) === (last.projects[path] ?? digest(null))) continue;
    if (path in ownProjects) machineProjects[path] = ownProjects[path];
    else Reflect.deleteProperty(machineProjects, path);
    projectsChanged = true;
  }
  if (projectsChanged) machine.projects = machineProjects;
  return changed || projectsChanged;
}

/** .claude.json: the profile's changes to the machine first, then the machine's preferences with the profile's account. */
function syncClaudeJson(home: string, claudeHome: string, last: SyncState | undefined, next: SyncState): void {
  const mineFile = join(home, CLAUDE_JSON);
  const machineFile = claudeJsonOf(claudeHome);
  const own = readJson(mineFile);
  let machine = readJson(machineFile);
  // A file caught half written is left for the next sync rather than overwritten with a guess.
  if (!own || !machine) {
    if (last) Object.assign(next, { keys: last.keys, projects: last.projects });
    return;
  }
  if (last && pushChanges(own, machine, last)) {
    writeIfChanged(machineFile, JSON.stringify(machine, null, 2));
    machine = readJson(machineFile) ?? machine;
  }
  const account = Object.fromEntries(Object.entries(own).filter(([key]) => isAccountKey(key)));
  const shared = sharedPart(machine);
  const merged = { ...shared, ...account };
  if (!isDeepStrictEqual(merged, own)) writeIfChanged(mineFile, JSON.stringify(merged, null, 2));
  for (const [key, value] of Object.entries(shared)) if (key !== "projects") next.keys[key] = digest(value);
  const projects = isRecord(shared.projects) ? shared.projects : {};
  for (const [path, value] of Object.entries(projects)) next.projects[path] = digest(value);
}

/**
 * Makes a profile's configuration the machine's again, keeping what the
 * profile changed since the last sync (it goes to the machine first) and the
 * profile's account. `home` is the profile's home; its state file sits beside it.
 */
export function syncProfileConfig(home: string, claudeHome: string): void {
  const stateFile = join(dirname(home), SYNC_STATE);
  const last = existsSync(stateFile) ? readState(stateFile) : undefined;
  const next: SyncState = { files: {}, keys: {}, projects: {} };
  syncFiles(home, claudeHome, last, next);
  syncClaudeJson(home, claudeHome, last, next);
  writeIfChanged(stateFile, JSON.stringify(next));
}

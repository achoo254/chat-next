// Fills a new profile's home so that only the sign-in is its own: every
// folder of the machine's Claude folder (projects, plans, skills, hooks,
// chrome…) links back to it (junctions on Windows, symlinks elsewhere), except
// the few that are one claude process's own (PROFILE_OWN_DIRS); the prompt
// history is shared (history-link.ts); settings, key bindings and the
// preferences of .claude.json are kept equal to the machine's both ways
// (config-sync.ts, at every session start and whenever either side changes);
// CLAUDE.md imports the shared one.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureHistoryLink } from "./history-link.ts";
import { syncProfileConfig } from "./config-sync.ts";
import { samePath } from "./paths.ts";
import { sameVolume } from "./volume.ts";

/** Folders every profile shares with the machine's Claude folder. */
export const SHARED_DIRS = [
  "projects",
  "todos",
  "plans",
  "tasks",
  "file-history",
  "shell-snapshots",
  "session-env",
  "paste-cache",
  "transcripts",
  "skills",
  "agents",
  "hooks",
  "rules",
  "plugins",
  "output-styles",
  "scripts",
] as const;

/**
 * Folders that belong to one claude process or one sign-in, never shared:
 * running sessions, backups of the profile's own .claude.json, caches and
 * telemetry of the account.
 */
export const PROFILE_OWN_DIRS = ["sessions", "backups", "cache", "telemetry", "statsig", "debug"] as const;

/**
 * Every folder a profile links to the machine's: the known ones (made on the
 * machine when missing) and any other folder the machine's Claude has, so a
 * folder a new claude version or a plugin adds is shared too.
 */
export function sharedDirNames(claudeHome: string): string[] {
  const names = new Set<string>(SHARED_DIRS);
  const own = new Set<string>(PROFILE_OWN_DIRS);
  try {
    for (const entry of readdirSync(claudeHome, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !own.has(entry.name)) names.add(entry.name);
    }
  } catch {
    // a machine folder not made yet has only the known ones
  }
  return [...names];
}

export type SetupResult = { warnings: string[] };

function linkDir(target: string, link: string): void {
  if (process.platform === "win32") symlinkSync(target, link, "junction");
  else symlinkSync(target, link, "dir");
}

function pointsTo(link: string, target: string): boolean {
  try {
    return realpathSync.native(link) === realpathSync.native(target);
  } catch {
    return false;
  }
}

/** A free name beside `path` for data that was there before the link. */
function mergeName(path: string): string {
  let name = `${path}.merge`;
  for (let i = 2; existsSync(name); i++) name = `${path}.merge-${i}`;
  return name;
}

function shareDir(home: string, claudeHome: string, name: string, warnings: string[]): void {
  const target = join(claudeHome, name);
  const link = join(home, name);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    if (pointsTo(link, target)) return;
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  } else if (st?.isDirectory() && readdirSync(link).length === 0) {
    rmdirSync(link);
  } else if (st) {
    // The profile already had data of its own here: keep it beside the link.
    const kept = mergeName(link);
    renameSync(link, kept);
    warnings.push(`${name}: the profile's own copy was kept as ${kept}`);
  }
  if (!sameVolume(home, claudeHome)) {
    mkdirSync(link, { recursive: true, mode: 0o700 });
    warnings.push(`${name}: the profile is on another drive than the Claude folder, so it keeps its own`);
    return;
  }
  linkDir(target, link);
}

/** Moves into `to` what only `from` has, folder by folder; a file both have stays where it is. */
function moveMissing(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (!existsSync(dst)) {
      renameSync(src, dst);
    } else if (entry.isDirectory() && lstatSync(dst).isDirectory()) {
      moveMissing(src, dst);
      if (readdirSync(src).length === 0) rmdirSync(src);
    }
  }
}

/**
 * Checks the shared folders of a profile at every session start, as the
 * prompt history is: a profile made by an earlier version, or one where
 * claude wrote a folder of its own before the link, would otherwise keep its
 * sessions apart, and `claude --resume` under it finds no conversation
 * started under another profile. What only the profile has moves into the
 * machine's folder first, so nothing is lost; the rest is kept beside the
 * link as at setup. Returns the folders linked again.
 */
export function ensureSharedDirs(home: string, claudeHome: string, warnings: string[]): string[] {
  if (!sameVolume(home, claudeHome)) return []; // no link is possible: the profile keeps its own, as at setup
  const repaired: string[] = [];
  for (const name of sharedDirNames(claudeHome)) {
    const link = join(home, name);
    const target = join(claudeHome, name);
    let st;
    try {
      st = lstatSync(link);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink() && pointsTo(link, target)) continue;
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      moveMissing(link, target);
    }
    shareDir(home, claudeHome, name, warnings);
    repaired.push(name);
  }
  return repaired;
}

/** How the profile's CLAUDE.md names the shared one. */
function sharedMemoryRef(claudeHome: string): string {
  return samePath(claudeHome, join(homedir(), ".claude")) ? "~/.claude/CLAUDE.md" : join(claudeHome, "CLAUDE.md");
}

/** Prepares `home` (already created, 0700) as a profile of `claudeHome`. */
export function setupProfileHome(home: string, claudeHome: string): SetupResult {
  const warnings: string[] = [];
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  for (const name of sharedDirNames(claudeHome)) shareDir(home, claudeHome, name, warnings);
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
  ensureHistoryLink(home, claudeHome, (w) => warnings.push(w));
  const memory = join(home, "CLAUDE.md");
  if (existsSync(join(claudeHome, "CLAUDE.md")) && !existsSync(memory)) {
    writeFileSync(memory, `@${sharedMemoryRef(claudeHome)}\n`, { mode: 0o600 });
  }
  syncProfileConfig(home, claudeHome);
  return { warnings };
}

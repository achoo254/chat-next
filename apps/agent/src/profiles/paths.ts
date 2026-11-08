// Where Claude profiles live and the checks every path goes through before
// tunelo creates, links or deletes anything there. A profile is
// <tunelo config>/claude-profiles/<id>/home, handed to claude as
// CLAUDE_CONFIG_DIR; the default profile is the machine's own Claude folder.
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** The folder holding every profile and profiles.json. */
export function profilesRoot(configDir: string): string {
  return join(configDir, "claude-profiles");
}

/** The folder of one profile (home plus tunelo's own marker files). */
export function profileDir(configDir: string, id: string): string {
  assertProfileId(id);
  return join(profilesRoot(configDir), id);
}

/** What claude gets as CLAUDE_CONFIG_DIR for this profile. */
export function profileHome(configDir: string, id: string): string {
  return join(profileDir(configDir, id), "home");
}

export function assertProfileId(id: string): void {
  if (!PROFILE_ID_RE.test(id)) throw new Error("not a profile id");
}

/**
 * The machine's own Claude folder: CLAUDE_CONFIG_DIR as the service was
 * started with it, else ~/.claude. Profiles link their shared folders to it.
 */
export function defaultClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CLAUDE_CONFIG_DIR;
  return set ? resolve(set) : join(homedir(), ".claude");
}

/**
 * The global config file claude keeps beside its folder: <dir>/.claude.json
 * when the folder was set with CLAUDE_CONFIG_DIR, ~/.claude.json for ~/.claude.
 */
export function claudeJsonOf(claudeHome: string): string {
  const inside = join(claudeHome, ".claude.json");
  if (samePath(claudeHome, join(homedir(), ".claude"))) return join(homedir(), ".claude.json");
  return inside;
}

const caseless = process.platform === "win32" || process.platform === "darwin";

export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** True when `child` is `parent` or inside it (no resolving of links). */
export function isInside(child: string, parent: string): boolean {
  const c = caseless ? resolve(child).toLowerCase() : resolve(child);
  const p = caseless ? resolve(parent).toLowerCase() : resolve(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuses a profile home that would mix with the machine's Claude folder
 * (inside it or holding it), and any link on the way from the profiles root
 * down to the home: tunelo only ever writes and deletes there.
 */
export function assertSafeHome(configDir: string, home: string, claudeHome: string): void {
  if (isInside(home, claudeHome) || isInside(claudeHome, home)) {
    throw new Error("a profile folder may not be inside the machine's Claude folder or hold it");
  }
  const root = profilesRoot(configDir);
  if (!isInside(home, root) || samePath(home, root)) throw new Error("a profile folder must be under claude-profiles");
  const parts = relative(root, home).split(sep).filter(Boolean);
  let cur = root;
  for (const part of ["", ...parts]) {
    cur = part === "" ? cur : join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // not created yet: nothing below it can be a link
    }
    if (st.isSymbolicLink()) throw new Error("a profile folder may not be reached through a link");
    if (!st.isDirectory()) throw new Error("a profile folder path holds a file");
  }
}

/** Creates the profiles root and a profile's home, 0700. */
export function makeProfileHome(configDir: string, id: string, claudeHome: string): string {
  const home = profileHome(configDir, id);
  assertSafeHome(configDir, home, claudeHome);
  mkdirSync(profilesRoot(configDir), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assertSafeHome(configDir, home, claudeHome);
  return home;
}

// Where Claude's saved accounts (profiles) live. A profile is
// <tunelo config>/ai-accounts/claude/<id>/home, handed to claude as
// CLAUDE_CONFIG_DIR; the default profile is the machine's own Claude folder.
// The checks every path goes through are the shared ones (accounts/paths.ts),
// with the machine's Claude folder kept apart.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ACCOUNT_ID_RE, accountDir, assertAccountId, assertSafeAccountPath, providerAccountsRoot, samePath } from "../../../accounts/paths.ts";

export { samePath };

/** Claude's id in the registry. */
export const CLAUDE_PROVIDER_ID = "claude";

export const PROFILE_ID_RE = ACCOUNT_ID_RE;

/** The folder holding every Claude profile. */
export function profilesRoot(configDir: string): string {
  return providerAccountsRoot(configDir, CLAUDE_PROVIDER_ID);
}

/** The folder of one profile (home plus tunelo's own marker files). */
export function profileDir(configDir: string, id: string): string {
  return accountDir(configDir, CLAUDE_PROVIDER_ID, id);
}

/** What claude gets as CLAUDE_CONFIG_DIR for this profile. */
export function profileHome(configDir: string, id: string): string {
  return join(profileDir(configDir, id), "home");
}

export function assertProfileId(id: string): void {
  assertAccountId(id);
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

/**
 * Refuses a profile home that would mix with the machine's Claude folder
 * (inside it or holding it), and any link on the way from the accounts root
 * down to the home: tunelo only ever writes and deletes there.
 */
export function assertSafeHome(configDir: string, home: string, claudeHome: string): void {
  assertSafeAccountPath(configDir, CLAUDE_PROVIDER_ID, home, [claudeHome]);
}

/** Creates a profile's home under the accounts root, 0700. */
export function makeProfileHome(configDir: string, id: string, claudeHome: string): string {
  const home = profileHome(configDir, id);
  assertSafeHome(configDir, home, claudeHome);
  mkdirSync(profilesRoot(configDir), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  assertSafeHome(configDir, home, claudeHome);
  return home;
}

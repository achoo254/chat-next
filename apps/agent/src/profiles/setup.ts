// Fills a new profile's home so that only the sign-in is its own: the
// folders of projects, plans, skills, hooks… link back to the machine's
// Claude folder (junctions on Windows, symlinks elsewhere), the prompt
// history is shared (history-link.ts), settings and key bindings are copied,
// CLAUDE.md imports the shared one, and the profile's .claude.json gets the
// projects and MCP servers of the machine's own. The machine's .claude.json
// is only read, and only those two keys: never its account or user id.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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
import { claudeJsonOf, samePath } from "./paths.ts";
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

/** Copied once; claude rewrites them in place, which would cut a link. */
const COPIED_FILES = ["settings.json", "keybindings.json"] as const;

/** Keys of the machine's .claude.json a profile takes over. */
const MERGED_KEYS = ["projects", "mcpServers"] as const;

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

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The profile's .claude.json with the machine's projects and MCP servers added. */
function mergeClaudeJson(home: string, claudeHome: string): void {
  const machine = readJson(claudeJsonOf(claudeHome));
  const file = join(home, ".claude.json");
  const own = readJson(file);
  for (const key of MERGED_KEYS) {
    const shared = machine[key];
    if (!isRecord(shared)) continue;
    const mine = own[key];
    own[key] = { ...shared, ...(isRecord(mine) ? mine : {}) };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(own, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** How the profile's CLAUDE.md names the shared one. */
function sharedMemoryRef(claudeHome: string): string {
  return samePath(claudeHome, join(homedir(), ".claude")) ? "~/.claude/CLAUDE.md" : join(claudeHome, "CLAUDE.md");
}

/** Prepares `home` (already created, 0700) as a profile of `claudeHome`. */
export function setupProfileHome(home: string, claudeHome: string): SetupResult {
  const warnings: string[] = [];
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  for (const name of SHARED_DIRS) shareDir(home, claudeHome, name, warnings);
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
  ensureHistoryLink(home, claudeHome, (w) => warnings.push(w));
  for (const name of COPIED_FILES) {
    const from = join(claudeHome, name);
    const to = join(home, name);
    if (existsSync(from) && !existsSync(to)) copyFileSync(from, to);
  }
  const memory = join(home, "CLAUDE.md");
  if (existsSync(join(claudeHome, "CLAUDE.md")) && !existsSync(memory)) {
    writeFileSync(memory, `@${sharedMemoryRef(claudeHome)}\n`, { mode: 0o600 });
  }
  mergeClaudeJson(home, claudeHome);
  return { warnings };
}

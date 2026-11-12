// The project configuration level of folders on this machine
// (ProjectConfigLevel in the protocol): whether the chat sessions tunelo
// opens in a folder load the folder's own AI configuration (for Claude its
// .claude settings, hooks, permission rules, skills, commands, CLAUDE.md).
// Set once per folder by the user from a device and kept here, it covers the
// folder and every folder inside it: the nearest folder set wins. Kept in
// `project-config.json` in the core's data folder, written atomically, 0600.
//
// Two levels only. A middle level, the project's skills and commands without
// its hooks and permission rules, is not offered: Claude Code loads a
// folder's configuration as a whole, and a project skill can itself carry
// hooks and allowed tools in its front matter that take effect when it runs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type ProjectConfigValue = "off" | "full";

/** Paths compare without case where the file system ignores it (macOS, Windows). */
function norm(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

/** The folders' levels, by absolute folder as set. */
export class ProjectConfigStore {
  private readonly file: string;
  private levels: Record<string, ProjectConfigValue>;

  constructor(dataDir: string) {
    this.file = join(dataDir, "project-config.json");
    this.levels = read(this.file);
  }

  /** The level that applies in `dir`: its own, the nearest folder above it that has one, else off. */
  level(dir: string): ProjectConfigValue {
    const d = norm(dir);
    let best: { len: number; value: ProjectConfigValue } | undefined;
    for (const [folder, value] of Object.entries(this.levels)) {
      const f = norm(folder);
      const inside = d === f || d.startsWith(f.endsWith(sep) ? f : f + sep);
      if (inside && (!best || f.length > best.len)) best = { len: f.length, value };
    }
    return best?.value ?? "off";
  }

  /**
   * Sets `dir`'s own level. Off is kept only where a folder above it is on
   * (to override it); otherwise the folder simply has none.
   */
  set(dir: string, value: ProjectConfigValue): void {
    const full = resolve(dir);
    const next = Object.fromEntries(Object.entries(this.levels).filter(([folder]) => norm(folder) !== norm(full)));
    const before = this.levels;
    this.levels = next;
    const inherited = this.level(full);
    if (value === "full" || inherited === "full") next[full] = value;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.levels = before;
      throw err;
    }
  }
}

/** The kept levels; a missing or unreadable file is no folder set (sessions then load no project configuration). */
function read(file: string): Record<string, ProjectConfigValue> {
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, ProjectConfigValue> = {};
    for (const [folder, value] of Object.entries(raw)) {
      if ((value === "off" || value === "full") && folder.length > 0 && resolve(folder) === folder) out[folder] = value;
    }
    return out;
  } catch {
    return {};
  }
}

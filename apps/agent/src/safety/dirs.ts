// Folder browser for "new session": sub-folder names only, never file names.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export type DirEntry = { name: string; git: boolean; branch: string; sensitive: boolean };
export type DirListing = { path: string; parent: string; entries: DirEntry[]; sensitive: boolean };

export function gitBranch(dir: string): { git: boolean; branch: string } {
  const dotgit = join(dir, ".git");
  if (!existsSync(dotgit)) return { git: false, branch: "" };
  try {
    let gitDir = dotgit;
    if (statSync(dotgit).isFile()) {
      // worktree or submodule: "gitdir: <path>"
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
      if (m?.[1]) gitDir = resolve(dir, m[1].trim());
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    return { git: true, branch: ref?.[1] ?? head.slice(0, 8) };
  } catch {
    return { git: true, branch: "" };
  }
}

/**
 * The git work tree holding `dir`: the nearest folder from `dir` up that has
 * a .git (a clone, a worktree or a submodule); "" outside git. Only looks for
 * .git, runs nothing.
 */
export function gitRoot(dir: string): string {
  if (dir === "") return "";
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return "";
    at = up;
  }
}

export function listDir(path: string, opts: { showHidden: boolean; isSensitive: (p: string) => boolean }): DirListing {
  const dir = resolve(path || homedir());
  const st = statSync(dir);
  if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  const entries: DirEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!opts.showHidden && e.name.startsWith(".")) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = statSync(join(dir, e.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    const full = join(dir, e.name);
    entries.push({ name: e.name, ...gitBranch(full), sensitive: opts.isSensitive(full) });
    if (entries.length >= 2000) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = resolve(dir, "..");
  return { path: dir, parent: parent === dir || dir === parse(dir).root ? "" : parent, entries, sensitive: opts.isSensitive(dir) };
}

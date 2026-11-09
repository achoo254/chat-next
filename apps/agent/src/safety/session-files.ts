// Files and folders inside a session's working directory, for @-mentions on
// a device. Bounded on every side: only under the working directory, no
// symbolic link followed into a folder, .git / node_modules / sensitive paths
// skipped, a cap on what is returned and on how much is looked at.
import { type Dirent, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type FileEntry = { path: string; dir: boolean };
export type FileListing = { entries: FileEntry[]; truncated: boolean };

export const FILE_LIST_DEFAULT = 50;
export const FILE_LIST_MAX = 200;
/** Directory entries looked at before giving up (marked truncated). */
const VISIT_MAX = 20_000;
const SKIPPED = new Set([".git", "node_modules"]);

/** The prefix leaves the working directory (absolute, or climbs above it). */
export class OutsideFolderError extends Error {
  constructor() {
    super("the path is outside the session's folder");
  }
}

export function listSessionFiles(
  root: string,
  prefix: string,
  opts: { limit?: number; isSensitive: (p: string) => boolean },
): FileListing {
  const base = resolve(root);
  const query = prefix.replaceAll("\\", "/").toLowerCase();
  if (isAbsolute(prefix) || query.startsWith("/") || outside(base, resolve(base, query.slice(0, query.lastIndexOf("/") + 1)))) {
    throw new OutsideFolderError();
  }
  const limit = Math.min(Math.max(opts.limit || FILE_LIST_DEFAULT, 1), FILE_LIST_MAX);
  // A query with a folder part starts the walk there; one without searches every name too.
  const byName = !query.includes("/");
  const matches: FileEntry[] = [];
  let truncated = false;
  let visited = 0;
  // Breadth first: shallow paths come first, as a person types them.
  const queue: string[] = [""];
  for (let head = 0; head < queue.length; head++) {
    const rel = queue[head] ?? "";
    let dirents: Dirent[];
    try {
      dirents = readdirSync(join(base, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable or gone: skip it
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      if (++visited > VISIT_MAX) return { entries: matches, truncated: true };
      if (SKIPPED.has(d.name)) continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (opts.isSensitive(join(base, path))) continue;
      // A symbolic link is listed as a file and never walked into.
      const dir = d.isDirectory();
      const lower = path.toLowerCase();
      if (lower.startsWith(query) || (byName && d.name.toLowerCase().startsWith(query))) {
        if (matches.length >= limit) {
          truncated = true;
          return { entries: matches, truncated };
        }
        matches.push({ path: dir ? `${path}/` : path, dir });
      }
      // Walk only folders that can still hold a match.
      if (dir && (byName || query.startsWith(`${lower}/`) || lower.startsWith(query))) queue.push(path);
    }
  }
  return { entries: matches, truncated };
}

function outside(base: string, target: string): boolean {
  const r = relative(base, target);
  return r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r);
}

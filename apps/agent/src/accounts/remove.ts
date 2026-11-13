// Deleting a profile folder without ever reaching through a link into the
// machine's Claude folder: every entry is looked at with lstat first; links
// (symlinks, and junctions on Windows) are removed as links only, files are
// unlinked one by one, folders removed once empty. No recursive delete runs.
// A folder whose real path is not where it sits counts as a link too, in
// case the platform reports a junction as a plain folder.
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const caseless = process.platform === "win32" || process.platform === "darwin";
const same = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);

function isLinkLike(path: string, isSymbolicLink: boolean, isDirectory: boolean): boolean {
  if (isSymbolicLink) return true;
  if (!isDirectory) return false;
  return !same(realpathSync.native(path), join(realpathSync.native(dirname(path)), basename(path)));
}

function removeLink(path: string): void {
  if (process.platform === "win32") {
    // A junction goes with rmdir (never recursive); a file symlink with unlink.
    try {
      rmdirSync(path);
    } catch {
      unlinkSync(path);
    }
  } else {
    unlinkSync(path);
  }
  let still = true;
  try {
    lstatSync(path);
  } catch {
    still = false;
  }
  if (still) throw new Error(`could not remove the link ${path}; nothing more was deleted`);
}

function removeEntry(path: string): void {
  const st = lstatSync(path);
  if (isLinkLike(path, st.isSymbolicLink(), st.isDirectory())) return removeLink(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) removeEntry(join(path, name));
    rmdirSync(path);
    return;
  }
  unlinkSync(path);
}

/** Removes `dir` and everything in it, links as links only. A missing folder is fine. */
export function removeTreeSafely(dir: string): void {
  try {
    lstatSync(dir);
  } catch {
    return;
  }
  removeEntry(dir);
}

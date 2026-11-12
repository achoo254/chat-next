// Which repository a working directory belongs to, told once when the ledger
// first sees the directory (a worktree or a temp folder may be gone later).
// Read from git's own files, never by running git or anything the
// repository configures: the nearest .git above the directory, followed to
// the main repository for a worktree (commondir), and its origin remote with
// any password left out. No remote: `local:<folder name>`. Temp folders
// (the system's and agents' scratch folders): `scratch`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { reportableRemote } from "../projects/git.ts";

export const SCRATCH_KEY = "scratch";
const SCRATCH = /^(\/private)?\/tmp(\/|$)|[\\/]scratchpad([\\/]|$)|^\/private\/var\/folders\//;
const MAX_DEPTH = 64;

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The remote.origin.url of a git config file, as written there. */
export function originFromConfig(text: string): string | undefined {
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(s);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(s);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/** The repository's own git folder for a `.git` entry: the folder itself, or for a worktree the main one. */
function commonGitDir(dotGit: string): string | undefined {
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (st.isDirectory()) return dotGit;
  const content = readText(dotGit)?.trim();
  if (!content?.startsWith("gitdir:")) return undefined;
  let gitdir = content.slice("gitdir:".length).trim();
  if (!isAbsolute(gitdir)) gitdir = normalize(join(dirname(dotGit), gitdir));
  const common = readText(join(gitdir, "commondir"))?.trim();
  if (!common) return gitdir;
  return isAbsolute(common) ? common : normalize(join(gitdir, common));
}

function isScratch(cwd: string): boolean {
  if (SCRATCH.test(cwd)) return true;
  const tmp = tmpdir();
  return tmp.length > 1 && (cwd === tmp || cwd.startsWith(`${tmp}/`) || cwd.startsWith(`${tmp}\\`));
}

/** The repository key of `cwd`: a reportable remote, `local:<folder>` or `scratch`. */
export function repoKeyOf(cwd: string): string {
  return !cwd || isScratch(cwd) ? SCRATCH_KEY : gitRepoKey(cwd);
}

/** The key of the repository holding `cwd` (any folder, temp ones too): its remote or `local:<folder>`. */
export function gitRepoKey(cwd: string): string {
  let d = cwd;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      const gitDir = commonGitDir(dotGit);
      const raw = gitDir ? originFromConfig(readText(join(gitDir, "config")) ?? "") : undefined;
      const remote = raw ? reportableRemote(raw) : undefined;
      if (remote) return remote;
      const root = gitDir && basename(gitDir) === ".git" ? dirname(gitDir) : d;
      return `local:${basename(root)}`;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return `local:${basename(cwd.replace(/[\\/]+$/, "")) || cwd}`;
}

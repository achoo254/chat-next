// The branch checked out in the repository holding a folder, read from git's
// own files the way usage/repo-key.ts reads them: never by running git, nor
// anything the repository configures. The nearest `.git` above the folder;
// for a worktree (`.git` is a file `gitdir: …`) that worktree's own HEAD.
// A detached HEAD (a sha) has no branch: undefined, and the sha is not kept.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

const MAX_DEPTH = 64;
const BRANCH_REF = /^ref:\s*refs\/heads\/(.+)$/;

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The folder holding HEAD for a `.git` entry: the folder itself, or a worktree's gitdir. */
function headDir(dotGit: string): string | undefined {
  let isDir: boolean;
  try {
    isDir = statSync(dotGit).isDirectory();
  } catch {
    return undefined;
  }
  if (isDir) return dotGit;
  const content = readText(dotGit)?.trim();
  if (!content?.startsWith("gitdir:")) return undefined;
  const gitdir = content.slice("gitdir:".length).trim();
  return isAbsolute(gitdir) ? gitdir : normalize(join(dirname(dotGit), gitdir));
}

/** The branch HEAD names in the repository holding `folder`; undefined outside a repository or on a detached HEAD. */
export function gitHeadBranch(folder: string): string | undefined {
  let d = folder;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dir = headDir(join(d, ".git"));
    if (dir !== undefined) {
      const head = readText(join(dir, "HEAD"))?.trim() ?? "";
      return BRANCH_REF.exec(head)?.[1]?.trim() || undefined;
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

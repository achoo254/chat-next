// Whether a shell command line runs `git commit`, read on the machine only to
// note that a commit happened (the command itself is never stored by this).
// Each simple command of the line (split at `&&`, `||`, `;`, `|`, newlines)
// is read as words: leading variable assignments skipped, then `git` (or a
// path to it), then its global options (those taking a value skip it too),
// then the subcommand. `git log --grep commit` is a log, not a commit.

/** Global options of git that take the next word as their value. */
const VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isGit(word: string): boolean {
  const name = word.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return name === "git" || name === "git.exe";
}

/** The git subcommand of one simple command, or undefined when it does not run git. */
function gitSubcommand(simple: string): string | undefined {
  const words = simple.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i++;
  if (!isGit(words[i] ?? "")) return undefined;
  for (i++; i < words.length; i++) {
    const w = words[i] ?? "";
    if (VALUE_OPTIONS.has(w)) i++;
    else if (!w.startsWith("-")) return w;
  }
  return undefined;
}

/** `command` runs `git commit` in one of its simple commands. */
export function runsGitCommit(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((simple) => gitSubcommand(simple) === "commit");
}

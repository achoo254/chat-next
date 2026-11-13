// A profile shares the prompt history (history.jsonl) of the machine's Claude
// folder: a hard link on Windows, a symlink elsewhere. claude may replace the
// file with a fresh one (write to a temp file, then rename), which cuts the
// link: then the lines only the profile has are added to the shared file and
// the link is made again. Across drives no link is possible: the profile
// keeps a file of its own and a warning says so.
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sameVolume } from "./volume.ts";

export const HISTORY = "history.jsonl";

export type HistoryLinkState = "linked" | "repaired" | "separate";

const useHardLink = () => process.platform === "win32";

/** True when the profile's history.jsonl is the shared file. */
export function historyLinked(home: string, claudeHome: string): boolean {
  const link = join(home, HISTORY);
  const target = join(claudeHome, HISTORY);
  try {
    if (useHardLink()) {
      const a = statSync(link);
      const b = statSync(target);
      return a.ino === b.ino && a.dev === b.dev;
    }
    return lstatSync(link).isSymbolicLink() && realpathSync.native(link) === realpathSync.native(target);
  } catch {
    return false;
  }
}

/** Adds to `target` the lines of `from` it does not have yet. */
function mergeLines(from: string, target: string): void {
  const have = new Set(readFileSync(target, "utf8").split("\n"));
  const missing = readFileSync(from, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !have.has(line));
  if (missing.length) appendFileSync(target, `${missing.join("\n")}\n`);
}

/** Makes or repairs the link; never deletes a line of either file. */
export function ensureHistoryLink(home: string, claudeHome: string, warn: (message: string) => void = () => undefined): HistoryLinkState {
  const link = join(home, HISTORY);
  const target = join(claudeHome, HISTORY);
  if (!existsSync(target)) writeFileSync(target, "", { flag: "a", mode: 0o600 });
  if (historyLinked(home, claudeHome)) return "linked";
  if (!sameVolume(home, claudeHome)) {
    if (!existsSync(link)) writeFileSync(link, "", { mode: 0o600 });
    warn("the profile is on another drive than the Claude folder: its prompt history stays separate");
    return "separate";
  }
  let repaired = false;
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st) {
    // A link to somewhere else, or a file claude wrote in place of the link.
    if (!st.isSymbolicLink() && st.isFile()) mergeLines(link, target);
    unlinkSync(link);
    repaired = true;
  }
  if (useHardLink()) linkSync(target, link);
  else symlinkSync(target, link, "file");
  return repaired ? "repaired" : "linked";
}

// The machine's user in what Observatory keeps: the home folder becomes `~`
// everywhere (paths, labels, content, in every form text carries it), and
// the account's name, standing alone in free text (content only: a
// command's output, a message), becomes `[user]` when it is long and
// unusual enough not to be an ordinary word: `npm run dev` stays as it is for
// the account `dev`. Structured fields (a branch, a tool, a program, the end
// of a `cwd`) are never rewritten by name.
import { userInfo } from "node:os";

const caseless = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string): string => (caseless ? p.toLowerCase() : p);
const slashes = (p: string): string => p.replaceAll("\\", "/");
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Account names shorter than this are never rewritten (too likely an ordinary word). */
export const MIN_ACCOUNT_NAME_CHARS = 5;
/** Account names that are ordinary words of code and systems: never rewritten. */
const COMMON_NAMES = new Set([
  "admin", "administrator", "build", "builder", "default", "developer", "docker", "github", "guest", "jenkins", "local", "master",
  "owner", "public", "runner", "server", "system", "tester", "ubuntu", "users", "vagrant", "worker", "debian", "fedora", "centos",
]);

/** `path` with the home folder written as `~` (either slash on Windows, case folded where the file system folds it). */
export function tildePath(path: string, home: string): string {
  const p = slashes(path);
  const h = slashes(home).replace(/\/+$/, "");
  if (h === "") return path;
  if (fold(p) === fold(h)) return "~";
  if (fold(p).startsWith(`${fold(h)}/`)) return `~${path.slice(h.length)}`;
  return path;
}

/** `text` with the home folder as `~` in every form text carries it: as is, forward slashes, JSON-escaped, Git Bash's `/c/Users/…`. */
export function hideHomePaths(text: string, home: string): string {
  const h = home.replace(/[\\/]+$/, "");
  if (h === "") return text;
  const forms = new Set([h, slashes(h), h.replaceAll("\\", "\\\\")]);
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(h);
  if (drive?.[1] !== undefined && drive[2] !== undefined) forms.add(`/${drive[1].toLowerCase()}/${slashes(drive[2])}`);
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRegExp(form), caseless ? "gi" : "g"), "~");
  return out;
}

/** The account names worth hiding among `names`: long enough, not an ordinary word, each once. */
export function accountNamesToHide(names: readonly string[]): string[] {
  const kept = names.map((n) => n.trim()).filter((n) => n.length >= MIN_ACCOUNT_NAME_CHARS && !COMMON_NAMES.has(n.toLowerCase()));
  return [...new Set(kept)];
}

/** This machine's account names: the home folder's last part and the logged-in user (they differ after an account is renamed). */
export function machineAccountNames(home: string): string[] {
  const names = [slashes(home).split("/").filter(Boolean).at(-1) ?? ""];
  try {
    names.push(userInfo().username);
  } catch {
    // no user entry (a container without one): the home folder's name is all there is
  }
  return accountNamesToHide(names);
}

/** Free text with each of `names` (accountNamesToHide) standing alone, as a whole word, written `[user]`. */
export function hideAccountNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of accountNamesToHide(names)) out = out.replace(new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, "gi"), "[user]");
  return out;
}

// Files sent with a message that the AI does not take as an image land in the
// session's folder, under .tunelo-attachments/<yyyy-mm-dd>/<name>, so the AI
// reads them with its own tools. The name is made safe for every file system
// (no folders, no "..", no reserved names); the folder may not be a link out
// of the session's folder; a sensitive target is refused. In a git work tree
// the folder goes to .git/info/exclude once: the project's .gitignore is
// never touched.
import { constants, appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AttachmentError } from "./uploads.ts";

export const ATTACHMENTS_FOLDER = ".tunelo-attachments";

/** Longest file name kept, in UTF-16 units (file systems allow 255 bytes; this leaves room for " (99)"). */
const NAME_MAX = 120;
const REFUSED = '<>:"|?*';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** A file name that names one file, safely, on macOS, Linux and Windows; never empty. */
export function safeFileName(name: string): string {
  // The last part of any path, whichever separator the device used.
  const base = name.split(/[\\/]/).pop() ?? "";
  // Control characters and what Windows refuses become "_".
  const visible = [...base.normalize("NFC")].map((c) => (c.charCodeAt(0) < 0x20 || c === "\u007f" || REFUSED.includes(c) ? "_" : c)).join("");
  let clean = visible
    .replace(/\s+/g, " ")
    .trim()
    // Windows drops trailing dots and spaces; a leading dot hides the file.
    .replace(/[. ]+$/, "")
    .replace(/^\.+/, "");
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if ([...clean].length > NAME_MAX) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean = [...clean.slice(0, clean.length - ext.length)].slice(0, NAME_MAX - ext.length).join("").trimEnd() + ext;
  }
  return clean === "" ? "file" : clean;
}

/** The local date as yyyy-mm-dd. */
export function dayFolder(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `name`, else "name (2).ext", "name (3).ext", … */
function candidate(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** A real folder (made when missing), never a link. */
function realFolder(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new AttachmentError("the attachments folder is a link or a file", ErrorReason.PATH_OUTSIDE_FOLDER, path);
}

/**
 * Copies `source` into the session folder `cwd` under the attachments folder
 * of the day, as `name` made safe (numbered when taken). Returns the path
 * relative to `cwd`, "/"-separated.
 */
export function saveInFolder(cwd: string, source: string, name: string, opts: { isSensitive: (p: string) => boolean; now?: Date }): string {
  const root = resolve(cwd);
  const top = join(root, ATTACHMENTS_FOLDER);
  const day = join(top, dayFolder(opts.now ?? new Date()));
  const file = safeFileName(name);
  if (opts.isSensitive(join(day, file))) throw new AttachmentError("the attachments folder is sensitive", ErrorReason.SENSITIVE_FOLDER, day);
  realFolder(top);
  realFolder(day);
  // Every part checked: the day folder is still inside the session's folder.
  const realRoot = realpathSync.native(root);
  const inside = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!realpathSync.native(day).startsWith(inside)) {
    throw new AttachmentError("the attachments folder leads out of the session folder", ErrorReason.PATH_OUTSIDE_FOLDER, day);
  }
  keepOutOfGit(root);
  for (let n = 1; n < 1000; n++) {
    const target = join(day, candidate(file, n));
    try {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      return relative(root, target).split(sep).join("/");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        rmSync(target, { force: true });
        throw err;
      }
    }
  }
  throw new AttachmentError("too many files of that name today", ErrorReason.TOO_MANY_ATTACHMENTS, file);
}

/** The git folder of the work tree `dir` is in (walking up), or undefined outside git. */
function gitDirOf(dir: string): string | undefined {
  for (let cur = resolve(dir); ; ) {
    const dotgit = join(cur, ".git");
    try {
      const st = statSync(dotgit);
      if (st.isDirectory()) return dotgit;
      // A linked work tree or submodule: "gitdir: <path>".
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
      return m?.[1] ? resolve(cur, m[1].trim()) : undefined;
    } catch {
      // no .git here
    }
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

const excluded = new Set<string>();

/**
 * Adds the attachments folder to the repository's own exclude list
 * (info/exclude of the common git folder, shared by linked work trees).
 * Quietly does nothing outside git or when that file cannot be written.
 */
export function keepOutOfGit(dir: string): void {
  const gitDir = gitDirOf(dir);
  if (!gitDir) return;
  let common = gitDir;
  try {
    // A linked work tree keeps "commondir" pointing at the main git folder.
    const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (rel) common = resolve(gitDir, rel);
  } catch {
    // the main work tree
  }
  const file = join(common, "info", "exclude");
  if (excluded.has(file)) return;
  const line = `${ATTACHMENTS_FOLDER}/`;
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!text.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === ATTACHMENTS_FOLDER)) {
      mkdirSync(dirname(file), { recursive: true });
      const lead = text === "" || text.endsWith("\n") ? "" : "\n";
      appendFileSync(file, `${lead}# Files sent to the AI from a device (tunelo)\n${line}\n`);
    }
    excluded.add(file);
  } catch {
    // read-only repository: the files still save
  }
}

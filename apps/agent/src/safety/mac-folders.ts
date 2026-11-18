// macOS folder access. tunelo runs with the permissions macOS gives any
// program by default, as Claude Code in a terminal does, and never asks for
// Full Disk Access. macOS protects some folders (Desktop, Documents,
// Downloads, iCloud Drive, cloud providers' folders, other volumes) and lets
// a program into each only once allowed, sometimes after a prompt on the
// machine's screen. tunelo touches none of them before the user agreed on a
// device: work in one not yet granted is refused (MacFolderRefused), the
// device shows why and asks, and only then does tunelo try the folder, in a
// separate process so a prompt nobody answers never stops tunelo itself.
import { execFile } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type MacAccess = "not-asked" | "asking" | "granted" | "denied";
export type MacFolderState = { path: string; access: MacAccess };
/** What one try at the folder found; "missing": the folder is not there (a volume taken out). */
export type ProbeAnswer = "granted" | "denied" | "missing";

/** Work in a protected folder tunelo may not enter yet. `folder` is the protected folder itself. */
export class MacFolderRefused extends Error {
  constructor(
    readonly folder: string,
    readonly access: MacAccess,
  ) {
    super(
      access === "denied"
        ? `macOS does not let tunelo into ${folder}; allow it in System Settings > Privacy & Security > Files and Folders`
        : `macOS protects ${folder}; agree on a device for tunelo to ask macOS first`,
    );
  }
}

const ICLOUD = ["Library", "Mobile Documents"];
const CLOUD_STORAGE = ["Library", "CloudStorage"];

/** The fixed protected folders under home, in the order devices show them. */
function fixedFolders(home: string): string[] {
  return [join(home, "Desktop"), join(home, "Documents"), join(home, "Downloads"), join(home, ...ICLOUD)];
}

/** `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The protected folder holding `path` (that folder itself, or a cloud
 * provider's or a volume's own folder), or undefined. Reads nothing: a
 * volume's link to the startup disk is told apart by `isStartupVolume`.
 */
export function protectedFolderOf(path: string, home: string, isStartupVolume: (p: string) => boolean = startupVolume): string | undefined {
  const p = resolve(path);
  for (const folder of fixedFolders(home)) if (within(p, folder)) return folder;
  const cloud = join(home, ...CLOUD_STORAGE);
  if (p.startsWith(cloud + sep)) return join(cloud, p.slice(cloud.length + 1).split(sep)[0] ?? "");
  if (p.startsWith(`/Volumes${sep}`)) {
    const volume = join("/Volumes", p.slice("/Volumes/".length).split(sep)[0] ?? "");
    return isStartupVolume(volume) ? undefined : volume;
  }
  return undefined;
}

/** /Volumes/Macintosh HD is a link to "/", not another disk. */
function startupVolume(volume: string): boolean {
  try {
    return lstatSync(volume).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The names in a folder that is not itself protected (~/Library/CloudStorage, /Volumes); empty when unreadable. */
function names(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/** Every protected folder on this Mac right now. Lists only the folders that hold them, never inside one. */
export function protectedFolders(home: string): string[] {
  const cloud = join(home, ...CLOUD_STORAGE);
  const volumes = names("/Volumes")
    .map((n) => join("/Volumes", n))
    .filter((v) => !startupVolume(v));
  return [...fixedFolders(home), ...names(cloud).map((n) => join(cloud, n)), ...volumes];
}

/** Whether this process may list the user's TCC folder, which only Full Disk Access allows; asks nothing. */
export function hasFullDiskAccess(): boolean {
  try {
    readdirSync(join(homedir(), "Library", "Application Support", "com.apple.TCC"));
    return true;
  } catch {
    return false;
  }
}

/** Tries `path` in this process (tunelo's hidden `mac-folder-access` command). */
export function probeHere(path: string): ProbeAnswer {
  try {
    readdirSync(path);
    return "granted";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "denied";
  }
}

/**
 * Tries `path` in a new process running `command` + path, which prints its
 * ProbeAnswer. Waits as long as macOS's prompt stays unanswered, up to
 * `timeoutMs`; undefined when nobody answered by then.
 */
export function probeInChild(command: string[], path: string, timeoutMs: number): Promise<ProbeAnswer | undefined> {
  const [exe, ...args] = command;
  if (!exe) return Promise.resolve(undefined);
  return new Promise((done) => {
    execFile(exe, [...args, path], { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      const answer = String(stdout).trim();
      if (answer === "granted" || answer === "denied" || answer === "missing") return done(answer);
      done(err && (err as { killed?: boolean }).killed ? undefined : "denied");
    });
  });
}

export interface MacFoldersOptions {
  platform: NodeJS.Platform;
  home: string;
  /** What macOS answered before, kept in the machine's config. */
  saved: () => Readonly<Record<string, "granted" | "denied">>;
  save: (folder: string, answer: "granted" | "denied") => void;
  /** Full Disk Access (given before tunelo stopped asking for it) opens every folder. */
  fullDiskAccess: () => boolean;
  /** One try at the folder in another process; undefined when nobody answered macOS in time. */
  probe: (folder: string) => Promise<ProbeAnswer | undefined>;
  /** A folder's access changed: devices hear the machine's info again. */
  onChange: () => void;
  log: (line: string) => void;
  /** Lists the protected folders (tests replace it). */
  folders?: (home: string) => string[];
  isStartupVolume?: (p: string) => boolean;
}

export class MacFolders {
  private readonly asking = new Set<string>();

  constructor(private readonly opts: MacFoldersOptions) {}

  /** macOS protects folders; nothing to ask for elsewhere. */
  get applies(): boolean {
    return this.opts.platform === "darwin";
  }

  /** The protected folder holding `path`, on macOS; undefined elsewhere or outside them. */
  folderOf(path: string): string | undefined {
    if (!this.applies || path === "") return undefined;
    return protectedFolderOf(path, this.opts.home, this.opts.isStartupVolume);
  }

  access(folder: string): MacAccess {
    if (this.asking.has(folder)) return "asking";
    const saved = this.opts.saved()[folder];
    if (saved === "granted") return "granted";
    if (this.opts.fullDiskAccess()) return "granted";
    return saved ?? "not-asked";
  }

  /** True when tunelo may work in `path`: outside every protected folder, or in one macOS let it into. */
  allows(path: string): boolean {
    const folder = this.folderOf(path);
    return folder === undefined || this.access(folder) === "granted";
  }

  /** Throws MacFolderRefused unless tunelo may work in `path`. */
  assert(path: string): void {
    const folder = this.folderOf(path);
    if (folder === undefined) return;
    const access = this.access(folder);
    if (access !== "granted") throw new MacFolderRefused(folder, access);
  }

  /** The protected folders and the access to each, for MachineInfo; empty off macOS. */
  list(): MacFolderState[] {
    if (!this.applies) return [];
    const folders = (this.opts.folders ?? protectedFolders)(this.opts.home);
    return folders.map((path) => ({ path, access: this.access(path) }));
  }

  /**
   * The user agreed: tries `folder` in another process, so macOS may ask on
   * the machine's screen. Returns at once; onChange follows each change.
   * False when `folder` is not a protected folder of this Mac.
   */
  ask(folder: string): boolean {
    if (!this.applies || this.folderOf(folder) !== resolve(folder)) return false;
    const key = resolve(folder);
    if (this.asking.has(key)) return true;
    this.asking.add(key);
    this.opts.onChange();
    this.opts.log(`asking macOS for ${key}`);
    void this.opts
      .probe(key)
      .catch((): undefined => undefined)
      .then((answer) => {
        this.asking.delete(key);
        if (answer === "granted" || answer === "denied") {
          this.opts.save(key, answer);
          this.opts.log(`macOS ${answer === "granted" ? "allowed" : "refused"} ${key}`);
        } else {
          this.opts.log(answer === "missing" ? `${key} is not there` : `nobody answered macOS for ${key}`);
        }
        this.opts.onChange();
      });
    return true;
  }
}

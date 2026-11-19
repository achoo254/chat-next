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
import { pathsIn } from "./sensitive-paths.ts";

export type MacAccess = "not-asked" | "asking" | "granted" | "denied";
export type MacFolderState = { path: string; access: MacAccess };
/** What one try at the folder found; "missing": the folder is not there (a volume taken out). */
export type ProbeAnswer = "granted" | "denied" | "missing";
/** How asking macOS from inside an AI's turn ended: allowed, refused, or nobody answered macOS in time. */
export type AskOutcome = "granted" | "denied" | "unanswered";

/**
 * What an AI's session needs of the folders macOS protects (SessionPolicy
 * and the core): the folder a tool call names that tunelo may not enter yet,
 * and asking macOS for it while the turn waits, for at most `waitMs`.
 */
export interface MacFolderGate {
  ungrantedIn(text: string, cwd: string): string | undefined;
  askAndWait(folder: string, waitMs: number): Promise<AskOutcome>;
  /** What an AI process started now may not touch (MacFolders.aiFences). */
  aiFences(): AiFences;
  /** Where the sandbox's scripts go (safety/mac-sandbox.ts). */
  readonly sandboxDir: string;
}

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
  return [
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
    join(home, ...ICLOUD),
    // Media: macOS asks for Apple Music and the media library, or Photos, when a program reads in them.
    join(home, "Music"),
    join(home, "Movies"),
    join(home, "Pictures"),
  ];
}

/**
 * Other apps' data that macOS asks about (or refuses) and the user never
 * grants folder by folder: kept from tunelo's AI processes without Full Disk
 * Access. Docker's own container stays open: its CLI reaches the engine
 * through a socket in it.
 */
const APP_DATA = [
  ["Library", "Containers"],
  ["Library", "Group Containers"],
  ["Library", "Application Support", "AddressBook"],
  ["Library", "Calendars"],
];
const APP_DATA_OPEN = [
  ["Library", "Containers", "com.docker.docker"],
  ["Library", "Group Containers", "group.com.docker"],
];

/** What tunelo's AI processes may not touch (deny), with the openings inside it (allow); both empty: nothing to keep out. */
export type AiFences = { deny: string[]; allow: string[] };

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
  /** The user took tunelo's access to the folder back: nothing is kept for it any more. */
  forget: (folder: string) => void;
  /** Full Disk Access (given before tunelo stopped asking for it) opens every folder. */
  fullDiskAccess: () => boolean;
  /** One try at the folder in another process; undefined when nobody answered macOS in time. */
  probe: (folder: string) => Promise<ProbeAnswer | undefined>;
  /** A folder's access changed: devices hear the machine's info again. */
  onChange: () => void;
  log: (line: string) => void;
  /** Lists the protected folders (tests replace it). */
  folders?: (home: string) => string[];
  /** tunelo's config folder: the sandbox's scripts go under it. */
  configDir?: string;
  isStartupVolume?: (p: string) => boolean;
}

export class MacFolders implements MacFolderGate {
  /** Folders being asked for now, with the try that answers. */
  private readonly asking = new Map<string, Promise<ProbeAnswer | undefined>>();

  constructor(private readonly opts: MacFoldersOptions) {}

  get sandboxDir(): string {
    return this.opts.configDir ?? join(homedir(), ".config", "tunelo");
  }

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

  /**
   * The first protected folder tunelo may not enter yet that `text` (a tool's
   * input, a command line) names, ~ and $HOME included, relative paths from
   * `cwd`; undefined when it names none.
   */
  ungrantedIn(text: string, cwd: string): string | undefined {
    if (!this.applies || text === "") return undefined;
    for (const path of pathsIn(text, { home: this.opts.home, cwd })) {
      const folder = this.folderOf(path);
      if (folder !== undefined && this.access(folder) !== "granted") return folder;
    }
    return undefined;
  }

  /**
   * Asks macOS for `folder` (the user agreed on a device) and waits for its
   * answer, at most `waitMs`: an AI's turn waits on it and must go on either
   * way. The try keeps running after that, so a late answer is still kept.
   */
  async askAndWait(folder: string, waitMs: number): Promise<AskOutcome> {
    if (this.access(folder) === "granted") return "granted";
    if (!this.ask(folder)) return "denied";
    const running = this.asking.get(resolve(folder));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((done) => {
      timer = setTimeout(() => done("late"), waitMs);
    });
    const answer = await Promise.race([running ?? Promise.resolve(undefined), late]);
    clearTimeout(timer);
    if (answer === "granted") return "granted";
    if (answer === "denied") return "denied";
    return "unanswered";
  }

  /**
   * What the AI's processes tunelo starts may not touch, enforced by macOS's
   * sandbox (safety/mac-sandbox.ts): every protected folder not granted yet
   * and other apps' data, so a command that wanders into one (`find /`) gets
   * "Operation not permitted" at once instead of a macOS prompt nobody at
   * the machine answers. Nothing with Full Disk Access or off macOS.
   */
  aiFences(): AiFences {
    if (!this.applies || this.opts.fullDiskAccess()) return { deny: [], allow: [] };
    const home = this.opts.home;
    const folders = (this.opts.folders ?? protectedFolders)(home).filter((f) => this.access(f) !== "granted");
    return { deny: [...folders, ...APP_DATA.map((p) => join(home, ...p))], allow: APP_DATA_OPEN.map((p) => join(home, ...p)) };
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
    const running = this.opts
      .probe(key)
      .catch((): undefined => undefined)
      .then((answer) => {
        // Saved before anyone waiting on the try hears it, so they find the answer kept.
        this.asking.delete(key);
        if (answer === "granted" || answer === "denied") {
          this.opts.save(key, answer);
          this.opts.log(`macOS ${answer === "granted" ? "allowed" : "refused"} ${key}`);
        } else {
          this.opts.log(answer === "missing" ? `${key} is not there` : `nobody answered macOS for ${key}`);
        }
        this.opts.onChange();
        return answer;
      });
    this.asking.set(key, running);
    this.opts.onChange();
    this.opts.log(`asking macOS for ${key}`);
    return true;
  }

  /**
   * The user takes tunelo's access to `folder` back: tunelo forgets the
   * answer, so the folder is asked for again like one never asked, and the AI's
   * processes started from now on are kept out of it again (aiFences). macOS
   * itself is not told: what it allowed stays in System Settings, where only
   * the owner changes it. Nothing to take back while Full Disk Access opens
   * every folder.
   */
  revoke(folder: string): RevokeOutcome {
    if (!this.applies || this.folderOf(folder) !== resolve(folder)) return "not-protected";
    if (this.opts.fullDiskAccess()) return "full-disk-access";
    const key = resolve(folder);
    this.opts.forget(key);
    this.opts.log(`tunelo stopped entering ${key}`);
    this.opts.onChange();
    return "revoked";
  }
}

/** What taking a folder back did: done, not a protected folder of this Mac, or nothing to take back while Full Disk Access opens every folder. */
export type RevokeOutcome = "revoked" | "not-protected" | "full-disk-access";

/** How long an AI's call waits for macOS's answer once the user allowed asking: the turn goes on after that either way. */
export const MAC_ASK_IN_TURN_MS = 45_000;

/** What the AI reads when the user did not let tunelo ask macOS for `folder`: the call did not run, and the turn goes on. */
export function macFolderRefusedByUser(folder: string): string {
  return `The user did not let tunelo into ${folder}, a folder macOS protects, so this call did not run. Do not try it again; go on without that folder, or ask the user.`;
}

/**
 * Once the user allowed it, asks macOS for `folder` while the call waits
 * (MAC_ASK_IN_TURN_MS at most). Undefined when macOS allowed it and the call
 * may run; otherwise what the AI reads instead, so it goes on.
 */
export async function macFolderBeforeCall(gate: MacFolderGate, folder: string): Promise<string | undefined> {
  const outcome = await gate.askAndWait(folder, MAC_ASK_IN_TURN_MS);
  if (outcome === "granted") return undefined;
  if (outcome === "denied") {
    return `macOS does not let tunelo into ${folder}, so this call did not run. The user can allow it on the Mac in System Settings > Privacy & Security > Files and Folders. Do not try it again now; go on without that folder.`;
  }
  return `tunelo asked macOS for ${folder}, but nobody answered macOS's prompt on the machine in time, so this call did not run. Do not try it again now; go on without that folder, or ask the user to allow it and say when.`;
}

/** What the AI reads when macOS allowed `folder` but its process started kept out of it: the session restarts after this turn. */
export function macFolderAfterRestart(folder: string): string {
  return `macOS now lets tunelo into ${folder}, but this session started before that and cannot reach it yet; tunelo restarts the session once this turn ends. Finish this turn without that folder and tell the user to send the request again.`;
}

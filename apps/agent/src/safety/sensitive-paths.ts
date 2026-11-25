// Directories that need the user's explicit consent before a session opens
// there, and that mark an approval card red. A warning list, not a block
// list: the user can still go anywhere.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

export type SensitiveOptions = {
  home?: string;
  configDir?: string;
  extra?: string[];
  /**
   * Folders of tunelo's own inside a sensitive one that are not sensitive
   * themselves (the work folders of the chats' AI sessions). Paths resolve
   * first, so a link from there into a sensitive folder still counts.
   */
  except?: string[];
};

function real(p: string): string {
  // Resolve symlinks and ".." so a link into ~/.ssh is caught; for a path
  // that does not exist yet, resolve its nearest existing parent.
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = resolve(cur, "..");
      if (parent === cur) return resolve(p);
      rest.push(cur.slice(parent.length).replace(/^[\\/]+/, ""));
      cur = parent;
    }
  }
}

const caseless = process.platform === "win32" || process.platform === "darwin";
const norm = (p: string) => {
  const r = real(p);
  return caseless ? r.toLowerCase() : r;
};

export function createSensitiveCheck(opts: SensitiveOptions = {}) {
  const home = opts.home ?? homedir();
  const root = parse(resolve(home)).root;
  const exact = [home, root].map(norm);
  const inside = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".claude",
    ".codex",
    ".config/gh",
    // The Tunelo CLI 1.x kept its config and account session here.
    ".tunelo",
    "Library/Keychains",
    "Library/Mobile Documents/com~apple~CloudDocs/ENV production",
    "iCloudDrive/ENV production",
  ].map((d) => join(home, d));
  if (opts.configDir) inside.push(opts.configDir);
  if (process.platform === "win32") {
    const win = process.env.SystemRoot ?? "C:\\Windows";
    inside.push(win, process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)");
    // The agent's config (machine key, tunnel sign-in).
    if (process.env.APPDATA) inside.push(join(process.env.APPDATA, "tunelo"));
  } else {
    inside.push("/etc", "/System", "/usr", "/bin", "/sbin", "/var", "/private/etc", "/Library");
    inside.push(join(home, ".config", "tunelo"));
  }
  inside.push(...(opts.extra ?? []));
  const dirs = inside.map(norm);
  const allowed = (opts.except ?? []).map(norm);
  const within = (p: string, d: string): boolean => p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);

  return (path: string): boolean => {
    if (!path) return false;
    const p = norm(path);
    if (exact.includes(p)) return true;
    if (allowed.some((d) => within(p, d))) return false;
    return dirs.some((d) => within(p, d));
  };
}

/** True when a command line or tool input mentions a sensitive path. */
export function mentionsSensitive(
  text: string,
  isSensitive: (p: string) => boolean,
  opts: { home?: string; cwd?: string } = {},
): boolean {
  const home = opts.home ?? homedir();
  // The agent's own commands that only a person at the machine should run:
  // signing in or out (which adds the machine to an account or takes it
  // out), uninstalling, starting, stopping or running the service, trusting
  // a folder's settings, and every `tunelo config` (the default server and
  // token with -s/-k, local forwarding, MCP writes from outside tunelo's
  // sessions), and `tunelo advisor` (Advisor's key).
  if (/\btunelo(\.exe)?\s+(login|logout|uninstall|trust|untrust|config|start|stop|run|advisor)\b/i.test(text)) return true;
  // macOS's `security` reading or exporting tunelo's Keychain items (the
  // sealing key behind its saved secrets and Advisor's key), or dumping the
  // whole keychain.
  if (/\bsecurity\s+[a-z-]+\b[^\n]*\bcom\.hoandat\.tunelo\b/i.test(text)) return true;
  if (/\bsecurity\s+(dump-keychain|export)\b/i.test(text)) return true;
  // Printing any password item (-w: the password, -g: the item with it), or
  // naming tunelo's items by account alone (session-key, machine-key).
  if (/\bsecurity\s+find-(generic|internet)-password\b[^\n]*\s-[a-zA-Z]*[wg]\b/.test(text)) return true;
  if (/\bsecurity\s+[a-z-]+\b[^\n]*\b(session-key|machine-key)\b/i.test(text)) return true;
  return pathsIn(text, { home, ...(opts.cwd ? { cwd: opts.cwd } : {}) }).some(isSensitive);
}

/**
 * The paths a command line or tool input names: ~ and $HOME expanded,
 * relative ones (with a slash) from `cwd`. Words without a slash are not
 * paths here.
 */
export function pathsIn(text: string, opts: { home: string; cwd?: string }): string[] {
  // JSON inputs escape Windows backslashes; undo that before splitting.
  const unescaped = text
    .replaceAll("\\\\", "\\")
    .replace(/\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE/gi, opts.home);
  const words = unescaped.split(/[\s"'=,;()[\]{}]+/);
  return words.flatMap((w) => {
    if (w.startsWith("~")) return [join(opts.home, w.slice(1))];
    if (!/[\\/]/.test(w)) return [];
    // Relative paths count from the session folder, not the agent's.
    return [opts.cwd ? resolve(opts.cwd, w) : w];
  });
}

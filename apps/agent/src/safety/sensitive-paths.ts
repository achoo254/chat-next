// Directories that need the user's explicit consent before a session opens
// there, and that mark an approval card red. A warning list, not a block
// list: the user can still go anywhere.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

export type SensitiveOptions = { home?: string; configDir?: string; extra?: string[] };

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
    "Library/Keychains",
    "Library/Mobile Documents/com~apple~CloudDocs/ENV production",
    "iCloudDrive/ENV production",
  ].map((d) => join(home, d));
  if (opts.configDir) inside.push(opts.configDir);
  if (process.platform === "win32") {
    const win = process.env.SystemRoot ?? "C:\\Windows";
    inside.push(win, process.env.ProgramFiles ?? "C:\\Program Files", process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)");
    // The agent's config under its current and earlier name (machine key, tunnel sign-in).
    if (process.env.APPDATA) inside.push(join(process.env.APPDATA, "tunelo"), join(process.env.APPDATA, "chat-agent"));
  } else {
    inside.push("/etc", "/System", "/usr", "/bin", "/sbin", "/var", "/private/etc", "/Library");
    inside.push(join(home, ".config", "tunelo"), join(home, ".config", "chat-agent"));
  }
  inside.push(...(opts.extra ?? []));
  const dirs = inside.map(norm);

  return (path: string): boolean => {
    if (!path) return false;
    const p = norm(path);
    if (exact.includes(p)) return true;
    return dirs.some((d) => p === d || p.startsWith(d.endsWith(sep) ? d : d + sep));
  };
}

/** True when a command line or tool input mentions a sensitive path. */
export function mentionsSensitive(
  text: string,
  isSensitive: (p: string) => boolean,
  opts: { home?: string; cwd?: string } = {},
): boolean {
  const home = opts.home ?? homedir();
  // The agent's own commands (current and earlier name) hand out pairing
  // secrets, sign in, or change trust, Claude profiles and local forwarding.
  if (/\b(tunelo|hda)(\.exe)?\s+(pair|devices|trust|untrust|install|login|claude\s+profiles|config\s+local-forward)\b/i.test(text)) return true;
  // JSON inputs escape Windows backslashes; undo that before splitting.
  const unescaped = text
    .replaceAll("\\\\", "\\")
    .replace(/\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE/gi, home);
  const words = unescaped.split(/[\s"'=,;()[\]{}]+/);
  return words.some((w) => {
    if (w.startsWith("~")) return isSensitive(join(home, w.slice(1)));
    if (!/[\\/]/.test(w)) return false;
    // Relative paths count from the session folder, not the agent's.
    return isSensitive(opts.cwd ? resolve(opts.cwd, w) : w);
  });
}

// The TCP ports listening on this machine that 127.0.0.1 reaches, with the
// process behind each: macOS and Linux ask lsof, Windows asks netstat (the
// names come from tasklist). Also the command lines of running processes,
// for the debug ports they were started with (forward-deny-ports.ts).
//
// Parsers are separate from the commands so tests feed them sample output.
import { execFile } from "node:child_process";

export type ListeningPort = { port: number; pid: number; name: string };
export type ProcessLine = { pid: number; command: string };

/** PowerShell alone can take seconds to start on a busy Windows machine. */
const COMMAND_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
/** Process listings carry the environment on macOS and Linux. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_NAME = 100;

/** Runs a command; its stdout, or a rejection. */
function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Process names come from the OS: no control characters, at most 100. */
export function cleanName(name: string): string {
  return [...name]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, MAX_NAME);
}

/** Splits `host:port` (IPv6 hosts in brackets, or bare as netstat writes them); null when there is no port. */
function splitAddress(address: string): { host: string; port: number } | null {
  const at = address.lastIndexOf(":");
  if (at === -1) return null;
  const port = Number(address.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: address.slice(0, at).replace(/^\[|\]$/g, ""), port };
}

/** Whether a socket bound to `host` is reached by a forward (127.0.0.1, then ::1). */
function reachableOnLoopback(host: string): boolean {
  return host === "*" || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.") || host.startsWith("::ffff:127.");
}

function addPort(out: Map<number, ListeningPort>, port: number, pid: number, name: string): void {
  if (!out.has(port)) out.set(port, { port, pid, name: cleanName(name) });
}

/**
 * `lsof +c 0 -nP -iTCP -sTCP:LISTEN -Fpcn`: a `p<pid>` line, a `c<command>`
 * line, then one `n<address>:<port>` line per socket (other fields ignored).
 */
export function parseLsof(output: string): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  let pid = 0;
  let name = "";
  for (const line of output.split(/\r?\n/)) {
    const field = line.charAt(0);
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value) || 0;
      name = "";
    } else if (field === "c") {
      name = value;
    } else if (field === "n") {
      // A listening socket has no peer ("->").
      if (value.includes("->")) continue;
      const address = splitAddress(value);
      if (address && reachableOnLoopback(address.host)) addPort(out, address.port, pid, name);
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/**
 * `netstat -ano -p TCP` and `-p TCPv6`: listening sockets are the rows whose
 * foreign address is `0.0.0.0:0` or `[::]:0` (the state column is
 * translated on some Windows languages).
 */
export function parseNetstat(output: string, names: ReadonlyMap<number, string> = new Map()): ListeningPort[] {
  const out = new Map<number, ListeningPort>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]?.toUpperCase() !== "TCP") continue;
    const [, local = "", foreign = ""] = cols;
    if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
    const address = splitAddress(local);
    const pid = Number(cols.at(-1));
    if (!address || !Number.isInteger(pid) || !reachableOnLoopback(address.host)) continue;
    addPort(out, address.port, pid, names.get(pid) ?? "");
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/** `tasklist /FO CSV /NH`: `"node.exe","4567",…` per process. */
export function parseTasklist(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) names.set(Number(match[2]), match[1]);
  }
  return names;
}

/** `ps -axww -o pid=,command=` (or the tab-separated lines of the Windows query): pid and full command line. */
export function parseProcessLines(output: string): ProcessLine[] {
  const out: ProcessLine[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && match[2].trim() !== "") out.push({ pid: Number(match[1]), command: match[2] });
  }
  return out;
}

/** Ports listening on this machine that 127.0.0.1 reaches, by port. */
export async function listeningPorts(platform: NodeJS.Platform = process.platform): Promise<ListeningPort[]> {
  if (platform === "win32") {
    const [v4, v6, tasks] = await Promise.all([
      run("netstat", ["-ano", "-p", "TCP"]),
      run("netstat", ["-ano", "-p", "TCPv6"]).catch(() => ""),
      run("tasklist", ["/FO", "CSV", "/NH"]).catch(() => ""),
    ]);
    return parseNetstat(`${v4}\n${v6}`, parseTasklist(tasks));
  }
  // lsof exits 1 when nothing matches: no listening port.
  const output = await run("lsof", ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).catch((err: { code?: unknown; stdout?: unknown }) => {
    if (err.code === 1) return typeof err.stdout === "string" ? err.stdout : "";
    throw err;
  });
  return parseLsof(output);
}

const WINDOWS_PROCESSES =
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";

/** ps arguments: command line, followed by the environment (NODE_OPTIONS) where ps shows it. */
const PS_ARGS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["-axwwE", "-o", "pid=,command="],
  linux: ["axwwe", "-o", "pid=,command="],
};

/** The command line (and, on macOS and Linux, the environment) of every running process this user can see; read only in memory, never logged. */
export async function processLines(platform: NodeJS.Platform = process.platform): Promise<ProcessLine[]> {
  const output =
    platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESSES])
      : await run("ps", PS_ARGS[platform] ?? ["-axww", "-o", "pid=,command="]);
  return parseProcessLines(output);
}

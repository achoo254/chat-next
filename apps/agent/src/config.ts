// Machine config, owned by the running service: paired devices, revoked
// keys, limits, MCP servers, pinned folders. Written atomically (temp file +
// rename) with mode 0600; CLI commands go through the control socket so only
// the service writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { toBase64Url } from "@achoo254/chat-remote-protocol";

export type PairedDevice = { key: string; name: string; addedAt: number };

export type AgentConfig = {
  machineName: string;
  devices: PairedDevice[];
  revoked: string[];
  maxSessions: number;
  idleMinutes: number;
  mcpServers: Record<string, unknown>;
  pinnedDirs: string[];
  /** Folders whose own .claude settings may load (set on the machine: tunelo trust). */
  trustedDirs: string[];
  /** Set by `tunelo install`; cleared once that browser has connected. */
  install?: { deviceKey: string; secret: string };
  machineId?: string;
  machineSecret?: string;
  /** The machine is tied to the signed-in account in Chat (registered with it, or claimed). */
  claimed?: boolean;
  /** The owner removed the machine on the web: it is not added again until `tunelo install`. */
  machineRemoved?: boolean;
  subdomain?: string;
  serverUrl?: string;
  port?: number;
  /** Tunnel server chosen in the old Tunelo CLI (`~/.tunelo/config.json`), copied when moving from hda. */
  tunnelServer?: string;
};

/** %APPDATA%\<name> on Windows, ~/.config/<name> elsewhere. */
function platformDir(name: string): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), name);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name);
}

/** The default config folder of tunelo, when no variable points elsewhere. */
export function defaultConfigDir(): string {
  return platformDir("tunelo");
}

/** Where tunelo keeps its config: TUNELO_HOME, else the variable of the old name (CHAT_AGENT_HOME), else the default. */
export function configDir(): string {
  return process.env.TUNELO_HOME || process.env.CHAT_AGENT_HOME || defaultConfigDir();
}

/** The folder tunelo moves an hda install into: like configDir, without the old variable. */
export function tuneloConfigDir(): string {
  return process.env.TUNELO_HOME || defaultConfigDir();
}

/** The config folder of hda, the earlier name of tunelo (chat-agent before that). */
export function legacyConfigDir(): string {
  return process.env.CHAT_AGENT_HOME || platformDir("chat-agent");
}

const DEFAULTS: AgentConfig = {
  machineName: "",
  devices: [],
  revoked: [],
  maxSessions: 3,
  idleMinutes: 5,
  mcpServers: {},
  pinnedDirs: [],
  trustedDirs: [],
};

export class ConfigStore {
  readonly file: string;
  private data: AgentConfig;

  constructor(readonly dir = configDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "config.json");
    this.data = existsSync(this.file)
      ? { ...DEFAULTS, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<AgentConfig>) }
      : { ...DEFAULTS };
  }

  get(): Readonly<AgentConfig> {
    return this.data;
  }

  update(change: (c: AgentConfig) => void): void {
    const next = structuredClone(this.data);
    change(next);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
  }

  deviceStatus(key: Uint8Array): "paired" | "revoked" | "unknown" {
    const k = toBase64Url(key);
    if (this.data.revoked.includes(k)) return "revoked";
    return this.data.devices.some((d) => d.key === k) ? "paired" : "unknown";
  }

  addDevice(key: Uint8Array, name: string): void {
    const k = toBase64Url(key);
    this.update((c) => {
      c.revoked = c.revoked.filter((r) => r !== k);
      // Names come from the device: no control characters, at most 64.
      const clean = [...name].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim().slice(0, 64) || "device";
      if (!c.devices.some((d) => d.key === k)) c.devices.push({ key: k, name: clean, addedAt: Date.now() });
    });
  }

  /** True when dir is a trusted folder or inside one. */
  isTrusted(dir: string): boolean {
    const norm = (p: string) => {
      const r = resolve(p);
      return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
    };
    const d = norm(dir);
    return this.data.trustedDirs.some((t) => d === norm(t) || d.startsWith(norm(t) + sep));
  }

  setTrusted(dir: string, trusted: boolean): string {
    const full = resolve(dir);
    this.update((c) => {
      c.trustedDirs = c.trustedDirs.filter((t) => resolve(t) !== full);
      if (trusted) c.trustedDirs.push(full);
    });
    return full;
  }

  revokeDevice(key: string): boolean {
    let found = false;
    this.update((c) => {
      found = c.devices.some((d) => d.key === key || d.key.startsWith(key));
      const full = c.devices.filter((d) => d.key === key || d.key.startsWith(key)).map((d) => d.key);
      c.devices = c.devices.filter((d) => !full.includes(d.key));
      for (const k of full.length ? full : [key]) if (!c.revoked.includes(k)) c.revoked.push(k);
    });
    return found;
  }
}

/** Short id of a device key, for logs and the consent log. */
export function deviceLabel(key: Uint8Array | string, name?: string): string {
  const k = typeof key === "string" ? key : toBase64Url(key);
  return name ? `${name} (${k.slice(0, 8)})` : k.slice(0, 8);
}

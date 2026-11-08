// Machine config, owned by the running service: paired devices, revoked
// keys, limits, MCP servers, pinned folders. Written atomically (temp file +
// rename) with mode 0600; CLI commands go through the control socket so only
// the service writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Set by `hda install`; cleared once that browser has connected. */
  install?: { deviceKey: string; secret: string };
  machineId?: string;
  machineSecret?: string;
  subdomain?: string;
  serverUrl?: string;
  port?: number;
};

export function configDir(): string {
  if (process.env.CHAT_AGENT_HOME) return process.env.CHAT_AGENT_HOME;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "chat-agent");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "chat-agent");
}

const DEFAULTS: AgentConfig = {
  machineName: "",
  devices: [],
  revoked: [],
  maxSessions: 3,
  idleMinutes: 5,
  mcpServers: {},
  pinnedDirs: [],
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
      if (!c.devices.some((d) => d.key === k)) c.devices.push({ key: k, name: name || "device", addedAt: Date.now() });
    });
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

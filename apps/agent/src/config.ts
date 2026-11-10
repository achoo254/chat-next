// Machine config, owned by the running service: paired devices, revoked
// keys, the authenticator secret for pairing, limits, MCP servers, pinned
// folders. Written atomically (temp file +
// rename) with mode 0600; CLI commands go through the control socket so only
// the service writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fromBase64Url, isTotpSecret, toBase64Url } from "@achoo254/chat-remote-protocol";
import type { ProjectRecord } from "./projects/projects.ts";

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
  /**
   * The authenticator (TOTP) secret new devices pair with, base64url; set from
   * a paired device over the end-to-end link. Never logged, written to the
   * consent log or sent to the chat server.
   */
  totpSecret?: string;
  /** Set by `tunelo install`; cleared once that browser has connected. */
  install?: { deviceKey: string; secret: string };
  machineId?: string;
  machineSecret?: string;
  /** The machine is tied to the signed-in account in Chat (registered with it, or claimed). */
  claimed?: boolean;
  /** The owner removed the machine on the web: it is not added again until `tunelo install`. */
  machineRemoved?: boolean;
  /**
   * The machine tunnel's subdomain, kept by tunelo before 2.0.14. No longer
   * read or written: the relay derives the name from the account and the
   * machine id (online.ts).
   */
  subdomain?: string;
  serverUrl?: string;
  port?: number;
  /**
   * The machine is linked to Localman for this account and tunnel device
   * (localman/self-link.ts). No token: Localman keeps it.
   */
  localman?: { sub: string; deviceId: string; linkedAt: number };
  /**
   * Claude sessions tunelo opens get tunelo's own MCP (`tunelo mcp`: tunnel,
   * Chat and Localman tools). Unset is on.
   */
  sessionMcp?: boolean;
  /** The MCP tool groups served on this machine (mcp/groups.ts); unset is all of them. */
  mcpGroups?: ("tunnel" | "chat" | "localman")[];
  /** The user's projects on this machine (projects/projects.ts), in their order. */
  projects?: ProjectRecord[];
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

/** Where tunelo keeps its config: TUNELO_HOME, else the default. */
export function configDir(): string {
  return process.env.TUNELO_HOME || defaultConfigDir();
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

  /**
   * The stored authenticator secret; undefined when none is set or the stored
   * value is not a 20-byte secret (pairing then stays off until one is set).
   */
  totpSecret(): Uint8Array | undefined {
    const stored = this.data.totpSecret;
    if (!stored) return undefined;
    let secret: Uint8Array;
    try {
      secret = fromBase64Url(stored);
    } catch {
      return undefined;
    }
    return isTotpSecret(secret) ? secret : undefined;
  }

  /** Stores (or replaces) the authenticator secret; throws when it is not 20 bytes. */
  setTotpSecret(secret: Uint8Array): void {
    if (!isTotpSecret(secret)) throw new Error("a TOTP secret is 20 bytes");
    const stored = toBase64Url(secret);
    this.update((c) => {
      c.totpSecret = stored;
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

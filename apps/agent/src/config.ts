// Machine config, owned by the running service: the account's trusted
// devices as Chat last listed them (and when), limits, MCP servers, pinned
// folders. Written atomically (temp file + rename) with mode 0600; CLI
// commands go through the control socket so only the service writes it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { toBase64Url } from "@achoo254/chat-remote-protocol";
import type { ProjectRecord } from "./projects/projects.ts";

/** A device key of the owner's account that Chat lists for this machine (base64url key, Unix ms). */
export type TrustedDevice = { key: string; name: string; platform: string; createdAt: number };

/**
 * The owner's live device keys as the last heartbeat returned them, and when
 * (Unix ms; 0 = never). `revoked` keeps the keys that were listed once and
 * dropped since (newest last, bounded), so a revoked device hears REVOKED and
 * the terminal process refuses it.
 */
export type TrustedDevices = { list: TrustedDevice[]; syncedAt: number; revoked?: string[] };

/** How long the stored list may stand in for Chat: older than this, new handshakes are refused. */
export const TRUST_MAX_AGE_MS = 24 * 60 * 60_000;
/** Revoked keys kept for REVOKED answers and the terminal process. */
const MAX_REVOKED_KEPT = 500;

export type AgentConfig = {
  machineName: string;
  maxSessions: number;
  idleMinutes: number;
  mcpServers: Record<string, unknown>;
  pinnedDirs: string[];
  /** Folders whose own .claude settings may load (set on the machine: tunelo trust). */
  trustedDirs: string[];
  /** The devices the machine accepts (heartbeat's trusted_devices). */
  trustedDevices?: TrustedDevices;
  machineId?: string;
  machineSecret?: string;
  /** The owner removed the machine on the web: it is not added again until a new `tunelo login`. */
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
  /** The usage rules switched on or off by the user (usage/rules.ts), by rule code; unset rules keep their default. */
  usageRules?: Record<string, boolean>;
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
  maxSessions: 50,
  idleMinutes: 5,
  mcpServers: {},
  pinnedDirs: [],
  trustedDirs: [],
};

const OLD_DEFAULT_MAX_SESSIONS = 3;
const LEGACY_FIELDS = ["devices", "revoked", "totpSecret", "install", "claimed"];

export class ConfigStore {
  readonly file: string;
  private data: AgentConfig;

  constructor(readonly dir = configDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "config.json");
    const stored = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>) : {};
    // Fields of the pairing era (2.x): never read again, dropped at the next write.
    const kept = Object.fromEntries(Object.entries(stored).filter(([field]) => !LEGACY_FIELDS.includes(field)));
    this.data = { ...DEFAULTS, ...(kept as Partial<AgentConfig>) };
    // 3 was the old default and update() wrote it back into every config.json:
    // lift it to the new default so existing machines get the higher limit.
    if (this.data.maxSessions === OLD_DEFAULT_MAX_SESSIONS) this.data.maxSessions = DEFAULTS.maxSessions;
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

  /** What the machine knows of a device key from the stored list (its age aside: see trustStale). */
  deviceStatus(key: Uint8Array | string): "trusted" | "revoked" | "unknown" {
    const k = typeof key === "string" ? key : toBase64Url(key);
    const t = this.data.trustedDevices;
    if (t?.list.some((d) => d.key === k)) return "trusted";
    return t?.revoked?.includes(k) ? "revoked" : "unknown";
  }

  /** The name the account gave a trusted device; undefined for any other key. */
  deviceName(key: Uint8Array | string): string | undefined {
    const k = typeof key === "string" ? key : toBase64Url(key);
    return this.data.trustedDevices?.list.find((d) => d.key === k)?.name;
  }

  /** Keys listed once and dropped since. */
  revokedKeys(): string[] {
    return [...(this.data.trustedDevices?.revoked ?? [])];
  }

  /** True when the list was never synced or is older than TRUST_MAX_AGE_MS. */
  trustStale(now = Date.now()): boolean {
    const at = this.data.trustedDevices?.syncedAt ?? 0;
    return at <= 0 || now - at > TRUST_MAX_AGE_MS;
  }

  /**
   * Stores the list Chat just returned and when; answers which keys are new
   * and which were dropped (those join `revoked`). Names and platforms come
   * from other devices: control characters are taken out.
   */
  syncTrustedDevices(list: readonly TrustedDevice[], now = Date.now()): { added: TrustedDevice[]; removed: TrustedDevice[] } {
    const clean = new Map<string, TrustedDevice>();
    for (const d of list) {
      if (!clean.has(d.key)) clean.set(d.key, { key: d.key, name: printable(d.name, 64) || "device", platform: printable(d.platform, 32), createdAt: d.createdAt });
    }
    const before = this.data.trustedDevices?.list ?? [];
    const added = [...clean.values()].filter((d) => !before.some((b) => b.key === d.key));
    const removed = before.filter((b) => !clean.has(b.key));
    this.update((c) => {
      const keep = (c.trustedDevices?.revoked ?? []).filter((k) => !clean.has(k));
      for (const d of removed) if (!keep.includes(d.key)) keep.push(d.key);
      c.trustedDevices = { list: [...clean.values()], syncedAt: now, revoked: keep.slice(-MAX_REVOKED_KEPT) };
    });
    return { added, removed };
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
}

/** Text from elsewhere with control characters taken out, trimmed to `max` characters. */
function printable(text: string, max: number): string {
  return [...text]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("")
    .trim()
    .slice(0, max);
}

/** Short id of a device key, for logs and the consent log. */
export function deviceLabel(key: Uint8Array | string, name?: string): string {
  const k = typeof key === "string" ? key : toBase64Url(key);
  return name ? `${name} (${k.slice(0, 8)})` : k.slice(0, 8);
}

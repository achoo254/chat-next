// Whether Localman's requests for localhost are served here, and ports the
// user refuses: `local-forward.json` in the config folder, apart from
// config.json. The running service keeps config.json in memory and writes
// it whole, so a change written there by `tunelo config local-forward` while
// the service starts (before its control channel answers) would be written
// over. This file is read again whenever it changed on disk, and every
// change is a read-modify-write under a lock, by the service or a command.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writePrivateFile } from "@tunelo/client";

export const FORWARD_SETTINGS_FILE = "local-forward.json";

export type ForwardSettingsValue = {
  /** On unless turned off. */
  enabled: boolean;
  /** Ports never forwarded on this machine, beyond the built-in ones. */
  blockedPorts: number[];
};

const DEFAULTS: ForwardSettingsValue = { enabled: true, blockedPorts: [] };

function isPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65_535;
}

/** The file's settings; anything unreadable counts as off (fail closed), a missing file as the defaults. */
function parse(text: string): ForwardSettingsValue {
  try {
    const raw = JSON.parse(text) as { enabled?: unknown; blockedPorts?: unknown };
    return {
      enabled: raw.enabled !== false,
      blockedPorts: Array.isArray(raw.blockedPorts) ? [...new Set(raw.blockedPorts.filter(isPort))].sort((a, b) => a - b) : [],
    };
  } catch {
    return { enabled: false, blockedPorts: [] };
  }
}

export class ForwardSettings {
  readonly file: string;
  private cache: { key: string; value: ForwardSettingsValue } | undefined;

  constructor(dir: string) {
    this.file = join(dir, FORWARD_SETTINGS_FILE);
  }

  /** The settings as on disk now (read again only when the file changed). */
  read(): ForwardSettingsValue {
    let key: string;
    try {
      const st = statSync(this.file);
      key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return { ...DEFAULTS, blockedPorts: [] };
    }
    if (this.cache?.key !== key) {
      let text: string;
      try {
        text = readFileSync(this.file, "utf8");
      } catch {
        return { enabled: false, blockedPorts: [] };
      }
      this.cache = { key, value: parse(text) };
    }
    return { ...this.cache.value, blockedPorts: [...this.cache.value.blockedPorts] };
  }

  /** Applies `change` to what is on disk now, under the lock, and writes it atomically. */
  async update(change: (s: ForwardSettingsValue) => void): Promise<ForwardSettingsValue> {
    return withFileLock(`${this.file}.lock`, async () => {
      this.cache = undefined;
      const next = this.read();
      change(next);
      next.blockedPorts = [...new Set(next.blockedPorts.filter(isPort))].sort((a, b) => a - b);
      writePrivateFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.cache = undefined;
      return this.read();
    });
  }
}

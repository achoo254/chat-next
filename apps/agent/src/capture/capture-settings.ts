// The screenshot settings of this machine, in `<config>/capture.json` (its
// own file, as mcp/local-writes.ts: `tunelo config capture-hotkey` writes it
// while the service runs, and the service follows it). Unset: on, with the
// shortcut Ctrl+Alt+A (⌃⌥A on a Mac).
import { existsSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HOTKEY } from "./capture-service.ts";

export interface CaptureSettings {
  /** tunelo-capture runs; unset is on. */
  enabled?: boolean;
  /** The global shortcut, as "Ctrl+Alt+A"; "" turns it off; unset is DEFAULT_HOTKEY. */
  hotkey?: string;
  /** The overlay's language, the one Chat showed when it last asked for a capture; unset is the system's. */
  lang?: CaptureLang;
}

export type CaptureLang = "vi" | "en" | "zh-CN";

/** A language tag a device sent ("vi", "en-US", "zh-CN"…) as one the overlay has; undefined otherwise. */
export function captureLangOf(tag: string): CaptureLang | undefined {
  const t = tag.trim().toLowerCase();
  if (t === "vi" || t.startsWith("vi-")) return "vi";
  if (t === "en" || t.startsWith("en-")) return "en";
  if (t === "zh" || t.startsWith("zh-")) return "zh-CN";
  return undefined;
}

export const captureSettingsFile = (configDir: string) => join(configDir, "capture.json");

/** Read as untrusted: a broken file is the defaults. */
export function readCaptureSettings(configDir: string): CaptureSettings {
  const file = captureSettingsFile(configDir);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const lang = typeof raw.lang === "string" ? captureLangOf(raw.lang) : undefined;
    return {
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(typeof raw.hotkey === "string" ? { hotkey: raw.hotkey } : {}),
      ...(lang ? { lang } : {}),
    };
  } catch {
    return {};
  }
}

export function writeCaptureSettings(configDir: string, settings: CaptureSettings): void {
  const file = captureSettingsFile(configDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function hotkeyOf(settings: CaptureSettings): string {
  return settings.hotkey ?? DEFAULT_HOTKEY;
}

const MODIFIERS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  "⌃": "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  "⌥": "Alt",
  shift: "Shift",
  "⇧": "Shift",
  cmd: "Super",
  command: "Super",
  "⌘": "Super",
  super: "Super",
  win: "Super",
  meta: "Super",
};

/**
 * A shortcut as the user writes it ("ctrl+option+a", "⌘⇧4", "Ctrl+Shift+F2")
 * in the form tunelo-capture takes ("Ctrl+Alt+A"); undefined when it is not
 * one modifier or more and one key (a letter, a digit or F1-F24).
 */
export function normalizeHotkey(input: string): string | undefined {
  const parts = input
    .replace(/([⌃⌥⇧⌘])/g, "+$1+")
    .split(/[+\s-]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const mods = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (key !== undefined) return undefined;
    if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) key = part.toUpperCase();
    else return undefined;
  }
  if (key === undefined || mods.size === 0) return undefined;
  const order = ["Ctrl", "Alt", "Shift", "Super"].filter((m) => mods.has(m));
  return [...order, key].join("+");
}

/** Calls `onChange` when the file changes (polled: a write by the CLI from another process). */
export function watchCaptureSettings(configDir: string, onChange: (settings: CaptureSettings) => void): () => void {
  const file = captureSettingsFile(configDir);
  const listener = () => onChange(readCaptureSettings(configDir));
  watchFile(file, { interval: 2_000, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

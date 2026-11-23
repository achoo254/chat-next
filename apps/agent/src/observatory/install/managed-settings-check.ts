// What an organization's managed settings say about Observatory, read from
// the managed settings files Claude Code reads on this OS (the file and its
// drop-in folder). Hooks are blocked by `disableAllHooks` or
// `allowManagedHooksOnly`; OpenTelemetry is the organization's when the
// managed `env` sets any OTel key. Values from MDM (a macOS profile, the
// Windows registry) are not read here; the install's message says so.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isOtelKey } from "./observatory-settings-markers.ts";

/** The managed settings folder of Claude Code on `platform`. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode");
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

export type ManagedVerdict = {
  /** Why hooks cannot run (the setting and its file); undefined when they can. */
  hooksBlocked?: string;
  /** The managed OTel keys (and file); undefined when there are none. */
  otelManaged?: string;
  /** A managed settings file that exists but could not be read as JSON. */
  unreadable?: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The managed settings files under `dir`: managed-settings.json, then the drop-ins in managed-settings.d (sorted). */
async function managedFiles(dir: string): Promise<string[]> {
  const files = [join(dir, "managed-settings.json")];
  try {
    const drop = join(dir, "managed-settings.d");
    for (const name of (await readdir(drop)).filter((n) => n.endsWith(".json")).sort()) files.push(join(drop, name));
  } catch {
    // no drop-in folder
  }
  return files;
}

/** Reads the managed settings under `dir` (managedSettingsDir() by default). */
export async function checkManagedSettings(dir: string = managedSettingsDir()): Promise<ManagedVerdict> {
  const verdict: ManagedVerdict = {};
  for (const file of await managedFiles(dir)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      verdict.unreadable ??= file;
      continue;
    }
    let settings: unknown;
    try {
      settings = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      verdict.unreadable ??= file;
      continue;
    }
    if (!isRecord(settings)) {
      verdict.unreadable ??= file;
      continue;
    }
    for (const key of ["disableAllHooks", "allowManagedHooksOnly"]) {
      if (settings[key] === true) verdict.hooksBlocked ??= `${key} in ${file}`;
    }
    const env = settings.env;
    const otel = isRecord(env) ? Object.keys(env).filter(isOtelKey) : [];
    if (otel.length > 0) verdict.otelManaged ??= `${otel.join(", ")} in ${file}`;
  }
  return verdict;
}

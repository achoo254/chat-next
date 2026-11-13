// The user's own `agy` (Google Antigravity CLI): where it is, its version,
// the environment it starts with, and what its settings say about asking
// before tools run. tunelo only reads agy's settings, never writes them.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Antigravity's id in the registry. */
export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/** The oldest agy whose `agy acp` this adapter speaks. */
export const MIN_AGY: readonly [number, number, number] = [1, 5, 2];

/** The user's own `agy`: PATH first, then the installer's location. */
export async function findAgy(): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["agy"]);
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  } catch {
    // not on PATH (services often start with a minimal PATH)
  }
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  return existsSync(local) ? local : null;
}

/** "1.5.8" from `agy --version` output; undefined when it names none. */
export function parseVersion(out: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
}

/** True when `version` is at least MIN_AGY. */
export function supported(version: string): boolean {
  const v = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = MIN_AGY[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export async function agyVersion(bin: string): Promise<string | undefined> {
  try {
    return parseVersion((await run(bin, ["--version"], { timeout: 15_000 })).stdout);
  } catch {
    return undefined;
  }
}

/**
 * The environment agy starts with: the service's own, without a Gemini or
 * Google key or project, so agy signs in as its own login does (never an
 * API key the service happened to inherit), plus `extra`.
 */
export function agyEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === "GEMINI_API_KEY" || k.startsWith("GOOGLE_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/** agy's own data folder (~/.gemini). */
export function geminiDir(): string {
  return join(homedir(), ".gemini");
}

/** agy's CLI folder: settings, conversations, transcripts. */
export function agyHome(): string {
  return join(geminiDir(), "antigravity-cli");
}

export type ToolPermission = "request-review" | "proceed-in-sandbox" | "always-proceed" | "strict";

/**
 * How agy's own settings say tools run: `toolPermission` of
 * ~/.gemini/antigravity-cli/settings.json, "request-review" when unset (agy's
 * default) or unreadable. "always-proceed" runs every tool without asking:
 * sessions are full access, as the machine's own choice.
 */
export function toolPermission(home = agyHome()): ToolPermission {
  try {
    const value: unknown = (JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { toolPermission?: unknown }).toolPermission;
    if (value === "proceed-in-sandbox" || value === "always-proceed" || value === "strict") return value;
  } catch {
    // no settings: agy's default
  }
  return "request-review";
}

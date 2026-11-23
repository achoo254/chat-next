// What `tunelo observatory install` checks before it changes anything, and
// what it shows the person asked: the policy side of the install
// (observatory-install.ts writes the file).
//
// It refuses when Claude Code is missing or older than the first release
// running hooks in exec form; when managed settings block hooks or set
// OpenTelemetry; when the user's own OpenTelemetry settings are found
// (settings.json `env`, or this shell's environment); when settings.json is
// not a JSON object; and when settings.json is a link or read-only (a dotfile
// manager's link would be replaced by a plain file, and a file the user locked
// would be written all the same), or a hard link (replacing it would cut it
// from its other name): the user adds Observatory where the file comes from
// instead. A file naming `hooks` or `env` twice is refused too: Claude Code
// reads the last, an edit would change the first.
import { lstat } from "node:fs/promises";
import type { ManagedVerdict } from "./managed-settings-check.ts";
import { OBSERVED_HOOK_EVENTS, TUNELO_OBSERVATORY_ENV_MARKER, isOtelKey, observatoryHookGroup, parseSettings, userOtelKeys } from "./observatory-settings-markers.ts";
import { duplicateKeys } from "./settings-json-observatory.ts";

/** The first Claude Code release with exec-form hooks (`args`, run without a shell): 2.1.139 in its changelog. */
export const MIN_CLAUDE_VERSION = "2.1.139";

/** `version` (as `claude --version` prints it, "2.1.330 (Claude Code)") is at least `min`. */
export function versionAtLeast(version: string, min: string): boolean {
  const parts = (v: string): number[] => (/^\s*(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? []).map(Number);
  const a = parts(version);
  const b = parts(min);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Why `file` cannot be written in place (a link, not a plain file, read-only); undefined when it can, or does not exist yet. */
export async function settingsFileProblem(file: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `${file} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
  }
  if (info.isSymbolicLink()) return `${file} is a link; add Observatory's hooks to the file it points to (\`tunelo observatory install\` does not replace a link)`;
  if (!info.isFile()) return `${file} is not a plain file`;
  if ((info.mode & 0o200) === 0) return `${file} is read-only; make it writable, or add Observatory's hooks where the file comes from`;
  // Replacing the file would cut it from its other names (a dotfile manager's hard link) without a word.
  if (info.nlink > 1) return `${file} is a hard link (${info.nlink} names for one file); add Observatory's hooks to the file it is linked with`;
  return undefined;
}

export type InstallCheckDeps = {
  /** `claude --version`; undefined when Claude Code is not found. */
  claudeVersion: () => Promise<string | undefined>;
  managed: () => Promise<ManagedVerdict>;
  /** This shell's environment (the user's own OpenTelemetry variables). */
  env: Readonly<Record<string, string | undefined>>;
};

/** Why the settings file's content (`text`) cannot be edited by Observatory, or undefined. */
export function settingsTextRefusal(file: string, text: string): string | undefined {
  if (parseSettings(text) === undefined) return `${file} is not a JSON object; fix it first.`;
  const twice = duplicateKeys(text);
  if (twice.length > 0) return `${file} names ${twice.join(", ")} more than once (Claude Code reads only the last one); keep one of each, then run this again.`;
  return undefined;
}

/** Why the settings file's content cannot take Observatory, or undefined. */
export function settingsRefusal(file: string, text: string): string | undefined {
  const textWhy = settingsTextRefusal(file, text);
  if (textWhy) return textWhy;
  const settings = parseSettings(text);
  if (!settings) return `${file} is not a JSON object; fix it first.`;
  const own = userOtelKeys(settings);
  if (own.length > 0) return `${file} sets OpenTelemetry already (${own.join(", ")}); Observatory does not override your own telemetry.`;
  return undefined;
}

/** Why install cannot go on on this machine (Claude Code, managed settings, the shell), or undefined. */
export async function machineRefusal(deps: InstallCheckDeps): Promise<string | undefined> {
  const version = await deps.claudeVersion();
  if (version === undefined) return "Claude Code was not found on this machine (`claude --version`).";
  if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) return `Claude Code ${version.trim()} is older than ${MIN_CLAUDE_VERSION}, the first release running hooks without a shell. Update Claude Code, then run this again.`;
  const managed = await deps.managed();
  if (managed.unreadable) return `the managed settings file ${managed.unreadable} cannot be read as JSON, so whether your organization allows hooks is unknown.`;
  if (managed.hooksBlocked) return `your organization's managed settings block hooks (${managed.hooksBlocked}).`;
  if (managed.otelManaged) return `your organization's managed settings set OpenTelemetry (${managed.otelManaged}); Observatory does not override them.`;
  const shell = Object.keys(deps.env).filter((k) => isOtelKey(k) && deps.env[k] !== undefined);
  if (shell.length > 0) return `this shell sets OpenTelemetry already (${shell.join(", ")}); Observatory does not override your own telemetry. Unset them, or keep your setup without Observatory.`;
  return undefined;
}

/** The lines describing what install adds; the token never shown. */
export function describeChange(file: string, argv: readonly string[], env: Record<string, string>): string[] {
  const sample = observatoryHookGroup(argv, "<event>").hooks[0];
  const shownEnv = Object.entries({ ...env, [TUNELO_OBSERVATORY_ENV_MARKER]: "otel" }).map(([k, v]) => `    ${k}=${k === "OTEL_EXPORTER_OTLP_HEADERS" ? "Authorization=Bearer [hidden]" : v}`);
  return [
    `Observatory will change ${file}:`,
    `  hooks: one group for each of ${OBSERVED_HOOK_EVENTS.join(", ")},`,
    `    each running ${JSON.stringify(sample?.command ?? "")} with arguments ${JSON.stringify(sample?.args ?? [])} (no shell), async: Claude Code never waits for it.`,
    "  env: the OpenTelemetry settings that send Claude Code's logs (no prompts, no metrics) to tunelo on 127.0.0.1:",
    ...shownEnv,
    "  The receiver's token is stored in this file: keep it out of a dotfiles repository you publish (`tunelo observatory rotate-token` replaces it).",
    "Nothing else in the file changes. The Claude profiles of tunelo copy it.",
    "Collected: session, prompt and tool timings and sizes, tokens and cost, subagents, instruction files loaded, commits; a redacted excerpt of prompts and tool content (2 KB) unless `tunelo observatory content <folder> off`.",
  ];
}

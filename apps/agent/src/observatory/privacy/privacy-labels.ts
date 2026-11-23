// The short labels Observatory keeps instead of content: a path with the
// home folder as `~` (home-and-account.ts), a file's name and its parent folder, a URL's domain,
// the program a shell command runs, `server › tool` of an MCP tool. And the
// checks that decide a path or a command touches a secret file, whose
// content is then never kept (only the file's name).
import { isAbsolute, resolve } from "node:path";
import { walkCommand } from "../../activity/command-walk.ts";
import { SUBJECT_COMMANDS, shellSubject } from "../../activity/shell-words.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import { isSecretName } from "../../workspace/paths.ts";
import { tildePath } from "./home-and-account.ts";

/** Longest label kept; a longer value is dropped, not cut (it is not a label). */
export const MAX_LABEL_CHARS = 200;
/** Longest path kept. */
export const MAX_PATH_CHARS = 1024;
const ID = /^[\w.:@/+=-]{1,160}$/;

const isControl = (code: number): boolean => code < 32 || (code >= 127 && code <= 159);

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isControl(text.charCodeAt(i))) return true;
  return false;
}

/** A machine id (session, prompt, tool use, agent, request) as it is, or undefined when it does not look like one. */
export function idValue(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** A short label without control characters, or undefined when it is not a string or too long. */
export function labelValue(value: unknown, max: number = MAX_LABEL_CHARS): string | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  const clean = [...value].filter((ch) => !isControl(ch.charCodeAt(0))).join("").trim();
  return clean === "" ? undefined : clean;
}

const slashes = (p: string): string => p.replaceAll("\\", "/");

/** The last part of a path (a file's name). */
export function baseName(path: string): string {
  const parts = slashes(path).split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

/** A file's name and its parent folder (`src/app.ts`), whatever slashes the path has. */
export function pathLabel(path: string): string {
  const parts = slashes(path).split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** The host of an http(s) URL, or undefined. */
export function urlDomain(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length > 4096) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Only programs on the list of common commands (SUBJECT_COMMANDS) are named; anything else is "". */
const LISTED_PROGRAM = {
  program: (name: string): string | undefined => (SUBJECT_COMMANDS.has(name) ? name : undefined),
  script: (): string | undefined => undefined,
  fallback: "",
};

/** The program a shell command line really runs (`pnpm exec vitest` is vitest), else its first listed command; "" when neither is a common one. */
export function shellProgram(command: string): string {
  return walkCommand(command, LISTED_PROGRAM) || shellSubject(command);
}

/** `server › tool` for an MCP tool name (`mcp__server__tool`), else undefined. */
export function mcpLabel(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m?.[1] && m[2] ? `${m[1]} › ${m[2]}` : undefined;
}

/** Where the filter is: the home folder, the session's folder, and the machine's sensitive folders. */
export type PathContext = { home: string; cwd?: string | undefined; isSensitive: (absolutePath: string) => boolean };

/** A path names a secret file (dotenv, key, credentials; workspace/paths.ts) or lies in a sensitive folder (safety/sensitive-paths.ts). */
export function isSecretPath(path: string, ctx: PathContext): boolean {
  if (slashes(path).split("/").some((part) => part !== "" && isSecretName(part))) return true;
  const absolute = isAbsolute(path) ? path : ctx.cwd ? resolve(ctx.cwd, path) : undefined;
  return absolute !== undefined && ctx.isSensitive(absolute);
}

/** A command line or tool input names a secret file by name (`cat .env`) or a path in a sensitive folder. */
export function mentionsSecret(text: string, ctx: PathContext): boolean {
  const words = cutWords(text);
  if (words.some((w) => isSecretName(baseName(w)))) return true;
  return mentionsSensitive(text.slice(0, 8192), ctx.isSensitive, { home: ctx.home, ...(ctx.cwd ? { cwd: ctx.cwd } : {}) });
}

/** The words of the first 8 KB of `text`, split as safety/sensitive-paths.ts splits paths. */
function cutWords(text: string): string[] {
  return text
    .slice(0, 8192)
    .replaceAll("\\\\", "\\")
    .split(/[\s"'=,;()[\]{}<>|&]+/)
    .filter(Boolean);
}

/** A path as Observatory keeps it: `~` for home, only the name when secret; undefined when not a usable path. */
export function keptPath(value: unknown, ctx: PathContext): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > MAX_PATH_CHARS || hasControl(value)) return undefined;
  return isSecretPath(value, ctx) ? baseName(value) : tildePath(value, ctx.home);
}

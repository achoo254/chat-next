// What the AI of an Advisor thread may do, whichever AI it is: read and
// search inside the thread's folder (no secret file, nothing sensitive), keep
// its to-do list, and call advisor_git and advisor_weigh of tunelo's MCP.
// Everything else is refused at once, with a word for the AI: no approval
// card ever opens and nothing waits for the user, so a question never hangs
// on a prompt nobody sees. tunelo decides this itself, never through the
// AI's own permission mode or settings (a "plan" mode is the AI's to leave).
// Each adapter asks it at every tool call it hears of (Claude: a PreToolUse
// hook and canUseTool; agy: session/request_permission).
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SESSION_MCP_SERVER } from "../mcp/groups.ts";
import type { ToolKind } from "../providers/types.ts";
import { isSecretName, isSecretPath } from "../workspace/paths.ts";

/** tunelo's own tools an Advisor thread uses. */
export const ADVISOR_SESSION_TOOLS: readonly string[] = ["advisor_weigh", "advisor_git", "advisor_grep"];

/** tunelo's tools only an Advisor thread's session uses: refused without a card anywhere else. */
export const ADVISOR_ONLY_TOOLS: readonly string[] = ["advisor_git", "advisor_grep"];

/** Kinds of the AI's own tools an Advisor thread may use. */
const READ_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["read", "search", "todo"]);

/**
 * Claude's built-in tools an Advisor session starts with (Options.tools):
 * the rest are not even offered. ToolSearch loads MCP tools Claude defers.
 */
export const CLAUDE_ADVISOR_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "ToolSearch"];

/** Claude's tools taken out of an Advisor session's context, should the base set above not hold. */
export const CLAUDE_ADVISOR_DISALLOWED: readonly string[] = [
  "Bash",
  "BashOutput",
  "KillShell",
  "PowerShell",
  "Monitor",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "ExitPlanMode",
  "AskUserQuestion",
];

export const REFUSED_TOOL =
  "Advisor's session only reads: use Read, Grep (file names) or Glob inside this folder, advisor_grep for matching lines, advisor_git for git, and answer with advisor_weigh. Nothing may be written, run, fetched or asked of the user.";
export const REFUSED_PATH = "Advisor's session reads only inside its folder, never a secret file (keys, .env, credentials) or a sensitive folder.";
export const REFUSED_OWN_TOOL = "Only advisor_weigh, advisor_git and advisor_grep of tunelo are used in Advisor's session.";
export const ADVISOR_GIT_ONLY = "advisor_git and advisor_grep are only for Advisor's own session; use git and search as you would otherwise.";
export const REFUSED_CONTENT_SEARCH =
  "In Advisor's session a search shows file names or counts only: use advisor_grep to read the matching lines (secret files are left out).";
export const REFUSED_GLOB = "A file filter of Advisor's session stays inside its folder and never names a secret file (keys, .env, credentials).";

/**
 * One tool call as the guard sees it: its kind, tunelo's own tool it is ("" for
 * any other), the paths it names, the file filters (globs) it searches with,
 * and whether it shows the content of what it finds (a search printing lines).
 */
export type GuardCall = { kind: ToolKind; own: string; paths: readonly string[]; globs?: readonly string[]; contentSearch?: boolean };

/** undefined: the call may go on; otherwise what the AI is told instead. */
export function advisorGuard(call: GuardCall, ctx: { dir: string; isSensitive: (path: string) => boolean }): string | undefined {
  if (call.own !== "") return ADVISOR_SESSION_TOOLS.includes(call.own) ? undefined : REFUSED_OWN_TOOL;
  if (!READ_KINDS.has(call.kind)) return REFUSED_TOOL;
  // Lines of whatever a search finds would include secret files (an AI's own search follows no rule of tunelo's).
  if (call.contentSearch) return REFUSED_CONTENT_SEARCH;
  for (const p of call.paths) if (!readable(p, ctx.dir, ctx.isSensitive)) return REFUSED_PATH;
  for (const g of call.globs ?? []) if (!safeGlob(g)) return REFUSED_GLOB;
  return undefined;
}

/** `abs` inside `dir`, neither a secret file nor in a sensitive folder, by its name. */
function inside(abs: string, dir: string, isSensitive: (path: string) => boolean): boolean {
  const rel = relative(dir, abs);
  if (rel === "") return !isSensitive(abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return !isSecretPath(rel.split(sep).join("/")) && !isSensitive(abs);
}

function real(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * A path inside `dir`, neither a secret file nor in a sensitive folder: by
 * its name, then, when it exists, by where its links lead (a link to a
 * `.env` or out of the folder is refused). One that does not exist reads
 * nothing.
 */
export function readable(path: string, dir: string, isSensitive: (path: string) => boolean): boolean {
  if (path === "") return true;
  const abs = resolve(dir, path);
  if (!inside(abs, dir, isSensitive)) return false;
  const target = real(abs);
  return target === undefined || inside(target, real(dir) ?? dir, isSensitive);
}

/** Glob characters, taken off a filter's piece to read the name it means. */
const GLOB_CHARS = /[*?[\]!]/g;

/** A file filter that stays in the folder and names no secret file, whichever way its pieces read. */
function safeGlob(glob: string): boolean {
  const g = glob.trim().replace(/\\/g, "/");
  if (g === "") return true;
  if (g.startsWith("/") || g.startsWith("~") || /^[A-Za-z]:/.test(g)) return false;
  const pieces = g.split(/[/{},]/).filter((p) => p !== "");
  if (pieces.some((p) => p === "..")) return false;
  return !pieces.some((p) => isSecretName(p) || isSecretName(p.replace(GLOB_CHARS, "")));
}

/** tunelo's tool a Claude tool name is (`mcp__tunelo__advisor_git` → `advisor_git`); "" for any other. */
export function claudeOwnTool(name: string): string {
  const prefix = `mcp__${SESSION_MCP_SERVER}__`;
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  // Another MCP server's tool is not tunelo's: it reads as a tool of its own kind ("mcp"), refused.
  return "";
}

// The Live Map station of a tool call, worked out where the raw call is still
// in memory: in the privacy filter (privacy/filter-hook-event.ts), for the
// SDK callbacks and the hook process alike. The command line and the full
// path are read here and dropped; only the station and its flags are kept,
// whatever the project's content setting. A source that never had the raw
// call (OpenTelemetry, a spool line from an older hook) places it by the
// filtered target instead (stationOfTarget), flagged `estimated`.
import { type CommandClass, commandClasses } from "../../activity/command-class.ts";

export type Station = "CORE" | "FILES" | "MEMORY" | "TESTING" | "GIT" | "SANDBOX" | "MCP" | "EXTERNAL" | "SKILLS" | "ORCHESTRATOR";

/** What a call did besides its station, as bits of `station_flags`. */
export const StationFlag = {
  commit: 1,
  push: 2,
  deploy: 4,
  /** A file tool that writes. */
  write: 8,
  /** A write to an instruction or memory file (`CLAUDE.md`, `.claude/rules/**`, `MEMORY.md`, `memory/**`). */
  memory: 16,
  /** Placed from the filtered target, not the raw call: may be wrong. */
  estimated: 32,
} as const;

export type StationPlace = { station: Station; flags: number };

const READ_TOOLS = new Set(["Read", "NotebookRead", "Grep", "Glob", "LS"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const ORCHESTRATION_TOOLS = new Set(["Task", "Agent", "TodoWrite", "EnterPlanMode", "ExitPlanMode"]);

/** Instruction files by name, any case (`CLAUDE.md`, `claude.local.md`, `MEMORY.md`). */
const MEMORY_NAMES = new Set(["claude.md", "claude.local.md", "memory.md"]);

/**
 * An instruction or memory file, by its path with either slash: an
 * instruction file by name, anything under `.claude/rules/` or
 * `.claude/agent-memory/`, and a Markdown file in a `memory/` folder (a
 * `src/memory/cache.ts` is code, not memory).
 */
export function isMemoryPath(path: string): boolean {
  const p = `/${path.replaceAll("\\", "/")}`;
  const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  if (MEMORY_NAMES.has(name)) return true;
  if (p.includes("/.claude/rules/") || p.includes("/.claude/agent-memory/")) return true;
  return p.includes("/memory/") && name.endsWith(".md");
}

/** A shell line is read this far for its station: enough for any real command line, bounded for a heredoc of megabytes. */
const MAX_SHELL_CHARS = 64 * 1024;

const SHELL_FLAGS: Partial<Record<CommandClass, number>> = { commit: StationFlag.commit, push: StationFlag.push, deploy: StationFlag.deploy };
const GIT_CLASSES: ReadonlySet<CommandClass> = new Set(["commit", "push", "git", "deploy"]);

/** The station of a shell line from the classes of the commands it chains: GIT (flags of all) when any ships, else TESTING when any checks, else SANDBOX. */
function shellPlace(command: string): StationPlace {
  const classes = commandClasses(command.slice(0, MAX_SHELL_CHARS));
  const flags = classes.reduce((bits, c) => bits | (SHELL_FLAGS[c] ?? 0), 0);
  if (classes.some((c) => GIT_CLASSES.has(c))) return { station: "GIT", flags };
  if (classes.includes("check")) return { station: "TESTING", flags: 0 };
  return { station: "SANDBOX", flags: 0 };
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The station of a call of `toolName` with its raw `tool_input`. */
export function stationOf(toolName: string, input: unknown): StationPlace {
  const args = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (READ_TOOLS.has(toolName)) return { station: "FILES", flags: 0 };
  if (WRITE_TOOLS.has(toolName)) {
    const path = text(args.file_path) || text(args.notebook_path);
    return isMemoryPath(path) ? { station: "MEMORY", flags: StationFlag.write | StationFlag.memory } : { station: "FILES", flags: StationFlag.write };
  }
  if (SHELL_TOOLS.has(toolName)) return shellPlace(text(args.command));
  if (toolName.startsWith("mcp__")) return { station: "MCP", flags: 0 };
  if (WEB_TOOLS.has(toolName)) return { station: "EXTERNAL", flags: 0 };
  if (toolName === "Skill") return { station: "SKILLS", flags: 0 };
  if (ORCHESTRATION_TOOLS.has(toolName)) return { station: "ORCHESTRATOR", flags: 0 };
  return { station: "CORE", flags: 0 };
}

/**
 * The station of a call known only by its filtered `target` (a shell call's
 * program, a file's `folder/name`), flagged `estimated`: `git` alone cannot
 * tell a commit from a push, nor `folder/name` every memory folder.
 */
export function stationOfTarget(toolName: string, target: string | undefined): StationPlace {
  const t = target ?? "";
  const place = stationOf(toolName, SHELL_TOOLS.has(toolName) ? { command: t } : { file_path: t });
  return { station: place.station, flags: place.flags | StationFlag.estimated };
}

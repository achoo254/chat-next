// The Live Map station of a tool call, worked out where the raw call is still
// in memory: in the privacy filter (privacy/filter-hook-event.ts), for the
// SDK callbacks and the hook process alike. The command line and the full
// path are read here and dropped; only the station and its flags are kept,
// whatever the project's content setting. A source that never had the raw
// call (OpenTelemetry, a spool line from an older hook) places it by the
// filtered target instead (stationOfTarget), flagged `estimated`.
import { type CommandClass, commandClass } from "../../activity/command-class.ts";

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

/** An instruction or memory file, by its path with either slash. */
export function isMemoryPath(path: string): boolean {
  const p = `/${path.replaceAll("\\", "/")}`;
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (name === "CLAUDE.md" || name === "MEMORY.md") return true;
  return p.includes("/.claude/rules/") || p.includes("/.claude/agent-memory/") || p.includes("/memory/");
}

const SHELL_PLACES: Record<CommandClass, StationPlace> = {
  check: { station: "TESTING", flags: 0 },
  commit: { station: "GIT", flags: StationFlag.commit },
  push: { station: "GIT", flags: StationFlag.push },
  git: { station: "GIT", flags: 0 },
  deploy: { station: "GIT", flags: StationFlag.deploy },
  shell: { station: "SANDBOX", flags: 0 },
};

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The station of a call of `toolName` with its raw `tool_input`. */
export function stationOf(toolName: string, input: unknown): StationPlace {
  const args = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (READ_TOOLS.has(toolName)) return { station: "FILES", flags: 0 };
  if (WRITE_TOOLS.has(toolName)) {
    const path = text(args.file_path) || text(args.notebook_path);
    return isMemoryPath(path) ? { station: "MEMORY", flags: StationFlag.write | StationFlag.memory } : { station: "FILES", flags: StationFlag.write };
  }
  if (SHELL_TOOLS.has(toolName)) return { ...SHELL_PLACES[commandClass(text(args.command))] };
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

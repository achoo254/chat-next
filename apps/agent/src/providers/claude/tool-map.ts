// Claude Code tool names → generic tool kinds, one-line summaries and diffs.
import { isAbsolute, relative } from "node:path";
import type { ToolKind } from "../types.ts";

const KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "shell",
  BashOutput: "shell",
  KillShell: "shell",
  PowerShell: "shell",
  Monitor: "shell",
  Grep: "search",
  Glob: "search",
  LS: "search",
  LSP: "search",
  ToolSearch: "search",
  WebFetch: "web",
  WebSearch: "web",
  Task: "subagent",
  Agent: "subagent",
  TodoWrite: "todo",
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return KINDS[name] ?? "other";
}

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function shortPath(p: string, dir: string): string {
  if (!p || !isAbsolute(p)) return p;
  const rel = relative(dir, p);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
}

/** One line shown on the tool card. */
export function toolSummary(name: string, input: Input, dir: string): string {
  const line = (() => {
    switch (toolKind(name)) {
      case "shell":
        return str(input.command) || str(input.bash_id) || str(input.shell_id);
      case "read":
      case "edit":
        return shortPath(str(input.file_path) || str(input.notebook_path), dir);
      case "search":
        return [str(input.pattern) || str(input.query), shortPath(str(input.path), dir)].filter(Boolean).join(" in ");
      case "web":
        return str(input.url) || str(input.query);
      case "subagent":
        return str(input.description);
      case "mcp":
        return name.split("__").slice(1).join(" · ");
      default:
        return "";
    }
  })();
  return line.split("\n")[0]?.slice(0, 300) ?? "";
}

/** Every path-like value in a tool input, for the sensitive check. */
export function toolPaths(input: Input): string[] {
  const out: string[] = [];
  for (const key of ["file_path", "notebook_path", "path", "cwd"]) {
    const v = str(input[key]);
    if (v) out.push(v);
  }
  return out;
}

function lines(s: string): string[] {
  return s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** A context-free unified diff of an edit, from the tool input. */
export function toolDiff(name: string, input: Input, dir: string) {
  const path = shortPath(str(input.file_path) || str(input.notebook_path), dir);
  let removed: string[] = [];
  let added: string[];
  if (name === "Write") {
    added = lines(str(input.content));
  } else if (name === "Edit") {
    removed = lines(str(input.old_string));
    added = lines(str(input.new_string));
  } else if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const hunks = (input.edits as Input[]).map((e) => ({ r: lines(str(e.old_string)), a: lines(str(e.new_string)) }));
    const body = hunks.flatMap((h) => ["@@", ...h.r.map((l) => `-${l}`), ...h.a.map((l) => `+${l}`)]);
    return {
      path,
      unified: [`--- a/${path}`, `+++ b/${path}`, ...body].join("\n"),
      added: hunks.reduce((n, h) => n + h.a.length, 0),
      removed: hunks.reduce((n, h) => n + h.r.length, 0),
    };
  } else if (name === "NotebookEdit") {
    added = lines(str(input.new_source));
  } else {
    return null;
  }
  const unified = [
    `--- ${name === "Write" ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    "@@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
  return { path, unified, added: added.length, removed: removed.length };
}

/** Plain text of a tool_result content (string or content blocks). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : ""))
      .join("\n");
  }
  return "";
}

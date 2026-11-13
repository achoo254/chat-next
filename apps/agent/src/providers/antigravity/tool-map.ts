// agy's tool calls in the shared tool model: kind, one-line summary, the
// paths they touch (for the sensitive label) and file edits as diffs. Tool
// names and ACP kinds agy does not use yet fall back to "other".
import { relative, resolve } from "node:path";
import type { ToolKind } from "../types.ts";
import type { AcpToolCall } from "../acp/acp-session.ts";

const BY_ACP_KIND: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  execute: "shell",
  fetch: "web",
  think: "other",
};

const BY_NAME: Record<string, ToolKind> = {
  view_file: "read",
  read_file: "read",
  list_dir: "read",
  write_file: "edit",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  run_command: "shell",
  grep_search: "search",
  find_by_name: "search",
  read_url_content: "web",
  search_web: "web",
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function toolKind(call: AcpToolCall): ToolKind {
  const name = call.name ?? "";
  if (name.startsWith("mcp_") || name.includes("__")) return "mcp";
  return BY_NAME[name] ?? BY_ACP_KIND[call.kind ?? ""] ?? "other";
}

/** Paths a call names (its locations and path-like inputs), made absolute against the session's folder. */
export function toolPaths(call: AcpToolCall, dir: string): string[] {
  const input = obj(call.rawInput);
  const out = new Set<string>();
  for (const l of call.locations ?? []) if (l.path) out.add(resolve(dir, l.path));
  for (const key of ["Path", "AbsolutePath", "TargetFile", "path", "file_path", "Cwd"]) {
    const v = str(input[key]);
    if (v) out.add(resolve(dir, v));
  }
  return [...out];
}

const shortPath = (path: string, dir: string): string => {
  const rel = relative(dir, path);
  return rel && !rel.startsWith("..") ? rel : path;
};

/** One line for the card and the transcript. */
export function toolSummary(call: AcpToolCall, dir: string): string {
  const input = obj(call.rawInput);
  const command = str(input.CommandLine);
  if (command) return command.slice(0, 300);
  const path = toolPaths(call, dir)[0];
  if (path && (call.title ?? "").startsWith("File ")) return shortPath(path, dir);
  return (call.title ?? call.name ?? "tool").slice(0, 300);
}

export function describe(call: AcpToolCall, dir: string): { kind: ToolKind; name: string; summary: string; input: string } {
  return { kind: toolKind(call), name: call.name ?? call.kind ?? "tool", summary: toolSummary(call, dir), input: JSON.stringify(call.rawInput ?? {}) };
}

const lines = (s: string): string[] => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** A file edit of a call (ACP diff content) as a context-free unified diff. */
export function toolDiff(call: AcpToolCall, dir: string): { path: string; unified: string; added: number; removed: number } | undefined {
  const d = (Array.isArray(call.content) ? call.content : []).find((c) => c.type === "diff" && typeof c.path === "string");
  if (!d?.path) return undefined;
  const path = shortPath(d.path, dir);
  const removed = lines(d.oldText ?? "");
  const added = lines(d.newText ?? "");
  const unified = [`--- ${d.oldText == null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`, "@@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  return { path, unified, added: added.length, removed: removed.length };
}

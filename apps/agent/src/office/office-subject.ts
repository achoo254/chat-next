// The short subject shown in a speech bubble over the director: a file name
// without its folder, a command's first word, a host name or an MCP tool's
// name. Never a whole command, a path, a query or anything the core holds
// sensitive (docs/office-wire.md, part 5).
import type { ToolKind } from "../providers/types.ts";
import { commandHead } from "./office-activity-map.ts";

export const SUBJECT_MAX = 40;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** At most SUBJECT_MAX characters (code points), cut with "…", without control characters. */
function clip(s: string): string {
  const chars = [...s.replace(CONTROL, "").trim()];
  return chars.length <= SUBJECT_MAX ? chars.join("") : `${chars.slice(0, SUBJECT_MAX - 1).join("")}…`;
}

/** The last part of a path, whichever separator it uses. */
function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The host of a URL; "" when it is not one (a search query). */
function host(text: string): string {
  if (!/^https?:\/\//i.test(text.trim())) return "";
  try {
    return new URL(text.trim()).hostname;
  } catch {
    return "";
  }
}

/** The tool's own name of an MCP call (`mcp__server__tool` → `tool`). */
function mcpTool(name: string): string {
  const parts = name.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : "";
}

/**
 * The subject of one of the director's tool calls. `summary` is the one line
 * the chat's tool card shows (a shell's command, a path relative to the
 * session's folder, a URL or query); `sensitive` is the core's verdict on
 * the call (it touches a sensitive path).
 */
export function officeSubject(tool: { kind: ToolKind; name: string; summary: string; sensitive: boolean }): string {
  if (tool.sensitive) return "";
  switch (tool.kind) {
    case "read":
    case "edit":
      return clip(fileName(tool.summary));
    case "shell":
      return clip(commandHead(tool.summary));
    case "web":
      return clip(host(tool.summary));
    case "mcp":
      return clip(mcpTool(tool.name));
    default:
      return "";
  }
}

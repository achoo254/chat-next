// The class of a tool call stored in `tool_calls.office_room`: the office room
// of docs/office-wire.md part 4 (office/office-activity-map.ts), written in
// lower case (`library`, `work`, `planning`, `post`, `lobby`, `qa`, `server`,
// `meeting`), so the Live Map places the call without reading anything else.
// A shell call is placed by the program the filter kept as its target (never
// by the command line, which is content and may be absent): the same
// answer for its PreToolUse and PostToolUse, whatever the project's content
// setting. And the MCP server of an `mcp__<server>__<tool>` call.
import { OfficeRoom } from "@achoo254/chat-proto/remote/remote";
import { classifyActivity } from "../../office/office-activity-map.ts";
import { toolKind } from "../../providers/claude/tool-map.ts";

export type ToolClass = {
  /** The office room in lower case. */
  officeRoom: string;
  mcpServer?: string;
};

const MCP = /^mcp__(.+?)__.+$/;

/** The class of a call of `toolName` whose filtered target is `target`. */
export function classifyTool(toolName: string, target: string | undefined): ToolClass {
  const kind = toolKind(toolName);
  const place = classifyActivity({ kind, name: toolName, ...(kind === "shell" ? { command: target ?? "" } : {}) });
  const room = (OfficeRoom[place.room] ?? "WORK").toLowerCase();
  const server = MCP.exec(toolName)?.[1];
  return { officeRoom: room, ...(server ? { mcpServer: server } : {}) };
}

/** A shell call: placed by its command, so a source without the target (OpenTelemetry) leaves the class to the hooks. */
export function isShellTool(toolName: string): boolean {
  return toolKind(toolName) === "shell";
}

// The key a tool call's speed is judged by: its tool, its station and, for a
// shell call, its program (`npm`, `git`, `cargo`: the filtered target) or, for
// an MCP call, its server. A `pnpm test` and an `ls` are both Bash but never
// share a p95; the file a Read touched does not split the key.
import { isShellTool } from "../../ingest/tool-classification.ts";

export type ToolKeyParts = { toolName: string; station: string | null; target: string | null; mcpServer: string | null };

/** `Bash|TESTING|pnpm`, `mcp__github__search|MCP|github`, `Read|FILES|`. */
export function toolKeyOf(call: ToolKeyParts): string {
  const third = isShellTool(call.toolName) ? (call.target ?? "") : (call.mcpServer ?? "");
  return `${call.toolName}|${call.station ?? "CORE"}|${third}`;
}

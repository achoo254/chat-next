// What a tool call touched, as a short label, and whether it touched a
// secret: the file's name and parent folder for file tools, the domain for
// web fetches, the program of a shell command, `server › tool` for MCP, the
// subagent's type. A call on a secret file (`.env`, a key, a sensitive
// folder) keeps only the file's name and none of its content.
import { type PathContext, baseName, isSecretPath, labelValue, mcpLabel, mentionsSecret, pathLabel, shellProgram, urlDomain } from "./privacy-labels.ts";
import { boundedJson } from "./privacy-text.ts";
import { tildePath } from "./home-and-account.ts";

export type ToolTarget = {
  /** The label, when the tool has one. */
  target?: string;
  /** The call names a secret file or a sensitive folder: its content is not kept. */
  secret: boolean;
};

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Glob", "Grep", "LS"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function fileTarget(path: unknown, ctx: PathContext): ToolTarget {
  if (typeof path !== "string" || path === "") return { secret: false };
  if (isSecretPath(path, ctx)) return { target: baseName(path), secret: true };
  // From `~` on, so a file right in the home folder is `~/notes.txt`, not `<account>/notes.txt`.
  return { target: pathLabel(tildePath(path, ctx.home)), secret: false };
}

/** The label and secrecy of a call of `toolName` with `input` (the hook's `tool_input`). */
export function toolTarget(toolName: string, input: unknown, ctx: PathContext): ToolTarget {
  const args = record(input);
  if (FILE_TOOLS.has(toolName)) return fileTarget(args.file_path ?? args.notebook_path, ctx);
  if (SEARCH_TOOLS.has(toolName)) {
    const found = fileTarget(args.path, ctx);
    // A search for a secret file by its pattern (`**/.env`) reads secrets just the same.
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return { ...found, secret: found.secret || (pattern !== "" && mentionsSecret(pattern, ctx)) };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof args.command === "string" ? args.command : "";
    const program = shellProgram(command);
    return { ...(program ? { target: program } : {}), secret: command !== "" && mentionsSecret(command, ctx) };
  }
  if (toolName === "WebFetch") {
    const domain = urlDomain(args.url);
    return { ...(domain ? { target: domain } : {}), secret: false };
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    const type = labelValue(args.subagent_type, 80);
    return { ...(type ? { target: type } : {}), secret: false };
  }
  if (toolName === "Skill") {
    const skill = labelValue(args.skill ?? args.command, 80);
    return { ...(skill ? { target: skill } : {}), secret: false };
  }
  // MCP and any other tool: the input may name a file anywhere in it.
  const mcp = mcpLabel(toolName);
  const secret = input !== undefined && mentionsSecret(boundedJson(input), ctx);
  return { ...(mcp ? { target: mcp } : {}), secret };
}

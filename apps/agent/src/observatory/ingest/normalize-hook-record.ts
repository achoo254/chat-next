// A filtered hook record (an SDK callback in the agent, or a line of the hook
// spool) as writes on the Observatory tables. Pure: no store, no file, no
// clock; what needs another record is returned as a join fact
// (normalized-record.ts). Every field is read as optional; a record without
// the key its table needs, or of an event not known here, writes nothing and
// says so.
//
// Content: a prompt's excerpt goes to `prompts.excerpt`; a tool call's input,
// output, error text and denial reason (already redacted and cut by the
// filter) go to `tool_calls.content` as one JSON object
// `{"input", "output", "error", "reason"}` (the parts present), written only
// by the call's end (PostToolUse / PostToolUseFailure / PermissionDenied), so
// a late PreToolUse never replaces it with less. The store blocks and clears
// that column for a project without content; `tool_calls.error` holds only a
// fixed label (TOOL_ERROR), never text from the call.
import type { FilteredHookRecord, RecordOrigin } from "../privacy/filtered-record.ts";
import type { SessionSource } from "../store/observatory-rows.ts";
import type { SessionWrite, ToolCallWrite, WriteOp } from "../store/write-ops.ts";
import { runsGitCommit } from "./git-commit-command.ts";
import { type NormalizedRecord, emptyNormalized } from "./normalized-record.ts";
import { RecordFields } from "./record-fields.ts";
import { INTERNAL_LABEL_FIELD, knownHookFields } from "./record-known-fields.ts";
import { classifyTool, isShellTool } from "./tool-classification.ts";

/** Hook events with no table of their own: their session is still recorded. */
const KNOWN_WITHOUT_TABLE = new Set(["Stop", "StopFailure", "PostToolBatch", "PermissionRequest", "PreCompact", "PostCompact", "Notification"]);
const COMMAND_IN_JSON = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** Hook records from the agent's own SDK sessions, else the installed hooks (terminal or CLI: not told apart in a record). */
export function sessionSourceOf(origin: RecordOrigin): SessionSource {
  return origin === "sdk" ? "sdk" : "cli";
}

/** The shell command of a filtered `tool_input` (JSON text, maybe cut short). */
function commandOf(toolInput: string | undefined): string {
  if (!toolInput) return "";
  try {
    const parsed: unknown = JSON.parse(toolInput);
    if (typeof parsed === "object" && parsed !== null && "command" in parsed && typeof parsed.command === "string") return parsed.command;
  } catch {
    // cut short: read the command's start out of the text
  }
  return (COMMAND_IN_JSON.exec(toolInput)?.[1] ?? "").replaceAll('\\"', '"');
}

/** The labels `tool_calls.error` holds: why a call did not succeed, never its text. */
export const TOOL_ERROR = { failed: "failed", interrupted: "interrupted", denied: "permission denied" } as const;

/** The content parts of a tool call, by their name in `tool_calls.content`. */
const CONTENT_PARTS: readonly [field: string, part: string][] = [
  ["tool_input", "input"],
  ["tool_response", "output"],
  ["error", "error"],
  ["reason", "reason"],
];

function toolContent(c: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!c) return undefined;
  const parts = Object.fromEntries(CONTENT_PARTS.flatMap(([field, part]) => (c[field] !== undefined ? [[part, c[field]]] : [])));
  return Object.keys(parts).length > 0 ? JSON.stringify(parts) : undefined;
}

/** `record` (from `origin`) as writes and join facts. */
export function normalizeHookRecord(record: FilteredHookRecord, origin: RecordOrigin): NormalizedRecord {
  const r = new RecordFields(record.f);
  const sessionId = r.text("session_id");
  const known = knownHookFields(record.event, origin === "sdk");
  if (!known) return { ...emptyNormalized("unknown-event", sessionId), mistypedFields: r.mistyped };
  if (!sessionId) return { ...emptyNormalized("missing-key"), unknownFields: r.unknown(known), mistypedFields: r.mistyped };

  const at = record.at;
  const c = record.c;
  const promptId = r.text("prompt_id");
  const agentId = r.text("agent_id");
  const cwd = r.text("cwd");
  const source = sessionSourceOf(origin);
  // The project of this event's folder: the session's row keeps where it started, a row holding content keeps its own.
  const projectKey = r.text("project_key");
  const session: SessionWrite = { sessionId, source, startedAt: at, cwd, projectKey };
  const label = origin === "sdk" ? r.text(INTERNAL_LABEL_FIELD) : undefined;
  if (label) session.internalLabel = label;
  const out: NormalizedRecord = { ...emptyNormalized("stored", sessionId), session };
  const push = (op: WriteOp): number => out.ops.push(op);

  const toolCall = (): ToolCallWrite | undefined => {
    const toolUseId = r.text("tool_use_id");
    if (!toolUseId) return undefined;
    const toolName = r.text("tool_name");
    const target = r.text("target");
    const cls = toolName ? classifyTool(toolName, target, { station: r.text("station"), flags: r.number("station_flags") }) : undefined;
    return { toolUseId, sessionId, promptId, agentId, at, toolName, mcpServer: cls?.mcpServer, target, inputBytes: r.number("input_bytes") };
  };

  switch (record.event) {
    case "SessionStart": {
      session.mainModel = r.text("model");
      if (r.text("source") === "clear" && cwd) out.clearStarted = { sessionId, cwd, at, source };
      break;
    }
    case "SessionEnd": {
      session.endedAt = at;
      if (r.text("reason") === "clear" && cwd) out.clearEnded = { sessionId, cwd, at, source };
      break;
    }
    case "UserPromptSubmit": {
      if (!promptId) out.outcome = "missing-key";
      else push({ kind: "prompt", row: { promptId, sessionId, at, length: r.number("prompt_length"), excerpt: c?.prompt, projectKey } });
      break;
    }
    case "PreToolUse": {
      const call = toolCall();
      if (!call) out.outcome = "missing-key";
      else {
        push({ kind: "toolCall", row: call });
        out.toolStart = { toolUseId: call.toolUseId, sessionId, at, hasDuration: false };
      }
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const call = toolCall();
      if (!call) {
        out.outcome = "missing-key";
        break;
      }
      const failed = record.event === "PostToolUseFailure";
      const durationMs = r.number("duration_ms");
      // The row's time is the call's start: the end less its duration, when told.
      const start = durationMs !== undefined ? at - durationMs : at;
      push({ kind: "toolCall", row: { ...call, at: start, durationMs, outputBytes: r.number("output_bytes"), success: !failed, error: failed ? (r.flag("is_interrupt") === true ? TOOL_ERROR.interrupted : TOOL_ERROR.failed) : undefined, content: toolContent(c), projectKey } });
      out.toolEnd = { toolUseId: call.toolUseId, sessionId, at, hasDuration: durationMs !== undefined };
      if (failed) break;
      const gitOp = r.text("git_op");
      const sha = r.text("git_sha");
      if (gitOp || sha) push({ kind: "gitOp", row: { sessionId, promptId, at, sha, branch: r.text("git_branch"), kind: gitOp ?? "commit" } });
      else if (call.toolName && isShellTool(call.toolName) && call.target === "git" && cwd && runsGitCommit(commandOf(c?.tool_input))) {
        out.undescribedCommit = { sessionId, toolUseId: call.toolUseId, promptId, at, cwd };
      }
      break;
    }
    case "PermissionDenied": {
      const call = toolCall();
      if (!call) out.outcome = "missing-key";
      else push({ kind: "toolCall", row: { ...call, success: false, error: TOOL_ERROR.denied, content: toolContent(c), projectKey } });
      break;
    }
    case "SubagentStart":
    case "SubagentStop": {
      if (!agentId) {
        out.outcome = "missing-key";
        break;
      }
      const ended = record.event === "SubagentStop" ? { endedAt: at } : {};
      push({ kind: "subagent", row: { sessionId, agentId, promptId, agentType: r.text("agent_type"), startedAt: at, ...ended } });
      break;
    }
    case "InstructionsLoaded": {
      const filePath = r.text("file_path");
      if (!filePath) out.outcome = "missing-key";
      else out.instruction = { sessionId, at, filePath, memoryType: r.text("memory_type"), loadReason: r.text("load_reason") ?? "unknown" };
      break;
    }
    default:
      if (KNOWN_WITHOUT_TABLE.has(record.event)) out.outcome = "known";
      else out.outcome = "unknown-event";
  }
  out.unknownFields = r.unknown(known);
  out.mistypedFields = r.mistyped;
  return out;
}

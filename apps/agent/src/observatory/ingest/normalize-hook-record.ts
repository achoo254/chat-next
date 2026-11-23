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
//
// A tool call keeps the Live Map station the filter worked out (an estimate
// from the target for a record without one), the salted key of its file and
// a Read's page. The moments that are not a call, a prompt or an API call
// (permission asked or denied, compaction, the turn's end or failure,
// notifications, a todo list's counts) are session events
// (session-event-write.ts): labels and numbers only, never content.
import type { FilteredHookRecord, RecordOrigin } from "../privacy/filtered-record.ts";
import type { SessionSource } from "../store/observatory-rows.ts";
import type { SessionWrite, ToolCallWrite, WriteOp } from "../store/write-ops.ts";
import { runsGitCommit } from "./git-commit-command.ts";
import { type NormalizedRecord, emptyNormalized } from "./normalized-record.ts";
import { RecordFields } from "./record-fields.ts";
import { INTERNAL_LABEL_FIELD, knownHookFields } from "./record-known-fields.ts";
import { sessionEventOp } from "./session-event-write.ts";
import { classifyTool, isShellTool } from "./tool-classification.ts";

/** Hook events with no table of their own: their session is still recorded. */
const KNOWN_WITHOUT_TABLE = new Set(["PostToolBatch"]);
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
    return {
      toolUseId,
      sessionId,
      promptId,
      agentId,
      at,
      toolName,
      mcpServer: cls?.mcpServer,
      station: cls?.station,
      stationFlags: cls?.stationFlags,
      target,
      targetKey: r.text("target_key"),
      readOffset: r.number("read_offset"),
      readLimit: r.number("read_limit"),
      inputBytes: r.number("input_bytes"),
    };
  };

  /** The event of a TodoWrite's counts by status (label `pending/in progress/done`, number their total), when the record has them. */
  const todoCounts = (call: ToolCallWrite): void => {
    const counts = [r.number("todo_pending"), r.number("todo_in_progress"), r.number("todo_done")];
    if (counts.some((n) => n === undefined)) return;
    const [pending = 0, inProgress = 0, done = 0] = counts;
    push(sessionEventOp("todo_counts", { sessionId, at, agentId, toolUseId: call.toolUseId, station: call.station, label: `${pending}/${inProgress}/${done}`, number: pending + inProgress + done }, [call.toolUseId]));
  };
  /** A turn's end is told apart by its prompt, else by its time. */
  const turnKey = (): (string | number | undefined)[] => (promptId ? [promptId] : [undefined, at]);

  const mode = agentId ? undefined : r.text("permission_mode");
  if (mode) out.permissionMode = { sessionId, at, value: mode };

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
        todoCounts(call);
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
      todoCounts(call);
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
      else {
        push({ kind: "toolCall", row: { ...call, success: false, error: TOOL_ERROR.denied, content: toolContent(c), projectKey } });
        push(sessionEventOp("permission_denied", { sessionId, at, agentId, toolUseId: call.toolUseId, station: call.station, label: call.toolName }, [call.toolUseId]));
      }
      break;
    }
    case "PermissionRequest": {
      // No tool_use_id in this event (Claude Code 2.1): told apart by its prompt, agent, time and tool.
      const toolName = r.text("tool_name");
      const cls = toolName ? classifyTool(toolName, r.text("target"), { station: r.text("station"), flags: r.number("station_flags") }) : undefined;
      push(sessionEventOp("permission_request", { sessionId, at, agentId, station: cls?.station, label: toolName }, [promptId, agentId, at, toolName]));
      break;
    }
    case "PreCompact":
    case "PostCompact": {
      const trigger = r.text("trigger");
      push(sessionEventOp(record.event === "PreCompact" ? "compact_start" : "compact_end", { sessionId, at, station: "CORE", label: trigger }, [at, trigger]));
      break;
    }
    case "Stop":
      push(sessionEventOp("stop", { sessionId, at, station: "CORE" }, turnKey()));
      break;
    case "StopFailure":
      push(sessionEventOp("stop_failure", { sessionId, at, station: "CORE", label: r.text("error") }, turnKey()));
      break;
    case "Notification": {
      const type = r.text("notification_type");
      push(sessionEventOp("notification", { sessionId, at, agentId, label: type }, [at, type]));
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

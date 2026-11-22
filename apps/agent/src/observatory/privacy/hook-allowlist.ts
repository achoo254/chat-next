// The hook fields Observatory keeps, event by event; every other field of a
// hook payload is dropped (transcript paths, permission suggestions, compact
// summaries, displayed text, background tasks, anything Claude Code adds
// later). An event not listed here is dropped whole (MessageDisplay carries
// only displayed text).
//
// How each field is kept:
// - id: a machine id as it is (session, prompt, tool use, agent);
// - label: a short string without control characters, redacted;
// - number, bool: as they are;
// - path: home folder as `~`, only the name for a secret file;
// - content: redacted then cut (privacy-text.ts), kept apart, and only when
//   the project stores content and the call touched no secret file.

export type FieldRule = "id" | "label" | "number" | "bool" | "path" | "content";

/** Fields every event keeps. */
export const COMMON_HOOK_FIELDS: Readonly<Record<string, FieldRule>> = {
  session_id: "id",
  prompt_id: "id",
  cwd: "path",
  permission_mode: "label",
  agent_id: "id",
  agent_type: "label",
  effort: "label",
};

const TOOL: Readonly<Record<string, FieldRule>> = { tool_name: "label", tool_use_id: "id", tool_input: "content" };

/** The events kept and their own fields. */
export const HOOK_EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldRule>>>> = {
  SessionStart: { source: "label", model: "label" },
  SessionEnd: { reason: "label" },
  UserPromptSubmit: { prompt: "content" },
  PreToolUse: TOOL,
  PostToolUse: { ...TOOL, duration_ms: "number", tool_response: "content" },
  PostToolUseFailure: { ...TOOL, duration_ms: "number", is_interrupt: "bool", error: "content" },
  // Only the ids of the batch's calls (tool_use_ids, below).
  PostToolBatch: {},
  PermissionRequest: { tool_name: "label", tool_input: "content" },
  PermissionDenied: { tool_name: "label", tool_use_id: "id", tool_input: "content", reason: "content" },
  SubagentStart: {},
  SubagentStop: { stop_hook_active: "bool", last_assistant_message: "content" },
  Stop: { stop_hook_active: "bool", last_assistant_message: "content" },
  StopFailure: { error: "label", last_assistant_message: "content" },
  InstructionsLoaded: { file_path: "path", memory_type: "label", load_reason: "label" },
  PreCompact: { trigger: "label" },
  PostCompact: { trigger: "label" },
  Notification: { notification_type: "label" },
};

/** The hook events Observatory keeps. */
export function isKeptHookEvent(event: string): boolean {
  return Object.hasOwn(HOOK_EVENT_FIELDS, event);
}

/** Events whose `tool_input` names a tool target (tool-target.ts). */
export const TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

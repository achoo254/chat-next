// Hook payloads and an OTLP logs request shaped like the ones the spike and
// phase 1 recorded from Claude Code 2.1.330, with every identifying value
// replaced by an obviously fake one (example.invalid, example-*). The fake
// values are listed in FAKE_IDENTIFIERS so tests can check none survives.
import { join } from "node:path";
import { createSensitiveCheck } from "../../src/safety/sensitive-paths.ts";

/** A home folder that does not exist on any machine. */
export const FAKE_HOME = process.platform === "win32" ? "C:\\Users\\example-user" : "/home/example-user";
export const FAKE_CWD = join(FAKE_HOME, "work", "example-app");
export const isFakeSensitive = createSensitiveCheck({ home: FAKE_HOME });

/** Values that must never appear in a filtered record. */
export const FAKE_IDENTIFIERS = [
  "user@example.invalid",
  "example-account-uuid",
  "example-account-id",
  "example-user-id",
  "example-org-id",
  "example-host",
  "example-team",
  "example-user",
  "transcript",
  "example-subscription",
];

const common = {
  session_id: "sess-0001",
  transcript_path: join(FAKE_HOME, ".claude", "projects", "example-app", "sess-0001.jsonl"),
  cwd: FAKE_CWD,
  permission_mode: "default",
  prompt_id: "prompt-0001",
  // Not a hook field: an unknown key must never pass.
  user_email: "user@example.invalid",
};

export const HOOK_PAYLOADS: Record<string, Record<string, unknown>> = {
  SessionStart: { ...common, hook_event_name: "SessionStart", source: "startup", model: "claude-haiku-4-5" },
  UserPromptSubmit: { ...common, hook_event_name: "UserPromptSubmit", prompt: "fix the failing test in src/app.ts" },
  PreToolUse: { ...common, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_0001", tool_input: { file_path: join(FAKE_CWD, "src", "app.ts") } },
  PostToolUse: {
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_0002",
    duration_ms: 569,
    tool_input: { command: "cd example-app && pnpm exec vitest run", description: "run tests" },
    tool_response: { stdout: "1 passed", stderr: "", gitOperation: { commit: { sha: "abc1234def", kind: "commit", branch: "feat/example" } } },
  },
  PostToolUseFailure: { ...common, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: "toolu_0003", duration_ms: 12, error: "exit code 1", tool_input: { command: "false" } },
  PostToolBatch: { ...common, hook_event_name: "PostToolBatch", tool_calls: [{ tool_use_id: "toolu_0001", tool_name: "Read" }, { tool_use_id: "toolu_0002" }] },
  SubagentStart: { ...common, hook_event_name: "SubagentStart", agent_id: "agent-0001", agent_type: "Explore" },
  SubagentStop: {
    ...common,
    hook_event_name: "SubagentStop",
    agent_id: "agent-0001",
    agent_type: "Explore",
    agent_transcript_path: join(FAKE_HOME, ".claude", "projects", "example-app", "agent-0001.jsonl"),
    last_assistant_message: "found it in src/app.ts",
    background_tasks: [],
  },
  Stop: { ...common, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done", session_crons: [] },
  InstructionsLoaded: { ...common, hook_event_name: "InstructionsLoaded", file_path: join(FAKE_CWD, "CLAUDE.md"), memory_type: "Project", load_reason: "session_start" },
  PostCompact: { ...common, hook_event_name: "PostCompact", trigger: "manual", compact_summary: "the user example-user asked…" },
  SessionEnd: { ...common, hook_event_name: "SessionEnd", reason: "other" },
};

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const i = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } });
const d = (key: string, v: number): Attr => ({ key, value: { doubleValue: v } });
const b = (key: string, v: boolean): Attr => ({ key, value: { boolValue: v } });

/** The standard attributes Claude Code puts on every event (identifying ones included). */
const standard = (): Attr[] => [
  s("session.id", "sess-0001"),
  s("prompt.id", "prompt-0001"),
  i("event.sequence", 7),
  s("user.email", "user@example.invalid"),
  s("user.id", "example-user-id"),
  s("user.account_id", "example-account-id"),
  s("user.account_uuid", "example-account-uuid"),
  s("organization.id", "example-org-id"),
  s("terminal.type", "example-terminal"),
  // From OTEL_RESOURCE_ATTRIBUTES.
  s("team.name", "example-team"),
  s("workspace.host_paths", FAKE_CWD),
];

export const T0_NANOS = "1763700000000000000";

export function otelLog(event: string, attrs: Attr[]): Record<string, unknown> {
  return { timeUnixNano: T0_NANOS, body: { stringValue: `claude_code.${event}` }, attributes: [s("event.name", event), ...standard(), ...attrs] };
}

export function otlpBody(logs: Record<string, unknown>[], serviceName = "claude-code"): Record<string, unknown> {
  return {
    resourceLogs: [
      {
        resource: { attributes: [s("service.name", serviceName), s("service.version", "2.1.330"), s("host.name", "example-host"), s("host.arch", "x64"), s("team.name", "example-team")] },
        scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: logs }],
      },
    ],
  };
}

export const OTEL_LOGS = [
  otelLog("api_request", [
    s("model", "claude-haiku-4-5"),
    d("cost_usd", 0.0123),
    i("duration_ms", 900),
    i("ttft_ms", 300),
    i("input_tokens", 10),
    i("output_tokens", 20),
    i("cache_read_tokens", 300),
    i("cache_creation_tokens", 45),
    i("cache_creation_5m_tokens", 40),
    i("cache_creation_1h_tokens", 5),
    s("request_id", "req_0001"),
    s("query_source", "repl_main_thread"),
    s("subscription.type", "example-subscription"),
  ]),
  otelLog("tool_result", [
    s("tool_name", "Bash"),
    s("tool_use_id", "toolu_0002"),
    b("success", true),
    i("duration_ms", 569),
    i("tool_input_size_bytes", 120),
    i("tool_result_size_bytes", 2048),
    s("tool_parameters", '{"bash_command":"cat /home/example-user/.env"}'),
    s("error", "example-user secret text"),
  ]),
  otelLog("subagent_completed", [s("agent_id", "agent-0001"), s("agent_type", "Explore"), i("total_tokens", 900), i("total_tool_uses", 1), s("model", "claude-sonnet-4-5")]),
  otelLog("user_prompt", [i("prompt_length", 34), s("prompt", "fix the failing test of example-user")]),
];

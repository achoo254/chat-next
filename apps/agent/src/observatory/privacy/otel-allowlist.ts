// The OpenTelemetry log attributes Observatory keeps, event by event
// (code.claude.com/docs/en/monitoring-usage). Every other attribute is
// dropped, among them the account's (`user.email`, `user.id`,
// `user.account_id`, `user.account_uuid`, `organization.id`), the machine's
// (`host.*`, `terminal.type`), the repository's (`vcs.*`,
// `workspace.host_paths`), whatever OTEL_RESOURCE_ATTRIBUTES adds, and all
// content (`prompt`, `prompt_text`, `response`, `tool_parameters`,
// `tool_input`, `error`). Resource attributes are never kept at all: only
// `service.name` is read, to accept Claude Code's records.
//
// Events other than these five (user_prompt, assistant_response,
// plugin_loaded, hook_execution_*, …) are dropped whole.

export type OtelRule = "id" | "label" | "number" | "bool";

/** Attributes every kept event keeps. */
export const COMMON_OTEL_FIELDS: Readonly<Record<string, OtelRule>> = {
  "session.id": "id",
  "prompt.id": "id",
  "event.sequence": "number",
  agent_id: "id",
  parent_agent_id: "id",
  request_id: "id",
};

export const OTEL_EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, OtelRule>>>> = {
  api_request: {
    model: "label",
    cost_usd: "number",
    duration_ms: "number",
    ttft_ms: "number",
    input_tokens: "number",
    output_tokens: "number",
    cache_read_tokens: "number",
    cache_creation_tokens: "number",
    cache_creation_5m_tokens: "number",
    cache_creation_1h_tokens: "number",
    query_source: "label",
    speed: "label",
    effort: "label",
  },
  tool_result: {
    tool_name: "label",
    tool_use_id: "id",
    success: "bool",
    duration_ms: "number",
    error_type: "label",
    decision_source: "label",
    tool_input_size_bytes: "number",
    tool_result_size_bytes: "number",
    mcp_server_scope: "label",
  },
  subagent_completed: {
    agent_type: "label",
    is_built_in: "bool",
    is_async: "bool",
    total_tokens: "number",
    total_tool_uses: "number",
    duration_ms: "number",
    model: "label",
    final_model: "label",
    model_swapped: "bool",
  },
  tool_decision: {
    tool_name: "label",
    tool_use_id: "id",
    decision: "label",
    source: "label",
    tool_source: "label",
    classifier_verdict: "label",
  },
  mcp_server_connection: {
    status: "label",
    transport_type: "label",
    server_scope: "label",
    duration_ms: "number",
    error_code: "label",
    is_plugin: "bool",
    server_name: "label",
  },
};

/** The `service.name` of Claude Code's records; any other service's are dropped. */
export const CLAUDE_CODE_SERVICE_NAME = "claude-code";

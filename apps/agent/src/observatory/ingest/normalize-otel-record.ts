// A filtered OpenTelemetry log record as writes on the Observatory tables.
// Pure, like normalize-hook-record.ts. OpenTelemetry brings what the hooks
// do not know: each API call's model, tokens, cost and latency
// (`api_request`), a tool call's exact sizes and outcome (`tool_result`,
// joined to the hook's row by `tool_use_id`), and a subagent's totals and
// model (`subagent_completed`, joined by `agent_id`). It never writes the
// session row: it does not know the session's source or folder.
//
// Session events (session-event-write.ts) come from here too: a call refused
// by a permission decision or blocked by a hook (`tool_decision` rejected;
// a hook's block is a decision whose source is `hook`, and no `tool_result`
// follows it), an API error (its status code, flagged when rate limited),
// an MCP server connecting or disconnecting. A call this source places is
// placed by its tool name alone, flagged `estimated`: the hook's exact
// station replaces it in the store whichever arrives first.
//
// An API call's key is its `request_id`; without one, the event's session,
// prompt, agent, time and `event.sequence` together.
import type { FilteredOtelRecord } from "../privacy/filtered-record.ts";
import { type NormalizedRecord, emptyNormalized } from "./normalized-record.ts";
import { RecordFields } from "./record-fields.ts";
import { knownOtelFields } from "./record-known-fields.ts";
import { sessionEventOp } from "./session-event-write.ts";
import { type ToolClass, classifyTool, isShellTool } from "./tool-classification.ts";

/** The status code of a rate-limited API call. */
const RATE_LIMITED = 429;

/** An API call of the session's main thread (not a subagent's, a compaction's or a title's), by its `query_source`. */
function mainThreadCall(agentId: string | undefined, querySource: string | undefined): boolean {
  return agentId === undefined && (querySource === undefined || querySource === "sdk" || querySource.startsWith("repl_main_thread"));
}

/** A call's class from its name alone; a shell call is placed by its program, which only the hooks have. */
function classOf(toolName: string | undefined): ToolClass | undefined {
  return toolName && !isShellTool(toolName) ? classifyTool(toolName, undefined) : undefined;
}

/** The dedupe key of an API call. */
export function apiRequestKey(f: { sessionId: string; promptId?: string | undefined; agentId?: string | undefined; at: number; sequence?: number | undefined; requestId?: string | undefined }): string {
  if (f.requestId) return `req:${f.requestId}`;
  return `evt:${JSON.stringify([f.sessionId, f.promptId ?? "", f.agentId ?? "", f.at, f.sequence ?? null])}`;
}

/** Cache writes kept for 5 minutes: told apart, or the whole cache write less the 1-hour part (5 minutes is the API's default). */
function cacheWrite5m(r: RecordFields, oneHour: number | undefined): number | undefined {
  const told = r.number("cache_creation_5m_tokens");
  if (told !== undefined) return told;
  const total = r.number("cache_creation_tokens");
  return total === undefined ? undefined : Math.max(0, total - (oneHour ?? 0));
}

/** `record` as writes. */
export function normalizeOtelRecord(record: FilteredOtelRecord): NormalizedRecord {
  const r = new RecordFields(record.f);
  const known = knownOtelFields(record.event);
  const sessionId = r.text("session.id");
  if (!known) return { ...emptyNormalized("unknown-event", sessionId), mistypedFields: r.mistyped };
  const out = emptyNormalized("stored", sessionId);
  const finish = (): NormalizedRecord => ({ ...out, unknownFields: r.unknown(known), mistypedFields: r.mistyped });
  if (!sessionId) {
    out.outcome = "missing-key";
    return finish();
  }
  const at = record.at;
  const promptId = r.text("prompt.id");
  const agentId = r.text("agent_id");
  const durationMs = r.number("duration_ms");
  const start = durationMs !== undefined ? at - durationMs : at;

  const sequence = r.number("event.sequence");

  switch (record.event) {
    case "api_request": {
      const oneHour = r.number("cache_creation_1h_tokens");
      const dedupeKey = apiRequestKey({ sessionId, promptId, agentId, at, sequence, requestId: r.text("request_id") });
      const model = r.text("model");
      const querySource = r.text("query_source");
      if (model && mainThreadCall(agentId, querySource)) out.mainModel = { sessionId, at, value: model };
      out.ops.push({
        kind: "apiRequest",
        row: {
          dedupeKey,
          sessionId,
          promptId,
          agentId,
          at,
          model,
          inputTokens: r.number("input_tokens"),
          outputTokens: r.number("output_tokens"),
          cacheReadTokens: r.number("cache_read_tokens"),
          cacheWrite5mTokens: cacheWrite5m(r, oneHour),
          cacheWrite1hTokens: oneHour,
          costUsd: r.number("cost_usd", false),
          durationMs,
          ttftMs: r.number("ttft_ms"),
          querySource,
        },
      });
      break;
    }
    case "tool_result": {
      const toolUseId = r.text("tool_use_id");
      if (!toolUseId) {
        out.outcome = "missing-key";
        break;
      }
      const toolName = r.text("tool_name");
      const cls = classOf(toolName);
      out.ops.push({
        kind: "toolCall",
        row: {
          toolUseId,
          sessionId,
          promptId,
          agentId,
          at: start,
          toolName,
          mcpServer: cls?.mcpServer,
          station: cls?.station,
          stationFlags: cls?.stationFlags,
          durationMs,
          inputBytes: r.number("tool_input_size_bytes"),
          outputBytes: r.number("tool_result_size_bytes"),
          success: r.flag("success"),
        },
      });
      break;
    }
    case "subagent_completed": {
      if (!agentId) {
        out.outcome = "missing-key";
        break;
      }
      const model = r.text("final_model") ?? r.text("model");
      const row = { sessionId, agentId, promptId, agentType: r.text("agent_type"), startedAt: start, endedAt: at, model, totalTokens: r.number("total_tokens"), toolCount: r.number("total_tool_uses") };
      out.ops.push({ kind: "subagent", row });
      break;
    }
    case "tool_decision": {
      const mode = agentId ? undefined : r.text("permission_mode");
      if (mode) out.permissionMode = { sessionId, at, value: mode };
      if (r.text("decision") !== "reject") {
        out.outcome = "known";
        break;
      }
      const source = r.text("source");
      const toolUseId = r.text("tool_use_id");
      const toolName = r.text("tool_name");
      const kind = source === "hook" ? "hook_block" : "permission_decision";
      // A hook block names the tool; a permission decision names who decided (config, user…).
      const label = kind === "hook_block" ? toolName : source;
      out.ops.push(sessionEventOp(kind, { sessionId, at, agentId, toolUseId, station: classOf(toolName)?.station, label }, toolUseId ? [toolUseId] : [undefined, at, sequence]));
      break;
    }
    case "api_error": {
      const status = r.number("status_code");
      const requestId = r.text("request_id");
      const parts = requestId ? [requestId, r.number("attempt")] : [undefined, undefined, at, sequence];
      out.ops.push(sessionEventOp("api_error", { sessionId, at, agentId, station: "EXTERNAL", label: r.text("model"), number: status, flag: status === RATE_LIMITED }, parts));
      break;
    }
    case "mcp_server_connection": {
      const status = r.text("status");
      // The flag: the connection reported an error code.
      const failed = r.text("error_code") !== undefined;
      out.ops.push(sessionEventOp("mcp_connection", { sessionId, at, station: "MCP", label: status, number: durationMs, flag: failed }, [at, sequence, r.text("server_name"), status]));
      break;
    }
    default:
      out.outcome = "unknown-event";
  }
  return finish();
}

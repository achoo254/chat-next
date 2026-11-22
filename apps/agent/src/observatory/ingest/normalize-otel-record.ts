// A filtered OpenTelemetry log record as writes on the Observatory tables.
// Pure, like normalize-hook-record.ts. OpenTelemetry brings what the hooks
// do not know: each API call's model, tokens, cost and latency
// (`api_request`), a tool call's exact sizes and outcome (`tool_result`,
// joined to the hook's row by `tool_use_id`), and a subagent's totals and
// model (`subagent_completed`, joined by `agent_id`). It never writes the
// session row: it does not know the session's source or folder.
//
// An API call's key is its `request_id`; without one, the event's session,
// prompt, agent, time and `event.sequence` together.
import type { FilteredOtelRecord } from "../privacy/filtered-record.ts";
import { type NormalizedRecord, emptyNormalized } from "./normalized-record.ts";
import { RecordFields } from "./record-fields.ts";
import { knownOtelFields } from "./record-known-fields.ts";
import { classifyTool, isShellTool } from "./tool-classification.ts";

const KNOWN_WITHOUT_TABLE = new Set(["tool_decision", "mcp_server_connection"]);

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

  switch (record.event) {
    case "api_request": {
      const oneHour = r.number("cache_creation_1h_tokens");
      const dedupeKey = apiRequestKey({ sessionId, promptId, agentId, at, sequence: r.number("event.sequence"), requestId: r.text("request_id") });
      out.ops.push({
        kind: "apiRequest",
        row: {
          dedupeKey,
          sessionId,
          promptId,
          agentId,
          at,
          model: r.text("model"),
          inputTokens: r.number("input_tokens"),
          outputTokens: r.number("output_tokens"),
          cacheReadTokens: r.number("cache_read_tokens"),
          cacheWrite5mTokens: cacheWrite5m(r, oneHour),
          cacheWrite1hTokens: oneHour,
          costUsd: r.number("cost_usd", false),
          durationMs,
          ttftMs: r.number("ttft_ms"),
          querySource: r.text("query_source"),
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
      // A shell call is placed by its program, which only the hooks have.
      const cls = toolName && !isShellTool(toolName) ? classifyTool(toolName, undefined) : undefined;
      out.ops.push({
        kind: "toolCall",
        row: {
          toolUseId,
          sessionId,
          promptId,
          agentId,
          at: start,
          toolName,
          officeRoom: cls?.officeRoom,
          mcpServer: cls?.mcpServer,
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
    default:
      out.outcome = KNOWN_WITHOUT_TABLE.has(record.event) ? "known" : "unknown-event";
  }
  return finish();
}

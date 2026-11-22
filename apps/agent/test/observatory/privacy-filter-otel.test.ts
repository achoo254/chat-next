// The OpenTelemetry side of the privacy filter: only Claude Code's records,
// only allowlisted attributes of the five kept events (no account, machine,
// repository or OTEL_RESOURCE_ATTRIBUTES value, no content), one record too
// large dropped alone; and the excerpt's window rule for a secret cut by it.
import { describe, expect, it } from "vitest";
import { MAX_OTEL_RECORD_BYTES, filterOtlpLogs } from "../../src/observatory/privacy/filter-otel-record.ts";
import { COMMON_OTEL_FIELDS, OTEL_EVENT_FIELDS } from "../../src/observatory/privacy/otel-allowlist.ts";
import { excerpt } from "../../src/observatory/privacy/content-excerpt.ts";
import { REDACT_WINDOW_CHARS } from "../../src/observatory/privacy/privacy-text.ts";
import { FAKE_IDENTIFIERS, OTEL_LOGS, otelLog, otlpBody } from "./observatory-payloads.ts";

describe("the OpenTelemetry allowlist", () => {
  it("keeps the kept events with allowlisted attributes only, and no identifying value", () => {
    const out = filterOtlpLogs(otlpBody(OTEL_LOGS), [], 5);
    expect(out.records.map((r) => r.event)).toEqual(["api_request", "tool_result", "subagent_completed"]);
    expect(out.ignored).toBe(1); // user_prompt
    for (const r of out.records) {
      const allowed = new Set([...Object.keys(COMMON_OTEL_FIELDS), ...Object.keys(OTEL_EVENT_FIELDS[r.event] ?? {})]);
      for (const key of Object.keys(r.f)) expect(allowed, `${r.event}.${key}`).toContain(key);
    }
    const text = JSON.stringify(out.records);
    for (const id of FAKE_IDENTIFIERS) expect(text).not.toContain(id);
    for (const key of ["user.email", "organization.id", "host.name", "team.name", "workspace.host_paths", "tool_parameters", "bash_command", "fix the failing test", "\"error\""]) expect(text).not.toContain(key);
  });

  it("reads numbers, flags and the event's time", () => {
    const [api, tool] = filterOtlpLogs(otlpBody(OTEL_LOGS), [], 5).records;
    expect(api?.at).toBe(1_763_700_000_000);
    expect(api?.f).toMatchObject({ "session.id": "sess-0001", "prompt.id": "prompt-0001", "event.sequence": 7, model: "claude-haiku-4-5", cost_usd: 0.0123, input_tokens: 10 });
    expect(api?.f).toMatchObject({ cache_creation_5m_tokens: 40, cache_creation_1h_tokens: 5, request_id: "req_0001" });
    expect(tool?.f).toMatchObject({ tool_name: "Bash", tool_use_id: "toolu_0002", success: true, duration_ms: 569, tool_result_size_bytes: 2048 });
  });

  it("drops and counts records of another service", () => {
    const out = filterOtlpLogs(otlpBody(OTEL_LOGS, "example-app-of-the-user"), [], 5);
    expect(out.records).toEqual([]);
    expect(out.otherService).toBe(OTEL_LOGS.length);
  });

  it("drops a record too large alone, and counts what cannot be read", () => {
    const huge = otelLog("api_request", [{ key: "model", value: { stringValue: "m".repeat(MAX_OTEL_RECORD_BYTES) } }]);
    const out = filterOtlpLogs(otlpBody([huge, ...OTEL_LOGS, { body: { stringValue: "not an event" } }]), [], 5);
    expect(out.tooLarge).toBe(1);
    expect(out.records).toHaveLength(3);
    expect(out.malformed).toBe(1);
    expect(filterOtlpLogs({ nothing: true }, [], 5).malformed).toBe(1);
    expect(filterOtlpLogs("text", [], 5).malformed).toBe(1);
  });

  it("hides known secret values in the labels it keeps", () => {
    const log = otelLog("api_request", [{ key: "model", value: { stringValue: "model-example-known-secret" } }]);
    expect(filterOtlpLogs(otlpBody([log]), ["example-known-secret"], 5).records[0]?.f.model).toBe("model-[hidden]");
  });
});

describe("the excerpt window", () => {
  it("never keeps part of a secret the window cut, even when an earlier one shrank", () => {
    const secret = "example-known-secret-0123456789";
    // A long token early is hidden (shrinks to "[hidden]"), pulling the end of the window toward the excerpt.
    const longToken = `eyJ${"z".repeat(REDACT_WINDOW_CHARS - 200)}`;
    for (const at of [REDACT_WINDOW_CHARS - 10, REDACT_WINDOW_CHARS - 20, REDACT_WINDOW_CHARS - 5]) {
      const filler = "q".repeat(Math.max(0, at - longToken.length - 10));
      const text = `start ${longToken} ${filler}${secret} the rest`.slice(0, at + 40);
      const kept = excerpt(text, [secret]);
      expect(kept).not.toContain("example-known");
      expect(kept).not.toContain("zzzz");
    }
  });
});

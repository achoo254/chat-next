---
name: mcp-sdk-parser-differential
description: Go MCP SDK v1.8 decodes JSON-RPC case-sensitively and ignores trailing data; any stdlib encoding/json pre-parse gate in front of it is bypassable
metadata:
  type: project
---

MCP Go SDK (github.com/modelcontextprotocol/go-sdk v1.8.0) decodes messages with segmentio/encoding + DontMatchCaseInsensitiveStructFields via Decoder.Decode (trailing bytes ignored). Stdlib json.Unmarshal matches keys case-insensitively and errors on trailing data. A gate that pre-parses the body with stdlib (e.g. chatmcp checkToolScope) can be bypassed with `"Name"`/`"Method"` duplicate keys or trailing garbage — PoC confirmed 2026-10-25.

**Why:** chat-next /mcp scope checks lived only in that HTTP pre-check; tool handlers did not re-check scope.

**How to apply:** when reviewing MCP endpoints in *-next repos, require the authoritative scope/permission check inside the tool handler; HTTP-layer pre-parse is UX (step-up 403) only. Also note the SDK calls the getServer factory twice per request.

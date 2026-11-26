import { describe, expect, it } from "vitest";
import { AgentPortKind } from "@achoo254/chat-proto/remote/remote";
import { type RuntimeSources, agentRuntimeBody } from "../src/agent-runtime.ts";

const base: RuntimeSources = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  linkPort: 51000,
  mcpPort: 51001,
  observatory: { port: 4318, listening: true },
  controlPort: 51002,
  tunnels: [],
};

describe("agentRuntimeBody", () => {
  it("lists the service's own ports in a fixed order with its pid and start", () => {
    const body = agentRuntimeBody(base);
    expect(body.pid).toBe(4242);
    expect(body.startedAt).toBe(1_700_000_000_000n);
    expect(body.ports?.map((p) => [p.kind, p.port, p.listening])).toEqual([
      [AgentPortKind.DEVICE_LINK, 51000, true],
      [AgentPortKind.SESSION_MCP, 51001, true],
      [AgentPortKind.OBSERVATORY, 4318, true],
      [AgentPortKind.CONTROL, 51002, true],
    ]);
  });

  it("leaves out what does not listen yet and says when another program holds Observatory's port", () => {
    const body = agentRuntimeBody({ ...base, linkPort: 0, mcpPort: undefined, controlPort: 0, observatory: { port: 4318, listening: false } });
    expect(body.ports).toEqual([{ kind: AgentPortKind.OBSERVATORY, port: 4318, listening: false }]);
  });

  it("lists every port a tunnel publishes, with its URLs only when it has one port", () => {
    const body = agentRuntimeBody({
      ...base,
      linkPort: 0,
      mcpPort: undefined,
      observatory: undefined,
      controlPort: 0,
      tunnels: [
        { id: "a", kind: "http", urls: ["https://a.example"], localPorts: [3000], openedAt: "" },
        { id: "b", kind: "http", urls: ["https://b.example", "https://c.example"], localPorts: [5173, 8080], openedAt: "" },
        { id: "c", kind: "tcp", urls: [], localPorts: [5432], openedAt: "" },
      ],
    });
    expect(body.ports).toEqual([
      { kind: AgentPortKind.TUNNEL_HTTP, port: 3000, listening: true, urls: ["https://a.example"] },
      { kind: AgentPortKind.TUNNEL_HTTP, port: 5173, listening: true, urls: [] },
      { kind: AgentPortKind.TUNNEL_HTTP, port: 8080, listening: true, urls: [] },
      { kind: AgentPortKind.TUNNEL_TCP, port: 5432, listening: true, urls: [] },
    ]);
  });
});

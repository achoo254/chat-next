import { describe, expect, it } from "vitest";
import { AgentPortKind, AgentServiceAction, AgentServiceProblem, AgentServiceState } from "@achoo254/chat-proto/remote/remote";
import { type RuntimeSources, agentRuntimeBody } from "../src/agent-runtime.ts";

const base: RuntimeSources = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  linkPort: 51000,
  mcpPort: 51001,
  observatory: { state: "running", port: 4318 },
  controlPort: 51002,
  tunnels: [],
  restartable: true,
};

const RUNNING = AgentServiceState.RUNNING;

describe("agentRuntimeBody", () => {
  it("lists the service's own ports in a fixed order with its pid, start and what a device may do", () => {
    const body = agentRuntimeBody(base);
    expect(body.pid).toBe(4242);
    expect(body.startedAt).toBe(1_700_000_000_000n);
    expect(body.restartable).toBe(true);
    expect(body.serviceControl).toBe(true);
    expect(body.ports?.map((p) => [p.kind, p.port, p.listening, p.state, p.controls ?? []])).toEqual([
      [AgentPortKind.DEVICE_LINK, 51000, true, RUNNING, []],
      [AgentPortKind.SESSION_MCP, 51001, true, RUNNING, []],
      [AgentPortKind.OBSERVATORY, 4318, true, RUNNING, [AgentServiceAction.STOP, AgentServiceAction.RESTART]],
      [AgentPortKind.CONTROL, 51002, true, RUNNING, []],
    ]);
  });

  it("leaves out what does not listen yet and says when another program holds Observatory's port", () => {
    const body = agentRuntimeBody({ ...base, linkPort: 0, mcpPort: undefined, controlPort: 0, observatory: { state: "port-taken", port: 4318 } });
    expect(body.ports).toEqual([
      {
        kind: AgentPortKind.OBSERVATORY,
        port: 4318,
        listening: false,
        state: AgentServiceState.PORT_TAKEN,
        problem: AgentServiceProblem.UNSPECIFIED,
        controls: [AgentServiceAction.STOP, AgentServiceAction.RESTART],
      },
    ]);
  });

  it("tells why Observatory failed, and that one turned off can only be turned on", () => {
    const failed = agentRuntimeBody({ ...base, observatory: { state: "failed", port: 0, problem: "no-free-port" } });
    const off = agentRuntimeBody({ ...base, observatory: { state: "off", port: 4318 } });
    const obs = (b: typeof failed) => b.ports?.find((p) => p.kind === AgentPortKind.OBSERVATORY);
    expect(obs(failed)).toMatchObject({ port: 0, state: AgentServiceState.FAILED, problem: AgentServiceProblem.NO_FREE_PORT });
    expect(obs(off)).toMatchObject({ state: AgentServiceState.OFF, controls: [AgentServiceAction.START] });
  });

  it("lists every port a tunnel publishes, with its id, a stop, and its URLs only when it has one port", () => {
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
    const tunnel = (kind: AgentPortKind, port: number, tunnelId: string, urls: string[]) => ({ kind, port, listening: true, urls, state: RUNNING, tunnelId, controls: [AgentServiceAction.STOP] });
    expect(body.ports).toEqual([
      tunnel(AgentPortKind.TUNNEL_HTTP, 3000, "a", ["https://a.example"]),
      tunnel(AgentPortKind.TUNNEL_HTTP, 5173, "b", []),
      tunnel(AgentPortKind.TUNNEL_HTTP, 8080, "b", []),
      tunnel(AgentPortKind.TUNNEL_TCP, 5432, "c", []),
    ]);
  });
});

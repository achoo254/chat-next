// The service process as MachineInfo.runtime tells it: its pid, when it
// started, the ports it listens on (all on 127.0.0.1) and the machine's ports
// its `tunelo http` / `tunelo tcp` tunnels publish; each with its state, why
// it does not run, and what a device may do to it (AgentServiceControl).
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  AgentPortKind,
  AgentServiceAction,
  AgentServiceProblem,
  AgentServiceState,
  type AgentPortSchema,
  type AgentRuntimeSchema,
} from "@achoo254/chat-proto/remote/remote";
import type { ObservatoryRuntime } from "./observatory/observatory-switch.ts";
import type { HeldTunnel } from "./tunnels/tunnel-service.ts";

type PortBody = MessageInitShape<typeof AgentPortSchema>;

/** Unix milliseconds this process started. */
export const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export type RuntimeSources = {
  pid: number;
  startedAt: number;
  /** The devices' link; 0 before it listens. */
  linkPort: number;
  /** tunelo's MCP for the sessions; undefined when it is not served. */
  mcpPort: number | undefined;
  /** undefined when this tunelo has no Observatory. */
  observatory: ObservatoryRuntime | undefined;
  /** The local commands' endpoint; 0 before it listens. */
  controlPort: number;
  tunnels: readonly HeldTunnel[];
  /** Something starts tunelo again after it exits (AgentRestart). */
  restartable: boolean;
};

const validPort = (port: number | undefined): port is number => port !== undefined && Number.isInteger(port) && port > 0 && port < 65536;

const OBSERVATORY_STATE: Readonly<Record<ObservatoryRuntime["state"], AgentServiceState>> = {
  running: AgentServiceState.RUNNING,
  off: AgentServiceState.OFF,
  "port-taken": AgentServiceState.PORT_TAKEN,
  failed: AgentServiceState.FAILED,
};

const OBSERVATORY_PROBLEM: Readonly<Record<NonNullable<ObservatoryRuntime["problem"]>, AgentServiceProblem>> = {
  "token-unreadable": AgentServiceProblem.TOKEN_UNREADABLE,
  "no-free-port": AgentServiceProblem.NO_FREE_PORT,
  "store-failed": AgentServiceProblem.STORE_FAILED,
  other: AgentServiceProblem.OTHER,
};

function observatoryPort(o: ObservatoryRuntime): PortBody {
  const state = OBSERVATORY_STATE[o.state];
  return {
    kind: AgentPortKind.OBSERVATORY,
    port: o.port,
    listening: o.state === "running",
    state,
    problem: o.problem === undefined ? AgentServiceProblem.UNSPECIFIED : OBSERVATORY_PROBLEM[o.problem],
    // Off: only turning it on; otherwise it can be turned off or tried again.
    controls: o.state === "off" ? [AgentServiceAction.START] : [AgentServiceAction.STOP, AgentServiceAction.RESTART],
  };
}

export function agentRuntimeBody(s: RuntimeSources): MessageInitShape<typeof AgentRuntimeSchema> {
  const ports: PortBody[] = [];
  // The link, MCP and control endpoint only stop with tunelo: no controls of their own.
  const own = (kind: AgentPortKind, port: number | undefined): void => {
    if (validPort(port)) ports.push({ kind, port, listening: true, state: AgentServiceState.RUNNING });
  };
  own(AgentPortKind.DEVICE_LINK, s.linkPort);
  own(AgentPortKind.SESSION_MCP, s.mcpPort);
  if (s.observatory !== undefined) ports.push(observatoryPort(s.observatory));
  own(AgentPortKind.CONTROL, s.controlPort);
  for (const t of s.tunnels) {
    const kind = t.kind === "http" ? AgentPortKind.TUNNEL_HTTP : AgentPortKind.TUNNEL_TCP;
    // A tunnel of several ports gets its URLs without saying which goes where: they are left out then.
    const urls = t.localPorts.length === 1 ? t.urls : [];
    for (const port of t.localPorts) {
      if (validPort(port)) ports.push({ kind, port, listening: true, urls, state: AgentServiceState.RUNNING, tunnelId: t.id, controls: [AgentServiceAction.STOP] });
    }
  }
  return { pid: s.pid, startedAt: BigInt(s.startedAt), ports, restartable: s.restartable, serviceControl: true };
}

// The service process as MachineInfo.runtime tells it: its pid, when it
// started, the ports it listens on (all on 127.0.0.1) and the machine's ports
// its `tunelo http` / `tunelo tcp` tunnels publish.
import type { MessageInitShape } from "@bufbuild/protobuf";
import { AgentPortKind, type AgentPortSchema, type AgentRuntimeSchema } from "@achoo254/chat-proto/remote/remote";
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
  observatory: { port: number; listening: boolean } | undefined;
  /** The local commands' endpoint; 0 before it listens. */
  controlPort: number;
  tunnels: readonly HeldTunnel[];
};

const validPort = (port: number | undefined): port is number => port !== undefined && Number.isInteger(port) && port > 0 && port < 65536;

export function agentRuntimeBody(s: RuntimeSources): MessageInitShape<typeof AgentRuntimeSchema> {
  const ports: PortBody[] = [];
  const own = (kind: AgentPortKind, port: number | undefined, listening = true): void => {
    if (validPort(port)) ports.push({ kind, port, listening });
  };
  own(AgentPortKind.DEVICE_LINK, s.linkPort);
  own(AgentPortKind.SESSION_MCP, s.mcpPort);
  own(AgentPortKind.OBSERVATORY, s.observatory?.port, s.observatory?.listening);
  own(AgentPortKind.CONTROL, s.controlPort);
  for (const t of s.tunnels) {
    const kind = t.kind === "http" ? AgentPortKind.TUNNEL_HTTP : AgentPortKind.TUNNEL_TCP;
    // A tunnel of several ports gets its URLs without saying which goes where: they are left out then.
    const urls = t.localPorts.length === 1 ? t.urls : [];
    for (const port of t.localPorts) if (validPort(port)) ports.push({ kind, port, listening: true, urls });
  }
  return { pid: s.pid, startedAt: BigInt(s.startedAt), ports };
}

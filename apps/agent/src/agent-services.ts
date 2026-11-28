// tunelo's own services as a device works them from the machine's page:
// restarting tunelo (AgentRestart) and starting, stopping or restarting the
// services that can be (AgentServiceControl): Observatory's receiver, and the
// tunnels `tunelo http` / `tunelo tcp` keep open. The devices' link, tunelo's
// MCP and the control endpoint only stop with tunelo itself.
import { AgentPortKind, AgentServiceAction, ErrorReason } from "@achoo254/chat-proto/remote/remote";

export interface AgentServices {
  /** Something starts tunelo again after it exits (launchd, systemd, the Windows loop). */
  restartable(): boolean;
  /** Exits shortly, for that supervisor to start tunelo again. */
  restart(): void;
  observatory: { setEnabled(on: boolean): Promise<void>; restart(): Promise<void> } | undefined;
  /** Closes a held tunnel and tells its terminal why; false when none has that id. */
  closeTunnel(id: string): boolean;
}

export type ServiceRequest = { kind: AgentPortKind; action: AgentServiceAction; tunnelId: string };

export type ServiceRefusal = { reason: ErrorReason; message: string };

/** Does what the request asks; a refusal says why it did not (nothing was changed then). */
export async function controlService(s: AgentServices, req: ServiceRequest): Promise<ServiceRefusal | undefined> {
  const unsupported: ServiceRefusal = { reason: ErrorReason.UNSUPPORTED_REQUEST, message: "this service cannot be controlled from a device" };
  if (req.kind === AgentPortKind.OBSERVATORY && s.observatory !== undefined) {
    if (req.action === AgentServiceAction.START) return void (await s.observatory.setEnabled(true));
    if (req.action === AgentServiceAction.STOP) return void (await s.observatory.setEnabled(false));
    if (req.action === AgentServiceAction.RESTART) return void (await s.observatory.restart());
    return unsupported;
  }
  if ((req.kind === AgentPortKind.TUNNEL_HTTP || req.kind === AgentPortKind.TUNNEL_TCP) && req.action === AgentServiceAction.STOP) {
    return s.closeTunnel(req.tunnelId) ? undefined : { reason: ErrorReason.ITEM_NOT_FOUND, message: "this tunnel is already closed" };
  }
  return unsupported;
}

/** The consent log's words for a request: the service and what was done. */
export function serviceAuditDetail(req: ServiceRequest): { path: string; detail: string } {
  const kind = AgentPortKind[req.kind]?.toLowerCase() ?? "unknown";
  const action = AgentServiceAction[req.action]?.toLowerCase() ?? "unknown";
  return { path: req.tunnelId === "" ? kind : `${kind}:${req.tunnelId}`, detail: action };
}

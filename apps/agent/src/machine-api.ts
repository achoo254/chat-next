// The three calls the agent makes to the chat server (Connect, JSON):
// register with a one-time install code, heartbeat with the tunnel address,
// and ask for a content-free "needs you" push.
import { arch, hostname, platform } from "node:os";
import { toBase64Url } from "@achoo254/chat-remote-protocol";

export const CHAT_SERVER = process.env.CHAT_AGENT_SERVER ?? "https://chat.hoandat.com";
const BASE = "/machine-api/app.v1.MachineAgentService/";

export class MachineApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, body: unknown, secret?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", "connect-protocol-version": "1" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(new URL(BASE + method, CHAT_SERVER), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new MachineApiError(String(json.code ?? res.status), String(json.message ?? res.statusText));
  return json as T;
}

const std64 = (b: Uint8Array) => toBase64Url(b).replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (toBase64Url(b).length % 4)) % 4);

export function registerMachine(installCode: string, publicKey: Uint8Array, agentVersion: string, name = hostname()) {
  return call<{ machineId: string; machineSecret: string }>("RegisterMachine", {
    installCode,
    name: name.slice(0, 64),
    os: platform(),
    arch: arch(),
    agentVersion,
    publicKey: std64(publicKey),
  });
}

export type HeartbeatReply = { revoked?: boolean; revokedDeviceKeys?: string[]; minAgentVersion?: string };

export function heartbeat(secret: string, body: { tunnelUrl: string; agentVersion: string; claudeVersion: string }) {
  return call<HeartbeatReply>("Heartbeat", body, secret);
}

export function notifyNeedsInput(secret: string, body: { kind: "approval" | "question"; pendingCount: number; sessionId: string }) {
  return call<Record<string, never>>(
    "NotifyNeedsInput",
    { kind: body.kind === "question" ? "NEEDS_INPUT_KIND_QUESTION" : "NEEDS_INPUT_KIND_APPROVAL", pendingCount: Math.min(1000, Math.max(1, body.pendingCount)), sessionId: body.sessionId },
    secret,
  );
}

/** Device keys come back as standard base64 (proto bytes); the config stores base64url. */
export function toUrl64(std: string): string {
  return std.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

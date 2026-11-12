// The calls the agent makes to the chat server (Connect, JSON): register or
// claim the machine with an access token of the owner's account (Chat's
// resource, machines:write), heartbeat with the tunnel address, and ask for
// a content-free "needs you", "new device paired" or "usage hint" push (all
// with the machine secret). No call
// carries a paired device's key, the install secret or the authenticator
// (TOTP) secret: pairing stays end to end between the device and this
// machine.
import { arch, hostname, platform } from "node:os";
import { toBase64Url } from "@achoo254/chat-remote-protocol";

export const CHAT_SERVER = process.env.TUNELO_CHAT_SERVER ?? "https://chat.hoandat.com";
const BASE = "/machine-api/app.v1.MachineAgentService/";

export class MachineApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MachineApiError";
  }

  /** The server's reason, the word before ":" of its message (`chat_account_missing`…). */
  get reason(): string {
    return /^([a-z_]+):/.exec(this.message)?.[1] ?? "";
  }
}

async function call<T>(method: string, body: unknown, bearer?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", "connect-protocol-version": "1" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(new URL(BASE + method, CHAT_SERVER), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    // A proxy's HTML error page: keep the HTTP status.
  }
  if (!res.ok) throw new MachineApiError(String(json.code ?? res.status), String(json.message ?? res.statusText));
  return json as T;
}

const std64 = (b: Uint8Array) => toBase64Url(b).replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (toBase64Url(b).length % 4)) % 4);

/** Adds this machine to the account of `accessToken` (Chat's resource, machines:write). */
export function registerMachine(accessToken: string, publicKey: Uint8Array, agentVersion: string, name = hostname()) {
  return call<{ machineId: string; machineSecret: string }>(
    "RegisterMachine",
    { name: name.slice(0, 64) || "tunelo", os: platform(), arch: arch(), agentVersion, publicKey: std64(publicKey) },
    accessToken,
  );
}

/** Ties a machine added with an install code (before accounts) to the account of `accessToken`. */
export function claimMachine(accessToken: string, machineSecret: string) {
  return call<{ machineId?: string }>("ClaimMachine", { machineSecret }, accessToken);
}

export type HeartbeatReply = { revoked?: boolean; revokedDeviceKeys?: string[]; minAgentVersion?: string; claimed?: boolean; tunnelRefused?: boolean };

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

/** Tells the account's devices that a new device was just paired with this machine; the call names no device. */
export function notifyDevicePaired(secret: string) {
  return call<Record<string, never>>("NotifyNeedsInput", { kind: "NEEDS_INPUT_KIND_DEVICE_PAIRED", pendingCount: 1, sessionId: "" }, secret);
}

/**
 * Asks for a "usage hint" push to the account's devices: a running session
 * went past a usage rule. Content-free like the others: the call names no
 * session, rule or number (the details reach devices over the sealed link).
 * A server without the kind answers invalid_argument.
 */
export function notifyUsageHint(secret: string) {
  return call<Record<string, never>>("NotifyNeedsInput", { kind: "NEEDS_INPUT_KIND_USAGE_HINT", pendingCount: 1, sessionId: "" }, secret);
}

/** Device keys come back as standard base64 (proto bytes); the config stores base64url. */
export function toUrl64(std: string): string {
  return std.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

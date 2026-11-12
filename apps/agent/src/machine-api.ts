// The calls the agent makes to the chat server (Connect, JSON): register the
// machine with an access token of the owner's account (Chat's resource,
// machines:write) and a proof that it holds its key, then, with the machine
// secret, heartbeat with the tunnel address (the answer lists the owner's
// trusted devices), ask for a content-free "needs you" or "usage hint" push,
// and remove the machine from the account (`tunelo logout`).
import { arch, hostname, platform } from "node:os";
import { type KeyPair, proveKeyPossession, toBase64Url } from "@achoo254/chat-remote-protocol";
import type { TrustedDevice } from "./config.ts";

export const CHAT_SERVER = process.env.TUNELO_CHAT_SERVER ?? "https://chat.hoandat.com";
const BASE = "/machine-api/app.v1.MachineAgentService/";
const KEY_LENGTH = 32;

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

/** Proto bytes go as standard base64 in Connect JSON. */
export function toStd64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/** Standard (or URL-safe) base64 of proto bytes; undefined when it is not a string of base64. */
export function fromStd64(text: unknown): Uint8Array | undefined {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return undefined;
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** A JSON int64: protojson writes it as a string, some encoders as a number. */
function int64(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

const malformed = (what: string) => new MachineApiError("invalid_response", `invalid_response: the chat server sent ${what}`);

/**
 * Adds this machine to the account of `accessToken` (Chat's resource,
 * machines:write), proving it holds `key` (GetMachineKeyChallenge, then
 * RegisterMachine). The account's live row with the same key is taken back
 * with a new secret.
 */
export async function registerMachine(accessToken: string, key: KeyPair, agentVersion: string, name = hostname()): Promise<{ machineId: string; machineSecret: string }> {
  const { challenge } = await call<{ challenge?: unknown }>("GetMachineKeyChallenge", {}, accessToken);
  const raw = typeof challenge === "object" && challenge !== null ? (challenge as Record<string, unknown>) : {};
  const serverKey = fromStd64(raw.serverKey);
  const nonce = fromStd64(raw.nonce);
  if (serverKey?.length !== KEY_LENGTH || nonce?.length !== KEY_LENGTH) throw malformed("a malformed key challenge");
  const mac = await proveKeyPossession(key.privateKey, { serverKey, nonce });
  const reg = await call<{ machineId?: unknown; machineSecret?: unknown }>(
    "RegisterMachine",
    {
      name: name.slice(0, 64) || "tunelo",
      os: platform(),
      arch: arch(),
      agentVersion,
      publicKey: toStd64(key.publicKey),
      // The challenge goes back exactly as it came.
      proof: { challenge: raw, mac: toStd64(mac) },
    },
    accessToken,
  );
  if (typeof reg.machineId !== "string" || !reg.machineId || typeof reg.machineSecret !== "string" || !reg.machineSecret) {
    throw malformed("no machine id or secret");
  }
  return { machineId: reg.machineId, machineSecret: reg.machineSecret };
}

export type HeartbeatReply = {
  revoked: boolean;
  minAgentVersion: string;
  tunnelRefused: boolean;
  /** The owner's live device keys (base64url keys, Unix ms); keys that are not 32 bytes are left out. */
  trustedDevices: TrustedDevice[];
};

function trustedDevicesOf(value: unknown): TrustedDevice[] {
  if (!Array.isArray(value)) return [];
  const out: TrustedDevice[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as Record<string, unknown>;
    const key = fromStd64(d.publicKey);
    if (key?.length !== KEY_LENGTH) continue;
    out.push({
      key: toBase64Url(key),
      name: typeof d.name === "string" ? d.name : "",
      platform: typeof d.platform === "string" ? d.platform : "",
      createdAt: int64(d.createdAt) * 1000,
    });
  }
  return out;
}

/** At most this many connected device keys go in one heartbeat. */
export const MAX_CONNECTED_KEYS = 50;

export async function heartbeat(
  secret: string,
  body: { tunnelUrl: string; agentVersion: string; claudeVersion: string; connectedDeviceKeys: Uint8Array[] },
): Promise<HeartbeatReply> {
  const r = await call<Record<string, unknown>>(
    "Heartbeat",
    {
      tunnelUrl: body.tunnelUrl,
      agentVersion: body.agentVersion,
      claudeVersion: body.claudeVersion,
      connectedDeviceKeys: body.connectedDeviceKeys.slice(0, MAX_CONNECTED_KEYS).map(toStd64),
    },
    secret,
  );
  return {
    revoked: r.revoked === true,
    minAgentVersion: typeof r.minAgentVersion === "string" ? r.minAgentVersion : "",
    tunnelRefused: r.tunnelRefused === true,
    trustedDevices: trustedDevicesOf(r.trustedDevices),
  };
}

/** Removes this machine from its owner's account (also fine when it is already removed). */
export function unregisterMachine(secret: string) {
  return call<Record<string, never>>("UnregisterMachine", {}, secret);
}

export function notifyNeedsInput(secret: string, body: { kind: "approval" | "question"; pendingCount: number; sessionId: string }) {
  return call<Record<string, never>>(
    "NotifyNeedsInput",
    { kind: body.kind === "question" ? "NEEDS_INPUT_KIND_QUESTION" : "NEEDS_INPUT_KIND_APPROVAL", pendingCount: Math.min(1000, Math.max(1, body.pendingCount)), sessionId: body.sessionId },
    secret,
  );
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

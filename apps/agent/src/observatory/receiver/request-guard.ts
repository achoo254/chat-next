// What an OTLP request must be before its body is read: no preflight, no
// Origin (a browser page never reaches the receiver, even through DNS
// rebinding: the Host must be exactly 127.0.0.1:<port>), `POST /v1/logs`
// with a JSON body, and the receiver's token as a Bearer value. The token is
// checked last, so a refusal for any other reason says nothing about it.
import type { IncomingMessage } from "node:http";

export const OTLP_LOGS_PATH = "/v1/logs";

export type GuardRefusal = {
  status: number;
  reason: "preflight" | "origin" | "host" | "path" | "method" | "type" | "token";
};

/** undefined when `req` may go on; else the status to answer and why. */
export function refuseOtlpRequest(req: IncomingMessage, port: number, tokenOk: (token: string) => boolean): GuardRefusal | undefined {
  if (req.method === "OPTIONS") return { status: 405, reason: "preflight" };
  if (req.headers.origin !== undefined) return { status: 403, reason: "origin" };
  if (req.headers.host !== `127.0.0.1:${port}`) return { status: 403, reason: "host" };
  if (req.url !== OTLP_LOGS_PATH) return { status: 404, reason: "path" };
  if (req.method !== "POST") return { status: 405, reason: "method" };
  const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { status: 415, reason: "type" };
  const auth = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization ?? ""));
  if (!auth?.[1] || !tokenOk(auth[1])) return { status: 401, reason: "token" };
  return undefined;
}

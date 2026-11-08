// The way in from the user's other devices: a Tunelo "machine" tunnel to the
// local WebSocket server, signed in with the user's own account (device flow
// of the shared IdP). The relay only sees sealed frames.
import { hostname } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  type DeviceAuthorization,
  TunnelAuthError,
  TunnelClient,
  accountTokenFor,
  deviceSignIn,
  fileSessionStore,
  serverIdentity,
} from "@tunelo/client";

export const TUNNEL_SERVER = process.env.CHAT_AGENT_TUNNEL_SERVER ?? "https://tunnel.hoandat.com";

const sessionFile = (dir: string) => join(dir, "tunelo-session.json");

export function isSignedIn(dir: string): boolean {
  return existsSync(sessionFile(dir));
}

/** Device-flow sign-in; `onCode` shows the link and code to the user. */
export async function signIn(dir: string, onCode: (a: DeviceAuthorization) => void): Promise<void> {
  const id = serverIdentity(TUNNEL_SERVER);
  if (!id) throw new Error(`not a Tunelo server: ${TUNNEL_SERVER}`);
  await deviceSignIn({ issuer: id.issuer, store: fileSessionStore(sessionFile(dir)), deviceName: `chat-agent on ${hostname()}`, onCode });
}

/** wss:// address devices connect to, from the tunnel's public https:// URL. */
export function toWebSocketUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/";
  return u.toString();
}

export type TunnelEvents = {
  onUrl: (wssUrl: string, subdomain: string) => void;
  /** The relay refused for good (sign-in expired, quota, held name). */
  onFatal: (code: string, message: string) => void;
  log: (line: string) => void;
};

export function openTunnel(opts: { dir: string; localPort: number; deviceId: string; subdomain?: string }, ev: TunnelEvents): () => void {
  const client = new TunnelClient({
    serverUrl: TUNNEL_SERVER,
    getApiKey: accountTokenFor(fileSessionStore(sessionFile(opts.dir)), TUNNEL_SERVER),
    kind: "machine",
    deviceId: opts.deviceId,
    deviceName: hostname(),
    subdomain: opts.subdomain,
    localPort: opts.localPort,
    localHost: "127.0.0.1",
  });
  client.on("connected", (r: { url?: string; subdomain?: string }) => {
    if (r.url) ev.onUrl(toWebSocketUrl(r.url), r.subdomain ?? "");
  });
  client.on("disconnected", () => ev.log("tunnel disconnected; reconnecting"));
  client.on("error", (err: Error) => {
    if (err instanceof TunnelAuthError && client.listenerCount("error") > 0) ev.onFatal(err.code ?? "TUNNEL", err.message);
    else ev.log(`tunnel error: ${err.message}`);
  });
  client.connect().catch((err: Error) => {
    if (err instanceof TunnelAuthError) ev.onFatal(err.code ?? "TUNNEL", err.message);
    else ev.log(`tunnel: ${err.message}`);
  });
  return () => client.disconnect();
}

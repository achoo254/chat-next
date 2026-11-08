// The way in from the user's other devices: a Tunelo "machine" tunnel to the
// local WebSocket server, signed in with the user's own account (the one
// session of identity/session.ts, from `tunelo login`). The relay only sees
// sealed frames. The same tunnel carries Localman's requests for localhost
// (path `/.tunelo/forward`, tunnels/forward.ts) when its server says it gates
// them (feature `local-forward` of the connection).
import { hostname } from "node:os";
import { type AuthResult, TunnelAuthError, TunnelClient } from "@tunelo/client";
import { accountKeyFor } from "./identity/credentials.ts";
import { identitySession } from "./identity/session.ts";

export const TUNNEL_SERVER = process.env.CHAT_AGENT_TUNNEL_SERVER ?? "https://tunnel.hoandat.com";

export function isSignedIn(dir: string): boolean {
  return identitySession(dir).info() !== undefined;
}

/** wss:// address devices connect to, from the tunnel's public https:// URL. */
export function toWebSocketUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/";
  return u.toString();
}

export type TunnelEvents = {
  /** Connected (again): the devices' address, and the features the server named for this connection. */
  onUrl: (wssUrl: string, subdomain: string, features: readonly string[]) => void;
  /** The connection dropped (it reconnects) or was refused. */
  onDown?: () => void;
  /** The relay refused for good (sign-in expired, quota, held name). */
  onFatal: (code: string, message: string) => void;
  log: (line: string) => void;
};

export function openTunnel(opts: { dir: string; localPort: number; deviceId: string; subdomain?: string }, ev: TunnelEvents): () => void {
  const client = new TunnelClient({
    serverUrl: TUNNEL_SERVER,
    getApiKey: accountKeyFor(TUNNEL_SERVER, opts.dir),
    kind: "machine",
    deviceId: opts.deviceId,
    deviceName: hostname(),
    subdomain: opts.subdomain,
    // Requests go to the device link's local server; the relay is not told
    // that port: the machine tunnel serves no port of the user's own.
    localPort: opts.localPort,
    reportLocalPort: false,
    localHost: "127.0.0.1",
  });
  client.on("connected", (r: AuthResult) => {
    if (r.url) ev.onUrl(toWebSocketUrl(r.url), r.subdomain ?? "", r.features ?? []);
  });
  client.on("disconnected", () => {
    ev.onDown?.();
    ev.log("tunnel disconnected; reconnecting");
  });
  client.on("error", (err: Error) => {
    if (err instanceof TunnelAuthError && client.listenerCount("error") > 0) {
      ev.onDown?.();
      ev.onFatal(err.code ?? "TUNNEL", err.message);
    } else ev.log(`tunnel error: ${err.message}`);
  });
  client.connect().catch((err: Error) => {
    ev.onDown?.();
    if (err instanceof TunnelAuthError) ev.onFatal(err.code ?? "TUNNEL", err.message);
    else ev.log(`tunnel: ${err.message}`);
  });
  return () => client.disconnect();
}

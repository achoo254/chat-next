// Requests an app of the owner (Localman) sends to `localhost:<port>` on
// this machine, through the machine tunnel's path `/.tunelo/forward`. The
// tunnel server lets only a link token the owner made for this machine
// through, drops every `tunelo-*` header the caller sent, and marks what it
// let through with `tunelo-forward-granted: 1` and `tunelo-local-port`.
//
// The machine serves the path only when all of these hold:
// - the tunnel server said, when the tunnel connected, that it gates the
//   path (feature `local-forward`); an older server does not drop the header;
// - the request came through that tunnel: its Host is the tunnel's own host
//   (a web page that points a name of its own at 127.0.0.1 cannot pass);
// - `tunelo-forward-granted` is exactly "1";
// - forwarding is on (`tunelo config local-forward on|off`, or the machine's
//   page in Chat); it is on unless turned off.
// Then it goes to 127.0.0.1:<port>, or [::1]:<port> when nothing answers
// there (an app on `localhost` often listens on ::1 only), never through a
// name lookup, with Host `localhost:<port>`, unless the port is refused
// (forward-deny-ports.ts). A caller that leaves ends the request to the app
// at once.
// `GET /.tunelo/forward/ports` lists what listens on loopback.
//
// Each request is logged (time, port, method, path without the query,
// status), never a header or a body. The app's response loses every
// `tunelo-*` header, so it cannot fake a refusal, and a redirect to its own
// address is turned into a path under the forward path.
import { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse, request } from "node:http";
import { LOCAL_FORWARD, LOCAL_FORWARD_ERRORS, LOCAL_FORWARD_HEADERS, SERVER_FEATURES, isLocalForwardPath, isTuneloHeader, parseLocalPort } from "@tunelo/client";
import type { AuditLog } from "../safety/audit-log.ts";
import { cleanName } from "./listening-ports.ts";
import type { ForwardDenyList } from "./forward-deny-ports.ts";
import type { ForwardSettings } from "./forward-settings.ts";

/** A request body larger than this is refused (the tunnel server's own limit). */
export const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
/** A response is cut off past this. */
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
/** A forward that takes longer is cut off (Localman waits at most this long). */
export const FORWARD_TIMEOUT_MS = 120_000;
/** At most this many ports in `GET …/ports`. */
export const MAX_LISTED_PORTS = 200;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade"]);
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_LOGGED_PATH = 200;
/** Loopback addresses tried in turn, never a name lookup. */
type LoopbackHost = "127.0.0.1" | "::1";
/** Connection errors meaning nothing listens there (or that address family is off). */
const UNREACHABLE = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH", "EAFNOSUPPORT", "EHOSTUNREACH"]);

/** The whole request body; null when it passes `max` (the rest is drained). Rejects when the caller leaves. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) over = true;
      if (!over) chunks.push(chunk);
    });
    req.once("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.once("aborted", () => reject(new Error("the caller left")));
    req.once("error", reject);
  });
}

export type LocalForwardDeps = {
  /** On or off, and the user's refused ports (local-forward.json). */
  settings: ForwardSettings;
  deny: ForwardDenyList;
  audit?: AuditLog;
  log: (line: string) => void;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  now?: () => number;
};

/** Where forwarding stands: what `tunelo` and the machine's page in Chat show. */
export type LocalForwardState = {
  /** Turned on (the default) or off on this machine. */
  enabled: boolean;
  /** The connected tunnel server gates the path: forwarding can work now. */
  available: boolean;
  /** Ports the user refused on this machine, beyond the built-in ones. */
  blockedPorts: number[];
};

/** Path and nothing after it, without control characters, for the log. */
export function loggedPath(path: string): string {
  const cut = path.search(/[?#]/);
  return cleanName(cut === -1 ? path : path.slice(0, cut)).slice(0, MAX_LOGGED_PATH) || "/";
}

/** The path on the app: what follows the forward path ("" is "/", a bare query keeps its "?"). */
export function appPath(url: string): string {
  const rest = url.slice(LOCAL_FORWARD.PATH.length);
  if (rest === "") return "/";
  return rest.startsWith("?") ? `/${rest}` : rest;
}

/**
 * A redirect of the app as the caller must follow it: a path of the app, or
 * an address of the app itself (localhost, 127.0.0.1, [::1] on the forwarded
 * port), becomes the same path under the forward path. Anything else (a
 * relative path, another host or port) is left as it is.
 */
export function rewriteLocation(location: string, port: number): string {
  if (location.startsWith("/") && !location.startsWith("//")) return `${LOCAL_FORWARD.PATH}${location}`;
  let url: URL;
  try {
    url = new URL(location, `http://localhost:${port}`);
  } catch {
    return location;
  }
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith("//");
  if (!absolute || (url.protocol !== "http:" && url.protocol !== "https:")) return location;
  const urlPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!LOOPBACK_NAMES.has(url.hostname.toLowerCase()) || urlPort !== port) return location;
  return `${LOCAL_FORWARD.PATH}${url.pathname}${url.search}${url.hash}`;
}

/** The caller's headers as the app gets them: no `tunelo-*`, no hop-by-hop, Host of the app. */
export function headersForApp(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || isTuneloHeader(lower) || HOP_BY_HOP.has(lower) || named.has(lower) || lower === "host") continue;
    out[lower] = value;
  }
  out.host = `localhost:${port}`;
  return out;
}

/** The app's response headers as the caller gets them: no `tunelo-*`, no hop-by-hop, its redirect kept under the forward path. */
export function headersForCaller(headers: IncomingHttpHeaders, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || isTuneloHeader(lower) || HOP_BY_HOP.has(lower)) continue;
    out[lower] = lower === "location" && typeof value === "string" ? rewriteLocation(value, port) : value;
  }
  return out;
}

function hostnameOf(host: string | undefined): string {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

type Refusal = { status: number; code: string };

const REFUSE = {
  notFound: { status: 404, code: LOCAL_FORWARD_ERRORS.NOT_FOUND },
  blocked: { status: 403, code: LOCAL_FORWARD_ERRORS.PORT_BLOCKED },
  disabled: { status: 403, code: LOCAL_FORWARD_ERRORS.DISABLED },
  badPort: { status: 400, code: LOCAL_FORWARD_ERRORS.BAD_PORT },
  closed: { status: 502, code: LOCAL_FORWARD_ERRORS.PORT_CLOSED },
} as const satisfies Record<string, Refusal>;

const MESSAGES: Record<string, string> = {
  [LOCAL_FORWARD_ERRORS.NOT_FOUND]: "Not found",
  [LOCAL_FORWARD_ERRORS.PORT_BLOCKED]: "This port is not forwarded",
  [LOCAL_FORWARD_ERRORS.DISABLED]: "Forwarding to localhost is turned off on this machine",
  [LOCAL_FORWARD_ERRORS.BAD_PORT]: "Give a port (1-65535) in tunelo-local-port",
  [LOCAL_FORWARD_ERRORS.PORT_CLOSED]: "Nothing answers on this port",
};

function writeJson(res: ServerResponse, status: number, body: unknown, extra: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

export class LocalForward {
  /** Hostname of the connected machine tunnel and whether its server gates the path; undefined while not connected. */
  private tunnel: { host: string; gated: boolean } | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: LocalForwardDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The machine tunnel connected at `publicUrl`, its server naming `features`. */
  tunnelConnected(publicUrl: string, features: readonly string[] | undefined): void {
    const host = URL.canParse(publicUrl) ? new URL(publicUrl).hostname.toLowerCase() : "";
    const gated = host !== "" && (features ?? []).includes(SERVER_FEATURES.LOCAL_FORWARD);
    const was = this.tunnel?.gated === true;
    this.tunnel = { host, gated };
    if (gated !== was) {
      this.deps.log(gated ? `local forward: the tunnel server serves it (${this.enabled() ? "on" : "turned off on this machine"})` : "local forward: this tunnel server does not serve it; nothing is forwarded");
    }
  }

  tunnelDisconnected(): void {
    this.tunnel = undefined;
  }

  enabled(): boolean {
    return this.deps.settings.read().enabled;
  }

  state(): LocalForwardState {
    const s = this.deps.settings.read();
    return { enabled: s.enabled, available: this.tunnel?.gated === true, blockedPorts: s.blockedPorts };
  }

  /** Turns forwarding on or off; `device` is who asked (written to the consent log). */
  async setEnabled(on: boolean, device: string): Promise<LocalForwardState> {
    let changed = false;
    await this.deps.settings.update((s) => {
      changed = s.enabled !== on;
      s.enabled = on;
    });
    if (changed) {
      this.deps.audit?.write({ device, action: "local_forward", path: "", detail: on ? "on" : "off" });
      this.deps.log(`local forward turned ${on ? "on" : "off"} by ${device}`);
    }
    return this.state();
  }

  /** Adds or removes ports the user refuses on this machine. */
  async setBlocked(ports: readonly number[], blocked: boolean, device: string): Promise<LocalForwardState> {
    const valid = ports.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65_535);
    await this.deps.settings.update((s) => {
      const current = new Set(s.blockedPorts);
      for (const p of valid) {
        if (blocked) current.add(p);
        else current.delete(p);
      }
      s.blockedPorts = [...current];
    });
    this.deps.audit?.write({ device, action: "local_forward", path: "", detail: `${blocked ? "block" : "unblock"} ${valid.join(",")}` });
    return this.state();
  }

  /** Serves the request when it is under the forward path; false otherwise. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? "/";
    if (!isLocalForwardPath(url)) return false;
    this.serve(req, res, url).catch((err: unknown) => {
      this.deps.log(`local forward failed: ${(err as Error).message}`);
      if (!res.headersSent) writeJson(res, 500, { error: { code: "INTERNAL", message: "Forward failed" } });
      else res.destroy();
    });
    return true;
  }

  /** Whether a WebSocket upgrade belongs to the forward path (refused: it is not forwarded). */
  static isForwardUpgrade(req: IncomingMessage): boolean {
    return isLocalForwardPath(req.url ?? "/");
  }

  private refuse(req: IncomingMessage, res: ServerResponse, why: Refusal, port: number | null, path: string): void {
    req.resume();
    this.deps.log(`local forward refused ${why.code}: ${req.method ?? "GET"} ${port === null ? "" : `:${port} `}${loggedPath(path)}`);
    writeJson(res, why.status, { error: { code: why.code, message: MESSAGES[why.code] ?? "Forward refused" } }, { [LOCAL_FORWARD_HEADERS.ERROR]: why.code });
  }

  private async serve(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const path = appPath(url);
    const t = this.tunnel;
    // Only what the gating server let through this very tunnel.
    if (!t?.gated || hostnameOf(req.headers.host) !== t.host || req.headers[LOCAL_FORWARD_HEADERS.GRANTED] !== "1") {
      return this.refuse(req, res, REFUSE.notFound, null, path);
    }
    if (!this.enabled()) return this.refuse(req, res, REFUSE.disabled, null, path);
    const rawPort = req.headers[LOCAL_FORWARD_HEADERS.LOCAL_PORT];
    if (rawPort === undefined) {
      if (req.method === "GET" && loggedPath(path) === "/ports") return this.listPorts(req, res);
      return this.refuse(req, res, REFUSE.badPort, null, path);
    }
    const port = parseLocalPort(rawPort);
    if (port === null) return this.refuse(req, res, REFUSE.badPort, null, path);
    if (await this.deps.deny.denies(port)) return this.refuse(req, res, REFUSE.blocked, port, path);
    return this.forward(req, res, port, path);
  }

  private async listPorts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume();
    const snapshot = await this.deps.deny.current();
    const ports: { port: number; name: string }[] = [];
    for (const l of snapshot.listening) {
      if (ports.length >= MAX_LISTED_PORTS) break;
      if (await this.deps.deny.denies(l.port)) continue;
      ports.push({ port: l.port, name: cleanName(l.name) });
    }
    this.deps.log(`local forward: listed ${ports.length} ports`);
    writeJson(res, 200, { ports });
  }

  private async forward(req: IncomingMessage, res: ServerResponse, port: number, path: string): Promise<void> {
    const started = this.now();
    const method = req.method ?? "GET";
    const maxRequest = this.deps.maxRequestBytes ?? MAX_REQUEST_BYTES;
    const maxResponse = this.deps.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    const log = (status: number | string) => this.deps.log(`local forward ${method} :${port} ${loggedPath(path)} → ${status} (${this.now() - started} ms)`);

    // The whole body first: the tunnel client already holds it whole, an
    // oversized one never reaches the app, and a refused 127.0.0.1 can be
    // tried again on ::1 with the same body.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxRequest) {
      req.resume();
      writeJson(res, 413, { error: { code: "TOO_LARGE", message: "The request body is too large" } });
      return log(413);
    }
    let body: Buffer | null;
    try {
      body = await readBody(req, maxRequest);
    } catch {
      if (!res.headersSent) writeJson(res, 400, { error: { code: "BAD_REQUEST", message: "The request broke" } });
      return log("caller left");
    }
    if (body === null) {
      writeJson(res, 413, { error: { code: "TOO_LARGE", message: "The request body is too large" } });
      return log(413);
    }

    let done = false;
    let upstream: ClientRequest | undefined;
    let answer: IncomingMessage | undefined;
    // Bun reports a caller that left on the request and its socket, not on the response.
    const gone = () => {
      if (!done && !res.writableFinished) stop("caller left");
    };
    const resGone = () => gone();
    const stop = (status: number | string) => {
      finish(status);
      upstream?.destroy();
      answer?.destroy();
      if (!res.writableFinished) res.destroy();
    };
    const finish = (status: number | string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.socket?.off("close", gone);
      req.off("aborted", gone);
      res.off("close", resGone);
      log(status);
    };
    const fail = (status: number, payload: unknown, extra: OutgoingHttpHeaders = {}) => {
      if (res.headersSent) return stop(status);
      finish(status);
      upstream?.destroy();
      writeJson(res, status, payload, extra);
    };
    const timer = setTimeout(() => fail(504, { error: { code: "TIMEOUT", message: "The app did not answer in time" } }), this.deps.timeoutMs ?? FORWARD_TIMEOUT_MS);
    timer.unref?.();
    req.socket?.once("close", gone);
    req.once("aborted", gone);
    res.once("close", resGone);
    if (req.socket?.destroyed) return gone();

    const attempt = (host: LoopbackHost) => {
      const sent = request({ host, port, method, path, headers: headersForApp(req.headers, port) }, (got) => {
        answer = got;
        if (done) return got.destroy();
        res.writeHead(got.statusCode ?? 502, headersForCaller(got.headers, port));
        let size = 0;
        got.on("data", (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          if (size > maxResponse) return stop("cut off: response too large");
          if (!res.write(chunk)) {
            got.pause();
            res.once("drain", () => got.resume());
          }
        });
        got.on("end", () => {
          if (done) return;
          res.end();
          finish(got.statusCode ?? 502);
        });
        got.on("error", () => stop("cut off: the app's response broke"));
      });
      upstream = sent;
      sent.on("error", (err: NodeJS.ErrnoException) => {
        if (done) return;
        const refused = err.code !== undefined && UNREACHABLE.has(err.code);
        // An app on `localhost` often listens on ::1 only (macOS, recent Node): the same port there, no name lookup.
        if (refused && host === "127.0.0.1") return attempt("::1");
        if (refused) {
          this.deps.log(`local forward refused ${REFUSE.closed.code}: ${method} :${port} ${loggedPath(path)}`);
          return fail(REFUSE.closed.status, { error: { code: REFUSE.closed.code, message: MESSAGES[REFUSE.closed.code] } }, { [LOCAL_FORWARD_HEADERS.ERROR]: REFUSE.closed.code });
        }
        fail(502, { error: { code: "UPSTREAM", message: "The app closed the connection" } });
      });
      sent.end(body);
    };
    attempt("127.0.0.1");
  }
}

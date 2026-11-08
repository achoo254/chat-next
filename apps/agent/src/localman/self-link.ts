// This machine in Localman: after `tunelo login`, once the machine has its
// tunnel device (`chat-agent.<machineId>`), tunelo asks the tunnel server
// for a link token of this machine (`linkMachineToApp`) and hands it to
// Localman (`POST /tunelo/links/self`, Bearer of the account for Localman).
// Localman keeps the token and sends requests to localhost here with it.
// tunelo keeps no copy: the token lives in one function call.
//
// Localman failing never touches the tunnel or Chat: it only sets
// Localman's state and tries again later (1 minute, doubling up to 1 hour),
// and at once after each `tunelo login`. A machine linked for this account
// and device is not linked again on restart; `tunelo login` links it anew.
import { hostname } from "node:os";
import { SelfLinkError, linkMachineToApp } from "@tunelo/client";
import type { ConfigStore } from "../config.ts";
import { ResourceNotGrantedError, SessionExpiredError, appResources } from "../identity/session.ts";
import { type AppSession, type AppState, retryDelay } from "../registration-status.ts";
import { cleanName } from "../tunnels/listening-ports.ts";
import type { LocalForwardState } from "../tunnels/forward.ts";

/** Name of the app in the machine's list of links on the tunnel server. */
export const LOCALMAN_CLIENT_NAME = "Localman";
const HTTP_TIMEOUT_MS = 15_000;
const LOGIN_HINT = "run `tunelo login`";

export type LocalmanLinkDeps = {
  config: ConfigStore;
  session: AppSession;
  /** The tunnel server the machine tunnel uses. */
  tunnelServer: string;
  /** Localman's origin for the signed-in IdP; by default `https://localman.<domain>`. */
  localmanOrigin?: (issuer: string) => string;
  link?: typeof linkMachineToApp;
  fetch?: typeof fetch;
  /** Where forwarding stands, for the state line. */
  forward?: () => LocalForwardState;
  log: (line: string) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
};

/** Why Localman (or the tunnel server) refused; never carries a token. */
export class LocalmanLinkError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`Localman did not link this machine (${code ?? status ?? "no answer"})`);
    this.name = "LocalmanLinkError";
  }
}

function defaultOrigin(issuer: string): string {
  return new URL(appResources(issuer).localman).origin;
}

function errorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { error, code } = body as { error?: unknown; code?: unknown };
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  if (typeof code === "string") return code;
  return typeof error === "string" ? error : null;
}

/** The machine's name as Localman takes it: 1–100 characters, no control characters. */
export function machineNameFor(name: string): string {
  return cleanName(name) || "machine";
}

/** What a failure means for the person: the state and whether trying again can help. */
function describe(err: unknown): AppState {
  if (err instanceof SelfLinkError) {
    if (err.status === 404) return { status: "waiting", detail: "the tunnel server does not link machines to apps yet" };
    if (err.status === 401 || err.status === 403) return { status: "sign-in", detail: `the tunnel server refused the sign-in; ${LOGIN_HINT}` };
    return { status: "waiting", detail: `could not reach the tunnel server (${err.code ?? err.status ?? "no answer"})` };
  }
  if (err instanceof LocalmanLinkError) {
    if (err.code === "TUNNEL_LINK_LIMIT_REACHED") {
      return { status: "error", detail: "Localman already links 20 machines of this account: remove one in Localman (Settings › Tunelo)" };
    }
    if (err.code === "LINK_OWNER_MISMATCH") return { status: "error", detail: `Localman and the tunnel see different accounts; ${LOGIN_HINT} --force` };
    if (err.status === 401 || err.status === 403) return { status: "sign-in", detail: `Localman refused the sign-in; ${LOGIN_HINT}` };
    if (err.status === null || err.status >= 500) return { status: "waiting", detail: `could not reach Localman (${err.code ?? err.status ?? "no answer"})` };
    return { status: "error", detail: `Localman refused the link (${err.code ?? err.status})` };
  }
  return { status: "waiting", detail: `could not link: ${(err as Error).message}` };
}

export class LocalmanLink {
  private current: AppState = { status: "waiting", detail: "starting" };
  private failures = 0;
  private cancelRetry: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private force = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly deps: LocalmanLinkDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.current = this.stored() ?? this.current;
  }

  /** Localman's line in `tunelo whoami`. */
  state(): AppState {
    const s = { ...this.current };
    if (s.status === "ok") s.detail = `${s.detail}; ${forwardDetail(this.deps.forward?.())}`;
    return s;
  }

  /** Links the machine if it is not linked for this account and device. */
  start(): void {
    void this.run();
  }

  /** After `tunelo login`: link again now, forgetting the backoff. */
  retryNow(): void {
    this.failures = 0;
    this.force = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
  }

  /** The state from what is stored, when nothing needs a call (or none can be made). */
  private stored(): AppState | undefined {
    const { session, config } = this.deps;
    const info = session.info();
    if (!info || !session.covers("localman") || !session.covers("tunnel")) return { status: "sign-in", detail: LOGIN_HINT };
    const c = config.get();
    if (!c.machineId) return { status: "waiting", detail: "links once the machine is in My machines" };
    if (!this.force && c.localman?.sub === info.sub && c.localman.deviceId === deviceIdOf(c.machineId)) return { status: "ok", detail: "linked" };
    return undefined;
  }

  /** One run at a time; a call during a run runs once more after it. */
  private run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.step();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async step(): Promise<void> {
    const stored = this.stored();
    if (stored) {
      this.current = stored;
      return;
    }
    const { config, session } = this.deps;
    const info = session.info();
    const machineId = config.get().machineId;
    if (!info || !machineId) return;
    this.force = false;
    const deviceId = deviceIdOf(machineId);
    try {
      const tunnelToken = await session.getAppToken("tunnel");
      const link = await (this.deps.link ?? linkMachineToApp)({
        serverUrl: this.deps.tunnelServer,
        accessToken: tunnelToken,
        deviceId,
        clientName: LOCALMAN_CLIENT_NAME,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      await this.handOver(info.issuer, link.token, machineId);
      config.update((c) => (c.localman = { sub: info.sub, deviceId, linkedAt: this.now() }));
      this.failures = 0;
      this.current = { status: "ok", detail: "linked" };
      this.deps.log(`localman: linked this machine (link ${link.linkId})`);
    } catch (err) {
      this.failed(err);
    }
  }

  /** `POST /tunelo/links/self` on Localman: the link token goes there and nowhere else. */
  private async handOver(issuer: string, token: string, machineId: string): Promise<void> {
    const accessToken = await this.deps.session.getAppToken("localman");
    const origin = (this.deps.localmanOrigin ?? defaultOrigin)(issuer);
    const machineName = machineNameFor(this.deps.config.get().machineName || hostname());
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(new URL("/tunelo/links/self", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token, machineId, machineName }),
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new LocalmanLinkError(null, null);
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    const body: unknown = await res.json().catch(() => null);
    const challenge = res.headers.get("www-authenticate") ?? "";
    throw new LocalmanLinkError(res.status, errorCode(body) ?? (challenge.includes("insufficient_scope") ? "insufficient_scope" : null));
  }

  private failed(err: unknown): void {
    if (err instanceof SessionExpiredError || err instanceof ResourceNotGrantedError) {
      // Nothing to retry until `tunelo login`, which retries at once.
      this.current = { status: "sign-in", detail: LOGIN_HINT };
      return;
    }
    const state = describe(err);
    this.failures++;
    const delay = retryDelay(this.failures);
    this.current = { ...state, retryAt: this.now() + delay };
    this.deps.log(`localman: ${state.detail}; trying again in ${Math.round(delay / 60_000)} min`);
    this.cancelRetry?.();
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = undefined;
      // A retry after a failure links again even if an earlier link is stored.
      this.force = true;
      void this.run();
    }, delay);
  }
}

/** The tunnel device of a machine in Chat. */
export function deviceIdOf(machineId: string): string {
  return `chat-agent.${machineId}`;
}

/** How forwarding to localhost stands, for Localman's state line. */
export function forwardDetail(state: LocalForwardState | undefined): string {
  if (!state) return "localhost forwarding not started";
  if (!state.enabled) return "localhost forwarding turned off (tunelo config local-forward on)";
  return state.available ? "localhost forwarding on" : "localhost forwarding waits for the tunnel server";
}

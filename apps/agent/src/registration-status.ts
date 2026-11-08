// Where this machine stands with each app of the one sign-in (tunnel, Chat,
// Localman; the Localman link itself is localman/self-link.ts), and the
// machine's place in Chat: after `tunelo login` the
// service adds the machine to the account's "My machines" by itself
// (RegisterMachine), or ties a machine added with an install code before
// accounts to that account (ClaimMachine).
//
// Chat failing never touches the tunnel: an account that has not opened
// Chat yet, a server error or an old binary only set Chat's state and try
// again later, 1 minute after the first failure, doubling up to 1 hour, and
// at once after each `tunelo login`. Nothing here holds a token: the session
// gives one per call.
import type { ConfigStore } from "./config.ts";
import { MachineApiError } from "./machine-api.ts";
import { APPS, type AppName, ResourceNotGrantedError, SessionExpiredError, type SessionInfo } from "./identity/session.ts";

export type AppStatus = "ok" | "waiting" | "sign-in" | "error" | "off";
export type AppState = { status: AppStatus; detail: string; retryAt?: number };
export type AppsReport = Record<AppName, AppState>;

export const RETRY_FIRST_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;

/** Wait before try `failures` + 1: 1 min, 2, 4… up to 1 hour. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

/** What the registration needs of the session: never a refresh token. */
export interface AppSession {
  info(): SessionInfo | undefined;
  covers(app: AppName): boolean;
  getAppToken(app: AppName): Promise<string>;
}

export interface RegistrationDeps {
  config: ConfigStore;
  session: AppSession;
  api: {
    register(accessToken: string, publicKey: Uint8Array, agentVersion: string): Promise<{ machineId: string; machineSecret: string }>;
    claim(accessToken: string, machineSecret: string): Promise<unknown>;
  };
  publicKey: () => Uint8Array;
  agentVersion: string;
  /** The machine just got its id and secret: open its tunnel. */
  onRegistered: () => void;
  /** The machine's link to Localman: its state, and linking again after `tunelo login`. */
  localman?: { state(): AppState; retryNow(): void };
  log: (line: string) => void;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const LOGIN_HINT = "run `tunelo login`";

/** Chat's state from what is stored, when no call to Chat is needed (or possible). */
function storedChatState(config: ConfigStore, session: AppSession): AppState | undefined {
  const c = config.get();
  if (c.machineRemoved) return { status: "off", detail: "removed on the web; add it again from the Chat page (Add this machine)" };
  const registered = Boolean(c.machineId && c.machineSecret);
  if (registered && c.claimed) return { status: "ok", detail: `in My machines (machine ${c.machineId ?? ""})` };
  if (!session.covers("chat")) {
    return {
      status: "sign-in",
      detail: registered
        ? `in My machines; ${LOGIN_HINT} once to tie it to your account`
        : `${LOGIN_HINT} to add this machine to My machines`,
    };
  }
  return undefined;
}

function localmanState(session: AppSession): AppState {
  return session.covers("localman") ? { status: "ok", detail: "signed in" } : { status: "sign-in", detail: LOGIN_HINT };
}

/** The report when the background service is not running: what the files say. */
export function storedReport(config: ConfigStore, session: AppSession): AppsReport {
  const stopped = "the background service is not running (tunelo start)";
  const info = session.info();
  const linked = info !== undefined && session.covers("localman") && config.get().localman?.sub === info.sub;
  return {
    tunnel: info ? { status: "off", detail: stopped } : { status: "sign-in", detail: LOGIN_HINT },
    chat: storedChatState(config, session) ?? { status: "off", detail: `not in My machines yet; ${stopped}` },
    localman: linked ? { status: "off", detail: `linked; ${stopped}` } : localmanState(session),
  };
}

/** Lines of `tunelo whoami`, one per app, labelled with its capitalised name. */
export function describeApps(report: AppsReport, now = Date.now()): string[] {
  return APPS.map((app) => {
    const s = report[app];
    const label = app.charAt(0).toUpperCase() + app.slice(1);
    const retry = s.retryAt !== undefined ? ` (next try in ${Math.max(1, Math.round((s.retryAt - now) / 60_000))} min)` : "";
    return `${label.padEnd(9)} ${s.status.padEnd(8)} ${s.detail}${retry}`;
  });
}

export class Registration {
  private chat: AppState = { status: "waiting", detail: "starting" };
  private tunnel: AppState;
  private failures = 0;
  private cancelRetry: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private refusedTunnel = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly deps: RegistrationDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.chat = storedChatState(deps.config, deps.session) ?? this.chat;
    this.tunnel = deps.session.info()
      ? { status: "waiting", detail: "opens once the machine is in My machines" }
      : { status: "sign-in", detail: LOGIN_HINT };
  }

  report(): AppsReport {
    return { tunnel: { ...this.tunnel }, chat: { ...this.chat }, localman: this.deps.localman?.state() ?? localmanState(this.deps.session) };
  }

  /** The machine tunnel's state, from its events. */
  setTunnel(state: AppState): void {
    this.tunnel = state;
  }

  /** Starts (or restarts) the registration and the Localman link now, forgetting the backoff: after `tunelo login`. */
  retryNow(): void {
    this.deps.localman?.retryNow();
    this.failures = 0;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    void this.run();
  }

  start(): void {
    void this.run();
  }

  /** The server says the machine is not tied to an account (Heartbeat): claim it. */
  claimNeeded(): void {
    if (this.deps.config.get().claimed) {
      this.deps.config.update((c) => (c.claimed = false));
      void this.run();
    } else if (this.chat.status === "ok") {
      void this.run();
    }
  }

  /** The server confirmed the claim (Heartbeat). */
  claimConfirmed(): void {
    if (!this.deps.config.get().claimed) this.deps.config.update((c) => (c.claimed = true));
  }

  /**
   * Whether Chat listed the machine tunnel at the last heartbeat: it lists
   * only the tunnel of the machine's own account (the tunnel keeps running).
   */
  tunnelListed(listed: boolean): void {
    if (!listed) {
      this.refusedTunnel = true;
      this.chat = {
        status: "error",
        detail: "Chat does not list the tunnel: it was opened with another account; run `tunelo login --force` with the machine's account",
      };
    } else if (this.refusedTunnel) {
      this.refusedTunnel = false;
      this.chat = storedChatState(this.deps.config, this.deps.session) ?? this.chat;
    }
  }

  /** The owner removed the machine on the web: never added again until `tunelo install`. */
  removed(): void {
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.deps.config.update((c) => {
      delete c.machineId;
      delete c.machineSecret;
      delete c.claimed;
      c.machineRemoved = true;
    });
    this.chat = storedChatState(this.deps.config, this.deps.session) ?? this.chat;
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
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
    const { config, session, api } = this.deps;
    const stored = storedChatState(config, session);
    if (stored) {
      this.settled(stored);
      return;
    }
    try {
      const token = await session.getAppToken("chat");
      const c = config.get();
      if (c.machineId && c.machineSecret) {
        await api.claim(token, c.machineSecret);
        config.update((x) => (x.claimed = true));
        this.deps.log(`machine ${c.machineId} is now tied to account ${session.info()?.sub ?? ""} in Chat`);
        this.settled({ status: "ok", detail: `in My machines (machine ${c.machineId})` });
        return;
      }
      const reg = await api.register(token, this.deps.publicKey(), this.deps.agentVersion);
      config.update((x) => {
        x.machineId = reg.machineId;
        x.machineSecret = reg.machineSecret;
        x.claimed = true;
      });
      this.deps.log(`added to My machines in Chat (machine ${reg.machineId})`);
      this.settled({ status: "ok", detail: `in My machines (machine ${reg.machineId})` });
      this.deps.onRegistered();
    } catch (err) {
      this.failed(err);
    }
  }

  private settled(state: AppState): void {
    this.failures = 0;
    this.chat = state;
  }

  private failed(err: unknown): void {
    if (err instanceof SessionExpiredError || err instanceof ResourceNotGrantedError) {
      // Nothing to retry until `tunelo login`, which retries at once.
      this.chat = { status: "sign-in", detail: LOGIN_HINT };
      return;
    }
    const reason = err instanceof MachineApiError ? err.reason : "";
    if (reason === "machine_revoked") {
      // Removed on the web while unclaimed: nothing left to claim.
      this.removed();
      return;
    }
    const detail =
      reason === "chat_account_missing"
        ? "waiting: Chat cannot add this account yet (open Chat once, or wait); the machine then appears in My machines"
        : reason === "agent_update_required"
          ? "this tunelo is too old for Chat: run `tunelo update`"
          : reason === "claim_wrong_account"
            ? "the machine belongs to another Chat account: sign in with that account (`tunelo login --force`)"
            : `could not reach Chat: ${(err as Error).message}`;
    this.failures++;
    const delay = retryDelay(this.failures);
    this.chat = { status: reason === "chat_account_missing" ? "waiting" : "error", detail, retryAt: this.now() + delay };
    this.deps.log(`chat: ${detail}; trying again in ${Math.round(delay / 60_000)} min`);
    this.cancelRetry?.();
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = undefined;
      void this.run();
    }, delay);
  }
}

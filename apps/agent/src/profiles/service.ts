// The Claude profiles of this machine, as the service runs them: listing,
// picking the machine's profile (every session moves to it), signing a new account in (from a device
// with a pasted code, or in the terminal on the machine), refusing an account
// that is already there, plan usage, and removal.
//
// Every change runs one at a time (a promise chain), so one sign-in is open
// at a time, a cancel or the 10-minute expiry never lands in the middle of
// keeping a profile, and removal checks, unselects and deletes in one go.
// A folder of an unfinished sign-in carries an "attempt" marker; only such
// folders are ever cleaned up on their own.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RateWindow } from "../providers/types.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { type ClaudeAccount, readAccount, sameAccount, signOut } from "./account.ts";
import { ensureHistoryLink } from "./history-link.ts";
import { PROFILE_ID_RE, assertSafeHome, defaultClaudeHome, makeProfileHome, profileDir, profileHome, profilesRoot } from "./paths.ts";
import { removeTreeSafely } from "./remove.ts";
import { setupProfileHome, syncMachineSettings } from "./setup.ts";
import { type LoginProcess, startLogin, validCode } from "./sign-in.ts";
import { ProfileStore, type ProfileUsage } from "./store.ts";

export type RateLimits = { fiveHour?: RateWindow; sevenDay?: RateWindow };

export type SignInError = "code-rejected" | "duplicate" | "expired" | "cancelled" | "busy" | "sign-in-on-machine" | "failed";

export type SignInOutcome = { ok: true; id: string; email: string; organization: string } | { ok: false; error: SignInError };

export type ProfileView = {
  /** "" for the default profile. */
  id: string;
  email: string;
  organization: string;
  plan: string;
  /** Signed in by claude's last report and not past loginExpiresAt; false: needs to sign in again. */
  signedIn: boolean;
  /** Unix milliseconds; 0 when unknown. */
  loginExpiresAt: number;
  lastUsage?: ProfileUsage;
  createdAt: number;
};

export type ProfileList = { profiles: ProfileView[]; selectedId: string };

/** Another profile with usage left, offered when a session's profile ran out. */
export type ProfileSuggestion = { id: string; email: string; remaining: number };

/** The account folder of a session: none for the default profile. */
export type SessionProfile = { id: string; accountDir?: string };

export type ProfileListener = {
  /** The machine's profile changed (picked, or unselected by a removal): sessions move to it. */
  onSelect?: (id: string) => void;
  /** What devices see of the profiles changed (picked, added, removed, usage read). */
  onChange?: () => void;
};

export type ClaudeProfilesOptions = {
  configDir: string;
  audit: AuditLog;
  findBinary: () => Promise<string | null>;
  /** Plan usage of an account folder (undefined: the default one), without a message. */
  probeUsage: (bin: string, accountDir: string | undefined) => Promise<RateLimits | null>;
  /** The machine's own Claude folder; CLAUDE_CONFIG_DIR or ~/.claude by default. */
  claudeHome?: string;
  /** A session is open with this profile (it may not be removed then). */
  inUse?: (id: string) => boolean;
  /** Usage just read for a profile, for the sessions' status line. */
  onUsage?: (id: string, usage: RateLimits) => void;
  log?: (line: string) => void;
  now?: () => number;
  ttlMs?: number;
  urlTimeoutMs?: number;
  /** A profile's usage is read at most this often; meanwhile the last value answers. */
  usageMinIntervalMs?: number;
  /** How long a profile's sign-in check stands before the list checks again. */
  signInCheckMs?: number;
};

type Attempt = {
  id: string;
  kind: "remote" | "terminal";
  login?: LoginProcess;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const TTL_MS = 10 * 60_000;
const USAGE_MIN_INTERVAL_MS = 30_000;
/** How long a profile's `claude auth status` answer stands before the list asks again. */
const SIGN_IN_CHECK_MS = 5 * 60_000;
/** In a profile folder (beside home) while its sign-in has not finished. */
const ATTEMPT_MARKER = "attempt";

/** Why a profile request was refused; devices word it in the user's language. */
export type ProfileErrorKind = "damaged" | "not-found" | "default-permanent" | "in-use" | "sign-out-failed" | "cli-missing";

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly kind: ProfileErrorKind,
    /** The variable part the kind names (a profile id), when it has one. */
    readonly subject = "",
  ) {
    super(message);
  }
}

export class ClaudeProfiles {
  readonly store: ProfileStore;
  readonly claudeHome: string;
  private attempt: Attempt | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private usageInFlight = new Map<string, Promise<void>>();
  private signInCheck: Promise<void> | undefined;
  /** The default profile's sign-in as list() last saw it; unknown until then. */
  private defaultSignIn: { signedIn: boolean; loginExpiresAt: number } | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private listener: ProfileListener = {};

  constructor(private readonly opts: ClaudeProfilesOptions) {
    this.now = opts.now ?? Date.now;
    this.store = new ProfileStore(opts.configDir, this.now);
    this.claudeHome = opts.claudeHome ?? defaultClaudeHome();
    this.log = opts.log ?? (() => undefined);
    if (this.store.damaged) this.log(`claude profiles: ${this.store.damaged}`);
  }

  /** Who hears about changes (the machine: its sessions and devices); one listener, the last set. */
  listen(listener: ProfileListener): void {
    this.listener = listener;
  }

  /** Runs `fn` after every change queued before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private readable(): void {
    if (this.store.damaged) throw new ProfileError(this.store.damaged, "damaged");
  }

  private home(id: string): string {
    const home = profileHome(this.opts.configDir, id);
    assertSafeHome(this.opts.configDir, home, this.claudeHome);
    return home;
  }

  private async bin(): Promise<string> {
    const bin = await this.opts.findBinary();
    if (!bin) throw new ProfileError("claude is not installed on this machine", "cli-missing");
    return bin;
  }

  /** Folders of sign-ins a crash left unfinished (marked as such): signed out and deleted. Nothing else. */
  cleanLeftovers(): Promise<void> {
    return this.serial(async () => {
      if (this.store.damaged) return;
      let names: string[];
      try {
        names = readdirSync(profilesRoot(this.opts.configDir));
      } catch {
        return;
      }
      const leftovers = names.filter(
        (name) =>
          PROFILE_ID_RE.test(name) &&
          !this.store.find(name) &&
          this.attempt?.id !== name &&
          existsSync(join(profileDir(this.opts.configDir, name), ATTEMPT_MARKER)),
      );
      if (leftovers.length === 0) return;
      const bin = await this.opts.findBinary();
      for (const name of leftovers) {
        try {
          await this.discard(name, bin);
        } catch (err) {
          this.log(`claude profiles: could not remove an unfinished profile folder (${(err as Error).message})`);
        }
      }
    });
  }

  /** The machine's profile ("" for the default one); undefined when profiles.json cannot be read. */
  selectedId(): string | undefined {
    if (this.store.damaged) return undefined;
    return this.store.selected()?.id ?? "";
  }

  /** Who a profile is signed in as, from the last report kept; undefined when unknown. */
  account(id: string): { email: string; organization: string; plan: string } | undefined {
    if (this.store.damaged) return undefined;
    const p = id === "" ? this.store.get().defaultProfile : this.store.find(id);
    if (!p?.email) return undefined;
    return { email: p.email, organization: p.orgName ?? "", plan: p.plan ?? "" };
  }

  /**
   * Every Claude folder of the machine: its own, then each profile's that is
   * safe to read (for the sessions kept there). Only looked up.
   */
  claudeHomes(): string[] {
    const homes = [this.claudeHome];
    if (this.store.damaged) return homes;
    for (const p of this.store.get().profiles) {
      try {
        homes.push(this.home(p.id));
      } catch {
        // an unsafe or odd profile folder is left out
      }
    }
    return homes;
  }

  /** The account folder new sessions would use; only looks it up. */
  selectedAccountDir(): string | undefined {
    this.readable();
    const p = this.store.selected();
    return p ? this.home(p.id) : undefined;
  }

  /**
   * What a session opening now uses: the selected profile, with the
   * machine's settings copied in and its history link checked. Throws when
   * the profiles cannot be read, rather than run on another account.
   */
  sessionProfile(): SessionProfile {
    this.readable();
    const p = this.store.selected();
    if (!p) return { id: "" };
    const home = this.home(p.id);
    syncMachineSettings(home, this.claudeHome);
    try {
      const state = ensureHistoryLink(home, this.claudeHome, (w) => this.log(`claude profiles: ${w}`));
      if (state === "repaired") this.log("claude profiles: the shared prompt history link was made again");
    } catch (err) {
      this.log(`claude profiles: prompt history link not checked (${(err as Error).message})`);
    }
    return { id: p.id, accountDir: home };
  }

  /** Asks claude whether a profile is still signed in, and keeps the answer. No answer keeps the last one. */
  private async checkSignIn(bin: string, id: string): Promise<void> {
    const account = await readAccount(bin, this.home(id));
    if (!account || this.store.damaged || !this.store.find(id)) return;
    const signIn = { loggedIn: account.loggedIn, loginExpiresAt: account.loginExpiresAt, checkedAt: this.now() };
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (p) p.signIn = signIn;
    });
  }

  /** Checks every added profile whose last check is older than the interval; one round at a time. */
  private checkStaleSignIns(bin: string): Promise<void> {
    this.signInCheck ??= (async () => {
      const every = this.opts.signInCheckMs ?? SIGN_IN_CHECK_MS;
      for (const p of this.store.get().profiles) {
        if (p.signIn && this.now() - p.signIn.checkedAt < every) continue;
        await this.checkSignIn(bin, p.id).catch(() => undefined);
      }
    })().finally(() => (this.signInCheck = undefined));
    return this.signInCheck;
  }

  /** Signed in by the last check and not expired; a profile never checked counts as signed in (it was when added). */
  private signedIn(signIn: { loggedIn: boolean; loginExpiresAt: number } | undefined): boolean {
    if (!signIn) return true;
    return signIn.loggedIn && !(signIn.loginExpiresAt > 0 && signIn.loginExpiresAt <= this.now());
  }

  /** The profiles as devices see them; added profiles' sign-ins are checked with claude when their last check is old. */
  async list(): Promise<ProfileList> {
    this.readable();
    const bin = await this.opts.findBinary();
    const account = bin ? await readAccount(bin, undefined) : null;
    if (bin) await this.checkStaleSignIns(bin);
    const known = this.store.get().defaultProfile;
    if (account && (known.email !== account.email || known.orgId !== account.orgId || known.orgName !== account.orgName || known.plan !== account.plan)) {
      this.store.update((x) => {
        x.defaultProfile = { ...x.defaultProfile, email: account.email, orgId: account.orgId, orgName: account.orgName, plan: account.plan };
      });
    }
    this.defaultSignIn = account
      ? { signedIn: this.signedIn(account), loginExpiresAt: account.loggedIn ? account.loginExpiresAt : 0 }
      : { signedIn: false, loginExpiresAt: 0 };
    return this.view();
  }

  /**
   * The profiles from what is kept, without asking claude: for announcing a
   * change to every device. The default profile's sign-in is as list() last
   * saw it (before that: signed in when an account is known).
   */
  view(): ProfileList {
    this.readable();
    const known = this.store.get().defaultProfile;
    const signIn = this.defaultSignIn ?? { signedIn: Boolean(known.email), loginExpiresAt: 0 };
    const def: ProfileView = {
      id: "",
      email: signIn.signedIn ? (known.email ?? "") : "",
      organization: signIn.signedIn ? (known.orgName ?? "") : "",
      plan: signIn.signedIn ? (known.plan ?? "") : "",
      signedIn: signIn.signedIn,
      loginExpiresAt: signIn.loginExpiresAt,
      createdAt: 0,
      ...(known.lastUsage ? { lastUsage: known.lastUsage } : {}),
    };
    const rest = this.store.get().profiles.map(
      (p): ProfileView => ({
        id: p.id,
        email: p.email,
        organization: p.orgName,
        plan: p.plan,
        signedIn: this.signedIn(p.signIn),
        loginExpiresAt: p.signIn?.loginExpiresAt ?? 0,
        createdAt: p.createdAt,
        ...(p.lastUsage ? { lastUsage: p.lastUsage } : {}),
      }),
    );
    return { profiles: [def, ...rest], selectedId: this.store.selected()?.id ?? "" };
  }

  /**
   * Picks the machine's profile; "" for the default one. Every session moves
   * to it (the core restarts idle ones and moves busy ones after their turn),
   * and its usage is read again (within the minimum interval, the last value
   * stands).
   */
  select(id: string, device: string): Promise<void> {
    return this.serial(async () => {
      this.readable();
      const p = id === "" ? null : this.store.find(id);
      if (id !== "" && !p) throw new ProfileError("no such profile", "not-found");
      const changed = (this.store.get().selectedProfileId ?? "") !== id;
      this.store.update((d) => {
        d.selectedProfileId = id === "" ? null : id;
      });
      this.opts.audit.write({ device, action: "profile_select", path: "", detail: p ? p.email : "default" });
      if (changed) this.listener.onSelect?.(id);
      this.listener.onChange?.();
      void this.refreshUsage(id).catch((err: unknown) => this.log(`claude profiles: usage not read after a switch (${(err as Error).message})`));
    });
  }

  /** Records usage a session or a refresh reported for a profile. */
  recordUsage(id: string, usage: RateLimits): void {
    if (this.store.damaged) return;
    const lastUsage: ProfileUsage = { ...usage, updatedAt: this.now() };
    if (id === "") {
      this.store.update((d) => {
        d.defaultProfile = { ...d.defaultProfile, lastUsage };
      });
      return;
    }
    if (!this.store.find(id)) return;
    this.store.update((d) => {
      const p = d.profiles.find((x) => x.id === id);
      if (p) p.lastUsage = lastUsage;
    });
  }

  /**
   * For a session whose profile `exhaustedId` ran out of usage: the signed-in
   * profile with the most usage left (each read again first, within the
   * minimum interval), or undefined when none has room or its usage is unknown.
   */
  async suggestion(exhaustedId: string): Promise<ProfileSuggestion | undefined> {
    if (this.store.damaged) return undefined;
    const others = this.view().profiles.filter((p) => p.id !== exhaustedId && p.signedIn && p.email !== "");
    await Promise.allSettled(others.map((p) => this.refreshUsage(p.id)));
    let best: ProfileSuggestion | undefined;
    for (const p of this.view().profiles) {
      if (p.id === exhaustedId || !p.signedIn || p.email === "" || !p.lastUsage) continue;
      const remaining = usageLeft(p.lastUsage, this.now());
      if (remaining > 0 && (!best || remaining > best.remaining)) best = { id: p.id, email: p.email, remaining };
    }
    return best;
  }

  private lastUsage(id: string): ProfileUsage | undefined {
    return id === "" ? this.store.get().defaultProfile.lastUsage : this.store.find(id)?.lastUsage;
  }

  /**
   * Reads a profile's plan usage now (a short session with no message). One
   * read per profile at a time; within the minimum interval the last value
   * stands and no session opens.
   */
  refreshUsage(id: string): Promise<void> {
    this.readable();
    if (id !== "" && !this.store.find(id)) return Promise.reject(new ProfileError("no such profile", "not-found"));
    const last = this.lastUsage(id);
    if (last && this.now() - last.updatedAt < (this.opts.usageMinIntervalMs ?? USAGE_MIN_INTERVAL_MS)) return Promise.resolve();
    const running = this.usageInFlight.get(id);
    if (running) return running;
    const run = (async () => {
      const bin = await this.bin();
      // A refresh also tells whether the profile is still signed in.
      if (id !== "") await this.checkSignIn(bin, id);
      const usage = await this.opts.probeUsage(bin, id === "" ? undefined : this.home(id));
      if (!usage) return;
      this.recordUsage(id, usage);
      this.opts.onUsage?.(id, usage);
      this.listener.onChange?.();
    })().finally(() => this.usageInFlight.delete(id));
    this.usageInFlight.set(id, run);
    return run;
  }

  // --- signing in ------------------------------------------------------------

  /** Opens a new attempt (ending the one before). Runs inside serial(). */
  private async newAttempt(kind: Attempt["kind"]): Promise<{ id: string; home: string }> {
    this.readable();
    await this.endAttempt(this.attempt?.id ?? "");
    const id = randomUUID();
    const ttl = this.opts.ttlMs ?? TTL_MS;
    const attempt: Attempt = { id, kind, expiresAt: this.now() + ttl, timer: setTimeout(() => void this.cancel(id), ttl) };
    attempt.timer.unref?.();
    this.attempt = attempt;
    try {
      const home = makeProfileHome(this.opts.configDir, id, this.claudeHome);
      writeFileSync(join(profileDir(this.opts.configDir, id), ATTEMPT_MARKER), "", { mode: 0o600 });
      for (const w of setupProfileHome(home, this.claudeHome).warnings) this.log(`claude profiles: ${w}`);
      return { id, home };
    } catch (err) {
      await this.endAttempt(id);
      throw err;
    }
  }

  private current(id: string): Attempt | undefined {
    return this.attempt?.id === id ? this.attempt : undefined;
  }

  /**
   * From a device: starts claude's sign-in and returns its link. When this
   * claude cannot sign in without a terminal, the answer says to do it on the
   * machine (`tunelo claude profiles add`).
   */
  beginRemote(): Promise<{ ok: true; attemptId: string; url: string; expiresAt: number } | { ok: false; error: SignInError }> {
    return this.serial(async () => {
      const bin = await this.bin();
      const { id, home } = await this.newAttempt("remote");
      let login: LoginProcess;
      try {
        login = await startLogin(bin, home, this.opts.urlTimeoutMs);
      } catch {
        await this.endAttempt(id);
        this.log("claude profiles: claude showed no sign-in link; sign in on the machine instead");
        return { ok: false as const, error: "sign-in-on-machine" as const };
      }
      const attempt = this.current(id);
      if (!attempt) {
        await login.kill();
        return { ok: false as const, error: "cancelled" as const };
      }
      attempt.login = login;
      return { ok: true as const, attemptId: id, url: login.url, expiresAt: attempt.expiresAt };
    });
  }

  /** From a device: the code of the sign-in page, straight to claude and then forgotten. */
  submitCode(attemptId: string, code: string): Promise<SignInOutcome> {
    return this.serial(async () => {
      const attempt = this.current(attemptId);
      if (!attempt || attempt.kind !== "remote" || !attempt.login) return { ok: false, error: "expired" };
      const trimmed = code.trim();
      if (!validCode(trimmed)) return { ok: false, error: "code-rejected" };
      const exit = await attempt.login.submit(trimmed);
      if (!this.current(attemptId)) return { ok: false, error: "cancelled" };
      if (exit !== 0) {
        // claude ends the attempt on a wrong code: a new one is needed.
        await this.endAttempt(attemptId);
        return { ok: false, error: "code-rejected" };
      }
      return this.register(attemptId, "remote device");
    });
  }

  /** On the machine: a prepared profile folder for `claude auth login` in the terminal. */
  prepareTerminal(): Promise<{ id: string; home: string }> {
    return this.serial(() => this.newAttempt("terminal"));
  }

  /** On the machine: claude's terminal sign-in finished; keep the profile if it is a new account. */
  finishTerminal(id: string): Promise<SignInOutcome> {
    return this.serial(async () => {
      const attempt = this.current(id);
      if (!attempt || attempt.kind !== "terminal") return { ok: false, error: "expired" };
      return this.register(id, "local");
    });
  }

  /** Ends an attempt: claude stops and the unfinished folder goes. */
  cancel(attemptId: string): Promise<void> {
    return this.serial(() => this.endAttempt(attemptId));
  }

  private async endAttempt(attemptId: string): Promise<void> {
    const attempt = this.current(attemptId);
    if (!attempt) return;
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    await attempt.login?.kill();
    try {
      await this.discard(attempt.id, await this.opts.findBinary());
    } catch (err) {
      this.log(`claude profiles: could not remove an unfinished profile folder (${(err as Error).message})`);
    }
  }

  /** Signs a folder out (when claude is there) and deletes it, links as links. */
  private async discard(id: string, bin: string | null): Promise<void> {
    const home = this.home(id);
    if (bin) await signOut(bin, home).catch(() => false);
    removeTreeSafely(profileDir(this.opts.configDir, id));
  }

  /** Keeps a signed-in attempt as a profile. Runs inside serial(); the attempt is checked after every wait. */
  private async register(id: string, device: string): Promise<SignInOutcome> {
    const bin = await this.opts.findBinary();
    const account: ClaudeAccount | null = bin ? await readAccount(bin, this.home(id)) : null;
    if (!this.current(id)) return { ok: false, error: "cancelled" };
    if (!account?.loggedIn || account.email === "") {
      await this.endAttempt(id);
      return { ok: false, error: "failed" };
    }
    const def = bin ? await readAccount(bin, undefined) : null;
    if (!this.current(id)) return { ok: false, error: "cancelled" };
    const taken = this.store.get().profiles.some((p) => sameAccount(p, account)) || Boolean(def?.loggedIn && sameAccount(def, account));
    if (taken) {
      await this.endAttempt(id);
      return { ok: false, error: "duplicate" };
    }
    const attempt = this.current(id);
    if (!attempt) return { ok: false, error: "cancelled" };
    clearTimeout(attempt.timer);
    this.attempt = undefined;
    // Marker first: a crash between the two leaves a folder nothing cleans by itself, never a kept profile deleted.
    rmSync(join(profileDir(this.opts.configDir, id), ATTEMPT_MARKER), { force: true });
    this.store.update((d) => {
      d.profiles.push({
        id,
        email: account.email,
        orgId: account.orgId,
        orgName: account.orgName,
        plan: account.plan,
        createdAt: this.now(),
        signIn: { loggedIn: true, loginExpiresAt: account.loginExpiresAt, checkedAt: this.now() },
      });
    });
    this.opts.audit.write({ device, action: "profile_add", path: "", detail: account.email });
    this.listener.onChange?.();
    this.log(`claude profiles: added a profile (${id.slice(0, 8)})`);
    return { ok: true, id, email: account.email, organization: account.orgName };
  }

  // --- removing ----------------------------------------------------------------

  /**
   * Signs the profile out and deletes its folder; the shared Claude folder is
   * never touched. Refused while a session runs with it, and when claude
   * cannot sign it out (its stored sign-in would stay behind); `force`
   * (only from the machine's own terminal) deletes anyway.
   */
  remove(id: string, device: string, options: { force?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      this.readable();
      if (id === "") throw new ProfileError("the default profile cannot be removed", "default-permanent");
      const p = this.store.find(id);
      if (!p) throw new ProfileError("no such profile", "not-found");
      if (this.opts.inUse?.(id)) throw new ProfileError("a session is open with this profile; close it first", "in-use");
      // Unselected at once: no new session can open with it while it is signed out.
      const wasSelected = this.store.get().selectedProfileId === id;
      if (wasSelected) {
        this.store.update((d) => {
          d.selectedProfileId = null;
        });
      }
      const bin = await this.opts.findBinary();
      const home = this.home(id);
      const signedOut = bin ? await signOut(bin, home).catch(() => false) : false;
      if (!signedOut && !options.force) {
        if (wasSelected) {
          this.store.update((d) => {
            d.selectedProfileId = id;
          });
        }
        throw new ProfileError(
          `claude could not sign this account out, so nothing was deleted. On the machine, \`tunelo claude profiles remove ${id} --force\` deletes it anyway`,
          "sign-out-failed",
          id,
        );
      }
      if (!signedOut) this.log("claude profiles: removed a profile claude could not sign out (forced)");
      this.store.update((d) => {
        d.profiles = d.profiles.filter((x) => x.id !== id);
      });
      removeTreeSafely(profileDir(this.opts.configDir, id));
      this.opts.audit.write({ device, action: "profile_remove", path: "", detail: options.force && !signedOut ? `${p.email} (forced)` : p.email });
      if (wasSelected) this.listener.onSelect?.("");
      this.listener.onChange?.();
    });
  }

  /** Stops a sign-in in progress (the service is stopping). */
  async stop(): Promise<void> {
    await this.cancel(this.attempt?.id ?? "");
  }
}

/** Percent of usage left by the tighter window; a window past its reset counts as unused. */
export function usageLeft(usage: { fiveHour?: RateWindow | undefined; sevenDay?: RateWindow | undefined }, now: number): number {
  const used = (w?: RateWindow) => (w && !(w.resetsAt > 0 && w.resetsAt <= now) ? w.utilization : 0);
  return Math.max(0, Math.min(100, 100 - Math.max(used(usage.fiveHour), used(usage.sevenDay))));
}

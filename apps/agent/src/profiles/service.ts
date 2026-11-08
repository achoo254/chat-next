// The Claude profiles of this machine, as the service runs them: listing,
// picking the one new sessions use, signing a new account in (from a device
// with a pasted code, or in the terminal on the machine), refusing an account
// that is already there, plan usage, and removal. One sign-in at a time; a
// new one cancels the one before; one left alone ends after 10 minutes.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import type { RateWindow } from "../providers/types.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { type ClaudeAccount, readAccount, sameAccount, signOut } from "./account.ts";
import { ensureHistoryLink } from "./history-link.ts";
import { PROFILE_ID_RE, assertSafeHome, defaultClaudeHome, makeProfileHome, profileDir, profileHome, profilesRoot } from "./paths.ts";
import { removeTreeSafely } from "./remove.ts";
import { setupProfileHome } from "./setup.ts";
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
  signedIn: boolean;
  lastUsage?: ProfileUsage;
  createdAt: number;
};

export type ProfileList = { profiles: ProfileView[]; selectedId: string };

/** The account folder of a session: none for the default profile. */
export type SessionProfile = { id: string; accountDir?: string };

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
};

type Attempt = {
  id: string;
  kind: "remote" | "terminal";
  login?: LoginProcess;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  busy: boolean;
};

const TTL_MS = 10 * 60_000;

export class ProfileError extends Error {}

export class ClaudeProfiles {
  readonly store: ProfileStore;
  readonly claudeHome: string;
  private attempt: Attempt | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ClaudeProfilesOptions) {
    this.store = new ProfileStore(opts.configDir);
    this.claudeHome = opts.claudeHome ?? defaultClaudeHome();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  private home(id: string): string {
    const home = profileHome(this.opts.configDir, id);
    assertSafeHome(this.opts.configDir, home, this.claudeHome);
    return home;
  }

  private async bin(): Promise<string> {
    const bin = await this.opts.findBinary();
    if (!bin) throw new ProfileError("claude is not installed on this machine");
    return bin;
  }

  /** Folders a crash left behind (a sign-in that never finished): signed out and deleted. */
  async cleanLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(profilesRoot(this.opts.configDir));
    } catch {
      return;
    }
    const bin = await this.opts.findBinary();
    for (const name of names) {
      if (!PROFILE_ID_RE.test(name) || this.store.find(name) || this.attempt?.id === name) continue;
      try {
        await this.discard(name, bin);
      } catch (err) {
        this.log(`claude profiles: could not remove an unfinished profile folder (${(err as Error).message})`);
      }
    }
  }

  /** What a new session uses: the selected profile, its history link checked. */
  sessionProfile(): SessionProfile {
    const p = this.store.selected();
    if (!p) return { id: "" };
    const home = this.home(p.id);
    try {
      const state = ensureHistoryLink(home, this.claudeHome, (w) => this.log(`claude profiles: ${w}`));
      if (state === "repaired") this.log("claude profiles: the shared prompt history link was made again");
    } catch (err) {
      this.log(`claude profiles: prompt history link not checked (${(err as Error).message})`);
    }
    return { id: p.id, accountDir: home };
  }

  async list(): Promise<ProfileList> {
    const bin = await this.opts.findBinary();
    const account = bin ? await readAccount(bin, undefined) : null;
    if (account) {
      this.store.update((d) => {
        d.defaultProfile = { ...d.defaultProfile, email: account.email, orgId: account.orgId, orgName: account.orgName, plan: account.plan };
      });
    }
    const d = this.store.get();
    const def: ProfileView = {
      id: "",
      email: account?.loggedIn ? account.email : "",
      organization: account?.loggedIn ? account.orgName : "",
      plan: account?.loggedIn ? account.plan : "",
      signedIn: account?.loggedIn ?? false,
      createdAt: 0,
      ...(d.defaultProfile.lastUsage ? { lastUsage: d.defaultProfile.lastUsage } : {}),
    };
    const rest = d.profiles.map(
      (p): ProfileView => ({
        id: p.id,
        email: p.email,
        organization: p.orgName,
        plan: p.plan,
        signedIn: true,
        createdAt: p.createdAt,
        ...(p.lastUsage ? { lastUsage: p.lastUsage } : {}),
      }),
    );
    return { profiles: [def, ...rest], selectedId: this.store.selected()?.id ?? "" };
  }

  /** Picks the profile of new sessions; "" for the default one. Open sessions keep theirs. */
  select(id: string, device: string): void {
    const p = id === "" ? null : this.store.find(id);
    if (id !== "" && !p) throw new ProfileError("no such profile");
    this.store.update((d) => {
      d.selectedProfileId = id === "" ? null : id;
    });
    this.opts.audit.write({ device, action: "profile_select", path: "", detail: p ? p.email : "default" });
  }

  /** Records usage a session or a refresh reported for a profile. */
  recordUsage(id: string, usage: RateLimits): void {
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

  /** Reads a profile's plan usage now (a short session with no message). */
  async refreshUsage(id: string): Promise<void> {
    if (id !== "" && !this.store.find(id)) throw new ProfileError("no such profile");
    const usage = await this.opts.probeUsage(await this.bin(), id === "" ? undefined : this.home(id));
    if (!usage) return;
    this.recordUsage(id, usage);
    this.opts.onUsage?.(id, usage);
  }

  // --- signing in ------------------------------------------------------------

  private async newAttempt(kind: Attempt["kind"]): Promise<{ id: string; home: string }> {
    await this.cancel(this.attempt?.id ?? "");
    const id = randomUUID();
    const home = makeProfileHome(this.opts.configDir, id, this.claudeHome);
    const ttl = this.opts.ttlMs ?? TTL_MS;
    const attempt: Attempt = {
      id,
      kind,
      expiresAt: this.now() + ttl,
      busy: false,
      timer: setTimeout(() => void this.cancel(id), ttl),
    };
    attempt.timer.unref?.();
    this.attempt = attempt;
    try {
      for (const w of setupProfileHome(home, this.claudeHome).warnings) this.log(`claude profiles: ${w}`);
    } catch (err) {
      await this.cancel(id);
      throw err;
    }
    return { id, home };
  }

  /**
   * From a device: starts claude's sign-in and returns its link. When this
   * claude cannot sign in without a terminal, the answer says to do it on the
   * machine (`tunelo claude profiles add`).
   */
  async beginRemote(): Promise<{ ok: true; attemptId: string; url: string; expiresAt: number } | { ok: false; error: SignInError }> {
    const bin = await this.bin();
    const { id, home } = await this.newAttempt("remote");
    try {
      const login = await startLogin(bin, home, this.opts.urlTimeoutMs);
      const attempt = this.attempt;
      if (attempt?.id !== id) {
        login.kill();
        return { ok: false, error: "cancelled" };
      }
      attempt.login = login;
      return { ok: true, attemptId: id, url: login.url, expiresAt: attempt.expiresAt };
    } catch {
      await this.cancel(id);
      this.log("claude profiles: claude showed no sign-in link; sign in on the machine instead");
      return { ok: false, error: "sign-in-on-machine" };
    }
  }

  /** From a device: the code of the sign-in page, straight to claude and then forgotten. */
  async submitCode(attemptId: string, code: string): Promise<SignInOutcome> {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId || attempt.kind !== "remote" || !attempt.login) return { ok: false, error: "expired" };
    if (attempt.busy) return { ok: false, error: "busy" };
    const trimmed = code.trim();
    if (!validCode(trimmed)) return { ok: false, error: "code-rejected" };
    attempt.busy = true;
    const exit = await attempt.login.submit(trimmed);
    if (this.attempt?.id !== attemptId) return { ok: false, error: "cancelled" };
    if (exit !== 0) {
      // claude ends the attempt on a wrong code: a new one is needed.
      await this.cancel(attemptId);
      return { ok: false, error: "code-rejected" };
    }
    return this.register(attemptId, "remote device");
  }

  /** On the machine: a prepared profile folder for `claude auth login` in the terminal. */
  async prepareTerminal(): Promise<{ id: string; home: string }> {
    return this.newAttempt("terminal");
  }

  /** On the machine: claude's terminal sign-in finished; keep the profile if it is a new account. */
  async finishTerminal(id: string): Promise<SignInOutcome> {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== id || attempt.kind !== "terminal") return { ok: false, error: "expired" };
    if (attempt.busy) return { ok: false, error: "busy" };
    attempt.busy = true;
    return this.register(id, "local");
  }

  /** Ends an attempt: claude stops and the unfinished folder goes. */
  async cancel(attemptId: string): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId) return;
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    attempt.login?.kill();
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

  private async register(id: string, device: string): Promise<SignInOutcome> {
    const bin = await this.opts.findBinary();
    const account: ClaudeAccount | null = bin ? await readAccount(bin, this.home(id)) : null;
    if (!account?.loggedIn || account.email === "") {
      await this.cancel(id);
      return { ok: false, error: "failed" };
    }
    const def = bin ? await readAccount(bin, undefined) : null;
    const taken = this.store.get().profiles.some((p) => sameAccount(p, account)) || Boolean(def?.loggedIn && sameAccount(def, account));
    if (taken) {
      await this.cancel(id);
      return { ok: false, error: "duplicate" };
    }
    const attempt = this.attempt;
    if (attempt?.id === id) {
      clearTimeout(attempt.timer);
      this.attempt = undefined;
    }
    this.store.update((d) => {
      d.profiles.push({ id, email: account.email, orgId: account.orgId, orgName: account.orgName, plan: account.plan, createdAt: this.now() });
    });
    this.opts.audit.write({ device, action: "profile_add", path: "", detail: account.email });
    this.log(`claude profiles: added a profile (${id.slice(0, 8)})`);
    return { ok: true, id, email: account.email, organization: account.orgName };
  }

  // --- removing ----------------------------------------------------------------

  /** Signs the profile out and deletes its folder; the shared Claude folder is never touched. */
  async remove(id: string, device: string): Promise<void> {
    if (id === "") throw new ProfileError("the default profile cannot be removed");
    const p = this.store.find(id);
    if (!p) throw new ProfileError("no such profile");
    if (this.opts.inUse?.(id)) throw new ProfileError("a session is open with this profile; close it first");
    const bin = await this.opts.findBinary();
    const home = this.home(id);
    if (bin && !(await signOut(bin, home).catch(() => false))) this.log("claude profiles: claude did not confirm the sign-out; deleting the folder anyway");
    this.store.update((d) => {
      d.profiles = d.profiles.filter((x) => x.id !== id);
      if (d.selectedProfileId === id) d.selectedProfileId = null;
    });
    removeTreeSafely(profileDir(this.opts.configDir, id));
    this.opts.audit.write({ device, action: "profile_remove", path: "", detail: p.email });
  }

  /** Stops a sign-in in progress (the service is stopping). */
  async stop(): Promise<void> {
    await this.cancel(this.attempt?.id ?? "");
  }
}

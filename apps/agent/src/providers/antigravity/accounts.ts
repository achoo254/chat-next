// Several Google accounts of agy on one machine. agy keeps one sign-in for
// the whole user (its Keychain item), so a switch writes the saved sign-in of
// the picked account there; every agy then runs as it. The row with id "" is
// whoever agy is signed in as now.
//
// Saved sign-ins live in vault.json (0600) under ai-accounts/antigravity,
// each sealed with this user's key (keystore.ts); ai-accounts.json keeps who
// each account is. Every change runs one at a time. Before each, reconcile()
// reads the sign-in now and keeps it with the saved account of the same
// email (agy refreshes its token on its own). A switch is refused while any
// agy runs (a turn of tunelo's, or agy in a terminal: it would write its own
// sign-in back); tunelo's idle sessions close and open again on the new one.
// The sign-in before a switch is saved first (no switch when that fails),
// and the Keychain is read back after writing; a wrong read puts the old one
// back. Credentials are never logged and never leave the machine.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AccountError } from "../../accounts/errors.ts";
import { providerAccountsRoot } from "../../accounts/paths.ts";
import type { AccountsStore } from "../../accounts/store.ts";
import { seal, unseal } from "../../keystore.ts";
import type { AuditLog } from "../../safety/audit-log.ts";
import type { AccountScopeRef, AccountsFacet, AccountsListener, AccountsView, AiAccountInfo, AccountInfo, ProviderInfo } from "../types.ts";
import { ANTIGRAVITY_PROVIDER_ID } from "./agy.ts";
import { type AgyKeychain, KeychainError, emailOf } from "./keychain.ts";

const run = promisify(execFile);

/** Largest saved sign-in, and largest vault. */
const MAX_CREDENTIAL = 64 * 1024;
const MAX_VAULT = 4 * 1024 * 1024;

const vaultSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(z.object({ id: z.string(), email: z.string(), sealed: z.string(), updatedAt: z.number() })).default([]),
});
type Vault = z.infer<typeof vaultSchema>;

const usageSchema = z.object({
  fiveHour: z.object({ utilization: z.number(), resetsAt: z.number() }).optional(),
  sevenDay: z.object({ utilization: z.number(), resetsAt: z.number() }).optional(),
  updatedAt: z.number(),
});

export type AgyAccountsOptions = {
  configDir: string;
  store: AccountsStore;
  audit: AuditLog;
  keychain: AgyKeychain;
  /** Turns of tunelo's Antigravity sessions running now, by title. */
  busySessions: () => string[];
  /** Stops tunelo's agy process (its idle sessions open again with their next message). */
  stopAgy: () => Promise<void>;
  /** Other agy processes of the user running now (a terminal), by pid. */
  runningAgy?: () => Promise<number[]>;
  /** agy's plan usage of the sign-in now; null when it cannot tell. */
  probeUsage?: () => Promise<NonNullable<ProviderInfo["rateLimits"]> | null>;
  onUsage?: (id: string, usage: NonNullable<ProviderInfo["rateLimits"]>) => void;
  log: (line: string) => void;
  now?: () => number;
};

async function pgrepAgy(): Promise<number[]> {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-x", "agy"], { timeout: 5_000 });
    return stdout.split("\n").flatMap((l) => (/^\d+$/.test(l.trim()) ? [Number(l.trim())] : []));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

export class AgyAccounts implements AccountsFacet {
  private queue: Promise<unknown> = Promise.resolve();
  private listener: AccountsListener = {};
  /** The email agy is signed in as, as the last reconcile saw it; "" when none or unknown. */
  private currentEmail = "";
  private readonly now: () => number;

  constructor(private readonly opts: AgyAccountsOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get vaultFile(): string {
    return join(providerAccountsRoot(this.opts.configDir, ANTIGRAVITY_PROVIDER_ID), "vault.json");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private readable(): void {
    if (this.opts.store.damaged) throw new AccountError(this.opts.store.damaged, "damaged");
  }

  private readVault(): Vault {
    let raw: string;
    try {
      raw = readFileSync(this.vaultFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw new AccountError(`${this.vaultFile} could not be read`, "damaged");
    }
    const parsed = vaultSchema.safeParse((() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    })());
    if (!parsed.success) throw new AccountError(`${this.vaultFile} is damaged; repair or remove it`, "damaged");
    return parsed.data;
  }

  private writeVault(v: Vault): void {
    const text = JSON.stringify(v);
    if (text.length > MAX_VAULT) throw new AccountError("too many saved Antigravity sign-ins", "damaged");
    mkdirSync(providerAccountsRoot(this.opts.configDir, ANTIGRAVITY_PROVIDER_ID), { recursive: true, mode: 0o700 });
    const tmp = `${this.vaultFile}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.vaultFile);
  }

  private saved(): { id: string; email: string; createdAt: number; providerData: Record<string, unknown> }[] {
    return this.opts.store.get().accounts.filter((a) => a.provider === ANTIGRAVITY_PROVIDER_ID);
  }

  private async readKeychain(): Promise<string | undefined> {
    try {
      return await this.opts.keychain.read();
    } catch (err) {
      throw new AccountError((err as Error).message, "switch-blocked", err instanceof KeychainError ? err.kind : "keychain");
    }
  }

  /** Keeps the sign-in now with the saved account of its email; returns that email ("" when none). Runs inside serial(). */
  private async reconcile(): Promise<{ value: string | undefined; email: string }> {
    const value = await this.readKeychain();
    const email = value ? (emailOf(value) ?? "") : "";
    this.currentEmail = email;
    const account = email ? this.saved().find((a) => a.email === email) : undefined;
    if (value && account && value.length <= MAX_CREDENTIAL) {
      const v = this.readVault();
      const entry = v.entries.find((e) => e.id === account.id);
      const same = entry ? (await unseal(this.opts.configDir, entry.sealed).catch(() => "")) === value : false;
      if (!same) {
        const sealed = await seal(this.opts.configDir, value);
        v.entries = [...v.entries.filter((e) => e.id !== account.id), { id: account.id, email, sealed, updatedAt: this.now() }];
        this.writeVault(v);
      }
    }
    const pick = account?.id ?? "";
    if ((this.opts.store.get().selected[ANTIGRAVITY_PROVIDER_ID] ?? "") !== pick) {
      this.opts.store.update((d) => {
        d.selected[ANTIGRAVITY_PROVIDER_ID] = pick;
      });
    }
    return { value, email };
  }

  /** Saves the sign-in now as an account (a new one, or the one of its email). Runs inside serial(). */
  private async keep(value: string, email: string, device: string): Promise<string> {
    if (value.length > MAX_CREDENTIAL) throw new AccountError("agy's sign-in is too long to save", "switch-blocked");
    const known = this.saved().find((a) => a.email === email);
    const id = known?.id ?? randomUUID();
    const v = this.readVault();
    v.entries = [...v.entries.filter((e) => e.id !== id), { id, email, sealed: await seal(this.opts.configDir, value), updatedAt: this.now() }];
    this.writeVault(v);
    if (!known) {
      this.opts.store.update((d) => {
        d.accounts.push({ provider: ANTIGRAVITY_PROVIDER_ID, id, label: "", email, organization: "", plan: "", createdAt: this.now(), providerData: {} });
        d.selected[ANTIGRAVITY_PROVIDER_ID] = id;
      });
      this.opts.audit.write({ device, action: "profile_add", path: "", detail: `${ANTIGRAVITY_PROVIDER_ID} ${email}` });
    }
    return id;
  }

  listen(listener: AccountsListener): void {
    this.listener = listener;
  }

  list(): Promise<AccountsView> {
    return this.serial(async () => {
      this.readable();
      await this.reconcile().catch((err: unknown) => this.opts.log(`antigravity accounts: sign-in not read (${(err as Error).message})`));
      return this.view();
    });
  }

  view(): AccountsView {
    this.readable();
    const selectedId = this.opts.store.get().selected[ANTIGRAVITY_PROVIDER_ID] ?? "";
    const usageOf = (data: Record<string, unknown>) => {
      const u = usageSchema.safeParse(data.lastUsage);
      return u.success ? { usage: u.data } : {};
    };
    const own: AiAccountInfo = { id: "", label: "", email: this.currentEmail, organization: "", plan: "", status: this.currentEmail ? "ok" : "needs-sign-in", createdAt: 0, loginExpiresAt: 0 };
    const rest = this.saved().map(
      (a): AiAccountInfo => ({ id: a.id, label: "", email: a.email, organization: "", plan: "", status: "ok", createdAt: a.createdAt, loginExpiresAt: 0, ...usageOf(a.providerData) }),
    );
    return { accounts: [own, ...rest], selectedId };
  }

  selectedId(): string | undefined {
    if (this.opts.store.damaged) return undefined;
    return this.opts.store.get().selected[ANTIGRAVITY_PROVIDER_ID] ?? "";
  }

  /** agy's sign-in is the machine's, not a folder: sessions take no account scope. */
  selectedScope(): AccountScopeRef | undefined {
    this.readable();
    return undefined;
  }

  sessionAccount(): { id: string } {
    this.readable();
    return { id: this.selectedId() ?? "" };
  }

  account(id: string): AccountInfo | undefined {
    const email = id === "" ? this.currentEmail : this.saved().find((a) => a.id === id)?.email;
    return email ? { email, organization: "", plan: "" } : undefined;
  }

  recordUsage(id: string, usage: NonNullable<ProviderInfo["rateLimits"]>): void {
    if (this.opts.store.damaged || id === "" || !this.saved().some((a) => a.id === id)) return;
    this.opts.store.update((d) => {
      const a = d.accounts.find((x) => x.provider === ANTIGRAVITY_PROVIDER_ID && x.id === id);
      if (a) a.providerData = { ...a.providerData, lastUsage: { ...usage, updatedAt: this.now() } };
    });
  }

  async suggestion(): Promise<undefined> {
    // Another account's usage is only known after switching to it.
    return undefined;
  }

  captureCurrent(device: string): Promise<void> {
    return this.serial(async () => {
      this.readable();
      const { value, email } = await this.reconcile();
      if (!value || !email) throw new AccountError("agy is not signed in on this machine: sign in with agy first", "not-found");
      await this.keep(value, email, device);
      this.listener.onChange?.();
    });
  }

  select(id: string, device: string): Promise<void> {
    return this.serial(async () => {
      this.readable();
      if (id === "") return; // whoever agy is signed in as: nothing to write
      const target = this.saved().find((a) => a.id === id);
      if (!target) throw new AccountError("no such account", "not-found");
      const busy = this.opts.busySessions();
      if (busy.length > 0) throw new AccountError("an Antigravity turn is running; switch once it ends", "switch-blocked", busy[0]?.slice(0, 100) ?? "");
      const before = await this.reconcile();
      if (before.email === target.email) return;
      const entry = this.readVault().entries.find((e) => e.id === id);
      if (!entry) throw new AccountError("this account's sign-in is not saved; sign in with agy and save it again", "not-found");
      const value = await unseal(this.opts.configDir, entry.sealed);
      // tunelo's own agy goes first; any agy left is the user's own.
      await this.opts.stopAgy();
      const others = await (this.opts.runningAgy ?? pgrepAgy)();
      if (others.length > 0) throw new AccountError("agy is running on the machine (a terminal); close it, then switch", "switch-blocked", `agy pid ${others[0]}`);
      // The sign-in now is saved before it is replaced; without that, no switch.
      if (before.value && before.email) await this.keep(before.value, before.email, device);
      else if (before.value) throw new AccountError("agy's current sign-in is not one tunelo can save; nothing was switched", "switch-blocked");
      try {
        await this.opts.keychain.write(value);
        const back = await this.opts.keychain.read();
        if (back === undefined || emailOf(back) !== target.email) throw new KeychainError("failed");
      } catch (err) {
        if (before.value) await this.opts.keychain.write(before.value).catch(() => this.opts.log("antigravity accounts: the sign-in before the switch could not be put back"));
        throw new AccountError((err as Error).message, "switch-blocked", err instanceof KeychainError ? err.kind : "keychain");
      }
      this.currentEmail = target.email;
      this.opts.store.update((d) => {
        d.selected[ANTIGRAVITY_PROVIDER_ID] = id;
      });
      this.opts.audit.write({ device, action: "profile_select", path: "", detail: `${ANTIGRAVITY_PROVIDER_ID} ${target.email}` });
      this.listener.onSelect?.(id);
      this.listener.onChange?.();
    });
  }

  remove(id: string, device: string): Promise<void> {
    return this.serial(async () => {
      this.readable();
      if (id === "") throw new AccountError("agy's own sign-in cannot be removed here", "default-permanent");
      const target = this.saved().find((a) => a.id === id);
      if (!target) throw new AccountError("no such account", "not-found");
      await this.reconcile().catch(() => undefined);
      if (this.currentEmail === target.email) throw new AccountError("agy is signed in as this account now; switch first", "in-use", id);
      const v = this.readVault();
      v.entries = v.entries.filter((e) => e.id !== id);
      this.writeVault(v);
      this.opts.store.update((d) => {
        d.accounts = d.accounts.filter((a) => !(a.provider === ANTIGRAVITY_PROVIDER_ID && a.id === id));
      });
      this.opts.audit.write({ device, action: "profile_remove", path: "", detail: `${ANTIGRAVITY_PROVIDER_ID} ${target.email}` });
      this.listener.onChange?.();
    });
  }

  /** Usage can be read only for the account agy is signed in as now. */
  refreshUsage(id: string): Promise<void> {
    return this.serial(async () => {
      this.readable();
      const { email } = await this.reconcile();
      const current = this.saved().find((a) => a.email === email)?.id ?? "";
      if (id !== current || !this.opts.probeUsage) return;
      const usage = await this.opts.probeUsage();
      if (!usage) return;
      this.recordUsage(id, usage);
      this.opts.onUsage?.(id, usage);
      this.listener.onChange?.();
    });
  }
}

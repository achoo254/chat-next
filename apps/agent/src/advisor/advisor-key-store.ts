// Advisor's TypeSafe key on the machine: one value in `advisor-secrets.json`
// of tunelo's config folder (0600), sealed with the user's key store like the
// sign-in secrets, by a SecretStore of its own. It is kept apart from those on
// purpose: request_secret and the environment of a session's commands
// (SecretService) only ever read `secrets.json`, so no AI session can ask for
// this key or get it in a command. Only tunelo itself opens it, to ask
// TypeSafe for Advisor.
//
// The key never leaves in clear: it is hidden from every output of this
// process from the moment it arrives (rememberSecret), every refusal is a
// fixed message, and devices only ever get its fingerprint.
import { createHash } from "node:crypto";
import { redact, rememberSecret } from "../mcp/redact.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { MAX_SECRET_CHARS } from "../sign-in-secrets/secret-names.ts";
import { type SavedSecretInfo, SecretStore } from "../sign-in-secrets/secret-store.ts";

/** The file of Advisor's store in tunelo's config folder. */
export const ADVISOR_SECRETS_FILE = "advisor-secrets.json";
/** The site the key is for. */
export const ADVISOR_KEY_ORIGIN = "https://api.typesafe.ai";
/** The name the key is kept under. */
const KEY_NAME = "TYPESAFE_API_KEY";
/**
 * Shortest key accepted. Real TypeSafe keys are about 108 letters, digits and
 * "_"; anything shorter is a typo or a wrong paste, refused without being
 * hidden from the process's output (hiding a short word like "test" would
 * blank it out everywhere until a restart).
 */
export const MIN_KEY_CHARS = 32;
/** Characters of the SHA-256 (hex) shown for a key. */
const FINGERPRINT_CHARS = 6;
/** No whitespace or control characters anywhere in a key. */
// eslint-disable-next-line no-control-regex
const KEY_SHAPE = /^[^\s\u0000-\u001f\u007f]+$/u;

/**
 * Whose key the machine keeps: its own (pasted for this machine, or set in
 * its terminal; a key kept before the account's key existed is one too) or
 * the account's (pasted once, handed from machine to machine).
 */
export type AdvisorKeySourceName = "own" | "account";

/** What devices learn about the key: never the key itself. */
export type AdvisorKeyStatus = {
  keySet: boolean;
  /** First FINGERPRINT_CHARS hex characters of the key's SHA-256; "" without a key. */
  fingerprint: string;
  /** The device that set it ("local": the machine's own terminal); "" without a key. */
  setByDevice: string;
  /** Unix milliseconds; 0 without a key. */
  setAt: number;
  /** "" without a key. */
  source: AdvisorKeySourceName | "";
};

/** The account's key as one machine hands it to another (advisor-key-share.ts). */
export type SharedAdvisorKey = { key: string; setAt: number; setByDevice: string };

const NO_KEY: AdvisorKeyStatus = { keySet: false, fingerprint: "", setByDevice: "", setAt: 0, source: "" };
/** SaveNote.scope of the account's key; an entry without one is the machine's own. */
const ACCOUNT_SCOPE = "account";

const ERROR_MESSAGES = {
  invalid: "the key is too short, too long, or has spaces or control characters",
  not_saved: "the key could not be sealed on this machine; nothing was saved",
  own_key: "this machine keeps its own key; remove it first to use the account's key",
  no_key: "this machine keeps no key of that kind",
} as const;

/** A key refused or not saved. The message is fixed: it never quotes the key. */
export class AdvisorKeyError extends Error {
  constructor(readonly kind: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[kind]);
  }
}

/** How a key is set: the machine's own (default) or the account's, counted as set at `setAt` (0: now). */
export type AdvisorKeySetOptions = { source?: AdvisorKeySourceName; setAt?: number };

/**
 * Hides a key that arrived from every output of this process, as typed and
 * trimmed, before anything else happens to it; a string too short to be a
 * key is left alone (it is refused anyway).
 */
export function rememberAdvisorKey(raw: string): void {
  const key = raw.trim();
  if (key.length < MIN_KEY_CHARS) return;
  rememberSecret(raw);
  rememberSecret(key);
}

/** The fingerprint devices show for a key. */
export function advisorKeyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, FINGERPRINT_CHARS);
}

export type AdvisorKeyStoreOptions = {
  configDir: string;
  audit: AuditLog;
  log?: (line: string) => void;
  now?: () => number;
};

/** How save() keeps a key and what it logs. */
type SaveHow = {
  /** The device asking, for the consent log. */
  device: string;
  /** The device the key was first set from, shown to devices. */
  savedBy: string;
  source: AdvisorKeySourceName;
  /** Unix milliseconds the account's key counts as set; 0 or out of range: now. */
  setAt: number;
  action: "advisor_key_set" | "advisor_key_share_received" | "advisor_key_promote";
};

function sourceOf(e: SavedSecretInfo): AdvisorKeySourceName {
  return e.scope === ACCOUNT_SCOPE ? "account" : "own";
}

export class AdvisorKeyStore {
  private readonly store: SecretStore;
  private readonly log: (line: string) => void;
  /** Changes run one after another, in the order asked: a removal asked after a set never lands before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AdvisorKeyStoreOptions) {
    this.store = new SecretStore(opts.configDir, opts.now, ADVISOR_SECRETS_FILE);
    this.log = opts.log ?? (() => undefined);
  }

  /** Whether a key is kept, whose it is, its fingerprint and who set it; no key when the store cannot be read (logged). */
  status(): AdvisorKeyStatus {
    let held: SavedSecretInfo | undefined;
    try {
      held = this.held();
    } catch (err) {
      this.log(`advisor: the key store cannot be read (${redact((err as Error).message)})`);
      return NO_KEY;
    }
    if (!held) return NO_KEY;
    return { keySet: true, fingerprint: held.fingerprint ?? "", setByDevice: held.savedBy ?? "", setAt: held.createdAt, source: sourceOf(held) };
  }

  /**
   * Seals and keeps `key`, replacing the one kept; the account's key never
   * replaces the machine's own (AdvisorKeyError "own_key"). The key is hidden
   * from every output of this process before anything else happens to it.
   */
  set(rawKey: string, device: string, opts: AdvisorKeySetOptions = {}): Promise<AdvisorKeyStatus> {
    rememberAdvisorKey(rawKey);
    const source = opts.source ?? "own";
    return this.serial(() => this.save(rawKey.trim(), { device, savedBy: device, source, setAt: opts.setAt ?? 0, action: "advisor_key_set" }));
  }

  /**
   * Keeps the account's key handed on by another machine (opened by
   * advisor-key-share.ts), with the time and device it was first set from.
   */
  receive(shared: SharedAdvisorKey, device: string): Promise<AdvisorKeyStatus> {
    rememberAdvisorKey(shared.key);
    return this.serial(() =>
      this.save(shared.key.trim(), { device, savedBy: shared.setByDevice, source: "account", setAt: shared.setAt, action: "advisor_key_share_received" }),
    );
  }

  /**
   * Forgets the key; `only` keeps a key of the other kind. Nothing to do when
   * none is kept. Runs after any change asked before it.
   */
  remove(device: string, only?: AdvisorKeySourceName): Promise<AdvisorKeyStatus> {
    return this.serial(async () => this.forget(device, only));
  }

  /** The machine's own key becomes the account's, counted as set at `setAt` (0: now); AdvisorKeyError "no_key" without one. */
  promote(device: string, setAt: number): Promise<AdvisorKeyStatus> {
    return this.serial(async () => {
      const held = this.held();
      if (held === undefined || sourceOf(held) !== "own") throw new AdvisorKeyError("no_key");
      const key = await this.store.reveal(held.id);
      if (key === undefined) throw new AdvisorKeyError("no_key");
      return this.save(key, { device, savedBy: held.savedBy ?? device, source: "account", setAt, action: "advisor_key_promote" });
    });
  }

  /**
   * The account's key, to seal for another machine; logs the hand-off with
   * its fingerprint. AdvisorKeyError "no_key" when the machine keeps no
   * account key (its own key is never handed on).
   */
  async shareAccountKey(device: string): Promise<SharedAdvisorKey> {
    const held = this.held();
    if (held === undefined || sourceOf(held) !== "account") throw new AdvisorKeyError("no_key");
    const key = await this.store.reveal(held.id);
    if (key === undefined) throw new AdvisorKeyError("no_key");
    this.opts.audit.write({ device, action: "advisor_key_share_sent", path: ADVISOR_KEY_ORIGIN, detail: held.fingerprint ?? "" });
    return { key, setAt: held.createdAt, setByDevice: held.savedBy ?? "" };
  }

  /** The kept entry, without its value; throws when the store cannot be read. */
  private held(): SavedSecretInfo | undefined {
    return this.store.list().find((x) => x.origin === ADVISOR_KEY_ORIGIN && x.name === KEY_NAME);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    // The chain goes on whatever this change gave; its caller gets the outcome.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async save(key: string, how: SaveHow): Promise<AdvisorKeyStatus> {
    if (key.length < MIN_KEY_CHARS || key.length > MAX_SECRET_CHARS || !KEY_SHAPE.test(key)) throw new AdvisorKeyError("invalid");
    const account = how.source === "account";
    // The account's key never replaces the machine's own (a promotion replaces it with itself).
    if (account && how.action !== "advisor_key_promote" && this.status().source === "own") throw new AdvisorKeyError("own_key");
    const fingerprint = advisorKeyFingerprint(key);
    const setAt = Number.isSafeInteger(how.setAt) && how.setAt > 0 ? how.setAt : undefined;
    try {
      await this.store.save(ADVISOR_KEY_ORIGIN, KEY_NAME, key, {
        savedBy: how.savedBy,
        fingerprint,
        ...(account ? { scope: ACCOUNT_SCOPE, ...(setAt !== undefined ? { createdAt: setAt } : {}) } : {}),
      });
    } catch (err) {
      this.log(`advisor: the key was not saved (${redact((err as Error).message)})`);
      throw new AdvisorKeyError("not_saved");
    }
    this.opts.audit.write({ device: how.device, action: how.action, path: ADVISOR_KEY_ORIGIN, detail: fingerprint });
    return this.status();
  }

  private forget(device: string, only?: AdvisorKeySourceName): AdvisorKeyStatus {
    const held = this.held();
    if (!held) return NO_KEY;
    if (only !== undefined && sourceOf(held) !== only) return this.status();
    const gone = this.store.remove(held.id);
    if (gone) this.opts.audit.write({ device, action: "advisor_key_remove", path: ADVISOR_KEY_ORIGIN, detail: gone.fingerprint ?? "" });
    return this.status();
  }

  /** The key, for tunelo's own call to TypeSafe; undefined when none is kept. */
  async key(): Promise<string | undefined> {
    const held = this.store.findSaved(ADVISOR_KEY_ORIGIN, KEY_NAME);
    return held ? this.store.reveal(held.id) : undefined;
  }

  /** Opens the kept key once so that output echoing it is hidden from the start (a locked key store is skipped). */
  loadForRedaction(): Promise<void> {
    return this.store.loadForRedaction();
  }
}

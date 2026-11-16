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
import { SecretStore } from "../sign-in-secrets/secret-store.ts";

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

/** What devices learn about the key: never the key itself. */
export type AdvisorKeyStatus = {
  keySet: boolean;
  /** First FINGERPRINT_CHARS hex characters of the key's SHA-256; "" without a key. */
  fingerprint: string;
  /** The device that set it ("local": the machine's own terminal); "" without a key. */
  setByDevice: string;
  /** Unix milliseconds; 0 without a key. */
  setAt: number;
};

const NO_KEY: AdvisorKeyStatus = { keySet: false, fingerprint: "", setByDevice: "", setAt: 0 };

/** A key refused or not saved. The message is fixed: it never quotes the key. */
export class AdvisorKeyError extends Error {
  constructor(readonly kind: "invalid" | "not_saved") {
    super(kind === "invalid" ? "the key is too short, too long, or has spaces or control characters" : "the key could not be sealed on this machine; nothing was saved");
  }
}

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

export class AdvisorKeyStore {
  private readonly store: SecretStore;
  private readonly log: (line: string) => void;
  /** Changes run one after another, in the order asked: a removal asked after a set never lands before it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: AdvisorKeyStoreOptions) {
    this.store = new SecretStore(opts.configDir, opts.now, ADVISOR_SECRETS_FILE);
    this.log = opts.log ?? (() => undefined);
  }

  /** Whether a key is kept, its fingerprint and who set it; no key when the store cannot be read (logged). */
  status(): AdvisorKeyStatus {
    let entries: ReturnType<SecretStore["list"]>;
    try {
      entries = this.store.list();
    } catch (err) {
      this.log(`advisor: the key store cannot be read (${redact((err as Error).message)})`);
      return NO_KEY;
    }
    const e = entries.find((x) => x.origin === ADVISOR_KEY_ORIGIN && x.name === KEY_NAME);
    if (!e) return NO_KEY;
    return { keySet: true, fingerprint: e.fingerprint ?? "", setByDevice: e.savedBy ?? "", setAt: e.createdAt };
  }

  /**
   * Seals and keeps `key`, replacing the one kept. The key is hidden from
   * every output of this process before anything else happens to it.
   */
  set(rawKey: string, device: string): Promise<AdvisorKeyStatus> {
    rememberAdvisorKey(rawKey);
    return this.serial(() => this.save(rawKey.trim(), device));
  }

  /** Forgets the key; nothing to do when none is kept. Runs after any change asked before it. */
  remove(device: string): Promise<AdvisorKeyStatus> {
    return this.serial(async () => this.forget(device));
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    // The chain goes on whatever this change gave; its caller gets the outcome.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async save(key: string, device: string): Promise<AdvisorKeyStatus> {
    if (key.length < MIN_KEY_CHARS || key.length > MAX_SECRET_CHARS || !KEY_SHAPE.test(key)) throw new AdvisorKeyError("invalid");
    const fingerprint = advisorKeyFingerprint(key);
    try {
      await this.store.save(ADVISOR_KEY_ORIGIN, KEY_NAME, key, { savedBy: device, fingerprint });
    } catch (err) {
      this.log(`advisor: the key was not saved (${redact((err as Error).message)})`);
      throw new AdvisorKeyError("not_saved");
    }
    this.opts.audit.write({ device, action: "advisor_key_set", path: ADVISOR_KEY_ORIGIN, detail: fingerprint });
    return this.status();
  }

  private forget(device: string): AdvisorKeyStatus {
    const held = this.store.findSaved(ADVISOR_KEY_ORIGIN, KEY_NAME);
    if (!held) return NO_KEY;
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

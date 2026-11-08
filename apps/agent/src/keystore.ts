// The machine's private X25519 key lives in the OS key store: the macOS
// login Keychain, DPAPI (current user) on Windows. Elsewhere, and in tests,
// a 0600 file in the config folder. The Keychain entry was named after
// chat-agent before tunelo; that entry is still read while the new one is
// missing, so a machine never gets a second key.
//
// The same store holds a sealing key: seal/unseal encrypt any secret kept on
// disk (the account's refresh token) with AES-256-GCM under it, so the file
// alone is useless without this user's Keychain or DPAPI.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type KeyPair, exportPrivateKey, fromBase64Url, generateKeyPair, importKeyPair, toBase64Url } from "@achoo254/chat-remote-protocol";

const run = promisify(execFile);
const SERVICE = "com.hoandat.tunelo";
const LEGACY_SERVICE = "com.hoandat.chat-agent";
/** Entries of the store: the machine's X25519 key, and the key that seals secrets on disk. */
type Entry = "machine-key" | "session-key";

/** `read` resolves null only when the entry does not exist; a store it cannot read rejects. */
type Backend = { read(): Promise<string | null>; write(value: string): Promise<void> };

/** The key store is there but cannot be read now (Keychain locked, no GUI session, DPAPI failing). */
export class KeyStoreUnavailableError extends Error {
  constructor(detail: string) {
    super(`cannot read this user's key store (${detail}); unlock the Keychain (log in on the Mac) or try again`);
    this.name = "KeyStoreUnavailableError";
  }
}

/** Exit code of `security find-generic-password` when the item does not exist. */
const ITEM_NOT_FOUND = 44;

async function readKeychain(service: string, account: Entry = "machine-key"): Promise<string | null> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
    return stdout.trim() || null;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === ITEM_NOT_FOUND) return null;
    throw new KeyStoreUnavailableError(`security exited ${String(code)}`);
  }
}

function writeKeychain(service: string, value: string, account: Entry = "machine-key"): Promise<void> {
  // Through `security -i` on stdin so the key never shows up in argv.
  return new Promise<void>((resolve, reject) => {
    const child = execFile("security", ["-i"], (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(`add-generic-password -U -s ${service} -a ${account} -w ${value}\n`);
  });
}

function keychain(entry: Entry): Backend {
  return {
    async read() {
      const current = await readKeychain(SERVICE, entry);
      // Only the machine key existed under the old name.
      return current ?? (entry === "machine-key" ? await readKeychain(LEGACY_SERVICE) : null);
    },
    write: (value) => writeKeychain(SERVICE, value, entry),
  };
}

function dpapi(dir: string, entry: Entry): Backend {
  const file = join(dir, `${entry}.dpapi`);
  const ps = (script: string, input: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
      child.stdin?.end(input);
    });
  const load = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim();";
  return {
    async read() {
      if (!existsSync(file)) return null;
      return ps(
        `${load} $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'); [Text.Encoding]::UTF8.GetString($b)`,
        readFileSync(file, "utf8"),
      ).catch((err: unknown) => {
        throw new KeyStoreUnavailableError(`DPAPI: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    async write(value) {
      const sealed = await ps(
        `${load} $b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'); [Convert]::ToBase64String($b)`,
        value,
      );
      writeFileSync(file, sealed, { mode: 0o600 });
    },
  };
}

function plainFile(dir: string, entry: Entry): Backend {
  const file = join(dir, entry);
  return {
    async read() {
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    },
    async write(value) {
      writeFileSync(file, value, { mode: 0o600 });
    },
  };
}

const fileKeystore = () => (process.env.TUNELO_KEYSTORE || process.env.CHAT_AGENT_KEYSTORE) === "file";
const usesKeychain = () => process.platform === "darwin" && !fileKeystore();

let warnedPlainFile = false;

function backend(dir: string, entry: Entry): Backend {
  if (fileKeystore()) {
    // Meant for tests: the keys then sit beside what they protect.
    if (!warnedPlainFile && !process.env.VITEST) {
      warnedPlainFile = true;
      console.error("tunelo: TUNELO_KEYSTORE=file keeps the machine and sealing keys in plain files next to the sign-in");
    }
    return plainFile(dir, entry);
  }
  if (usesKeychain()) return keychain(entry);
  if (process.platform === "win32") return dpapi(dir, entry);
  return plainFile(dir, entry);
}

/** Loads the machine key, creating it on first run. */
export async function machineKey(dir: string): Promise<KeyPair> {
  const store = backend(dir, "machine-key");
  const existing = await store.read();
  if (existing) return importKeyPair(fromBase64Url(existing));
  const fresh = await generateKeyPair(true);
  await store.write(toBase64Url(await exportPrivateKey(fresh.privateKey)));
  const saved = await store.read();
  if (!saved) throw new Error("could not store the machine key");
  return importKeyPair(fromBase64Url(saved));
}

/**
 * Copies the machine key from the Keychain entry of the old name to the new
 * one and reads it back. The old entry stays, so going back to hda still has
 * the key. The DPAPI and file stores live in the config folder and move with
 * it. Throws rather than letting the machine end up with two keys.
 */
export async function copyLegacyMachineKey(): Promise<void> {
  if (!usesKeychain()) return;
  const legacy = await readKeychain(LEGACY_SERVICE);
  if (!legacy) return;
  const current = await readKeychain(SERVICE);
  if (current) {
    if (current !== legacy) throw new Error(`the Keychain holds two different machine keys (${SERVICE}, ${LEGACY_SERVICE}); nothing was changed`);
    return;
  }
  await writeKeychain(SERVICE, legacy);
  if ((await readKeychain(SERVICE)) !== legacy) throw new Error("the machine key did not copy to its new Keychain entry; nothing else was changed");
}

const SEALED_PREFIX = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bound into every sealed value, so a ciphertext of another use does not open here. */
const AAD = Buffer.from("tunelo sealed secret v1");
const sealingKeys = new Map<string, Promise<Buffer | null>>();

/** The stored key, null when there is none; a damaged one is an error, never replaced. */
function decodeKey(text: string | null): Buffer | null {
  if (!text) return null;
  const key = Buffer.from(text, "base64url");
  if (key.length !== KEY_BYTES) throw new Error("the sealing key in the key store is damaged");
  return key;
}

/** The sealing key of this config folder. Only a key found is kept for the process. */
function loadSealingKey(dir: string): Promise<Buffer | null> {
  const cached = sealingKeys.get(dir);
  if (cached) return cached;
  const pending = backend(dir, "session-key").read().then(decodeKey);
  sealingKeys.set(dir, pending);
  // Neither "none yet" nor a failed read (Keychain locked) may stick: the next call asks again.
  pending.then(
    (key) => {
      if (!key) sealingKeys.delete(dir);
    },
    () => sealingKeys.delete(dir),
  );
  return pending;
}

/**
 * Creates the sealing key on first use and reads it back from the store.
 * Only when the store says there is none: a store that cannot be read
 * fails here, so a key in it is never written over.
 */
async function sealingKey(dir: string): Promise<Buffer> {
  const existing = await loadSealingKey(dir);
  if (existing) return existing;
  await backend(dir, "session-key").write(randomBytes(KEY_BYTES).toString("base64url"));
  const saved = await loadSealingKey(dir);
  if (!saved) throw new Error("could not store the sealing key in the key store");
  return saved;
}

/**
 * Encrypts a secret for storage on disk with this user's sealing key
 * (created on first use). Callers that may run at the same time for the
 * first time must hold one lock (the session lock does).
 */
export async function seal(dir: string, plaintext: string): Promise<string> {
  const key = await sealingKey(dir);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${SEALED_PREFIX}.${iv.toString("base64url")}.${data.toString("base64url")}`;
}

/** Decrypts a value of seal(); throws when the key is gone or the value was changed. */
export async function unseal(dir: string, sealed: string): Promise<string> {
  const [version, ivText, dataText] = sealed.split(".");
  if (version !== SEALED_PREFIX || !ivText || !dataText) throw new Error("not a sealed value");
  const key = await loadSealingKey(dir);
  if (!key) throw new Error("the sealing key is missing from the key store");
  const iv = Buffer.from(ivText, "base64url");
  const data = Buffer.from(dataText, "base64url");
  if (iv.length !== IV_BYTES || data.length < TAG_BYTES) throw new Error("not a sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}

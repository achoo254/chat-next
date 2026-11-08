// The machine's private X25519 key lives in the OS key store: the macOS
// login Keychain, DPAPI (current user) on Windows. Elsewhere, and in tests,
// a 0600 file in the config folder. The Keychain entry was named after
// chat-agent before tunelo; that entry is still read while the new one is
// missing, so a machine never gets a second key.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type KeyPair, exportPrivateKey, fromBase64Url, generateKeyPair, importKeyPair, toBase64Url } from "@achoo254/chat-remote-protocol";

const run = promisify(execFile);
const SERVICE = "com.hoandat.tunelo";
const LEGACY_SERVICE = "com.hoandat.chat-agent";
const ACCOUNT = "machine-key";

type Backend = { read(): Promise<string | null>; write(value: string): Promise<void> };

async function readKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-a", ACCOUNT, "-w"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function writeKeychain(service: string, value: string): Promise<void> {
  // Through `security -i` on stdin so the key never shows up in argv.
  return new Promise<void>((resolve, reject) => {
    const child = execFile("security", ["-i"], (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(`add-generic-password -U -s ${service} -a ${ACCOUNT} -w ${value}\n`);
  });
}

function keychain(): Backend {
  return {
    async read() {
      return (await readKeychain(SERVICE)) ?? (await readKeychain(LEGACY_SERVICE));
    },
    write: (value) => writeKeychain(SERVICE, value),
  };
}

function dpapi(dir: string): Backend {
  const file = join(dir, "machine-key.dpapi");
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
      );
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

function plainFile(dir: string): Backend {
  const file = join(dir, "machine-key");
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

function backend(dir: string): Backend {
  if (fileKeystore()) return plainFile(dir);
  if (usesKeychain()) return keychain();
  if (process.platform === "win32") return dpapi(dir);
  return plainFile(dir);
}

/** Loads the machine key, creating it on first run. */
export async function machineKey(dir: string): Promise<KeyPair> {
  const store = backend(dir);
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

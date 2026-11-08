// The machine's private X25519 key lives in the OS key store: the macOS
// login Keychain, DPAPI (current user) on Windows. Elsewhere, and in tests,
// a 0600 file in the config folder.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type KeyPair, exportPrivateKey, fromBase64Url, generateKeyPair, importKeyPair, toBase64Url } from "@achoo254/chat-remote-protocol";

const run = promisify(execFile);
const SERVICE = "com.hoandat.chat-agent";
const ACCOUNT = "machine-key";

type Backend = { read(): Promise<string | null>; write(value: string): Promise<void> };

function keychain(): Backend {
  return {
    async read() {
      try {
        const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    async write(value) {
      // Through `security -i` on stdin so the key never shows up in argv.
      await new Promise<void>((resolve, reject) => {
        const child = execFile("security", ["-i"], (err) => (err ? reject(err) : resolve()));
        child.stdin?.end(`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${value}\n`);
      });
    },
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

function backend(dir: string): Backend {
  if (process.env.CHAT_AGENT_KEYSTORE === "file") return plainFile(dir);
  if (process.platform === "darwin") return keychain();
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

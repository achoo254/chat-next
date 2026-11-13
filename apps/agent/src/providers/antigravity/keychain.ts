// agy's sign-in in the macOS Keychain: one generic password (service
// "gemini", account "antigravity") that every agy of the user reads. Its
// value is "go-keyring-base64:" and the base64 of a JSON holding the token and
// `id_token_email`. tunelo reads and writes it through /usr/bin/security
// (which the item's own ACL lets do so without a prompt); a value is written
// as hex on security's stdin, never on a command line, and never logged.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SERVICE = "gemini";
const ACCOUNT = "antigravity";
/** security -i reads lines of at most this many bytes. */
export const MAX_LINE = 4096;

/** Why the Keychain could not be used, as a fixed kind (never security's own output). */
export class KeychainError extends Error {
  constructor(readonly kind: "locked" | "too-long" | "failed") {
    super(
      kind === "locked"
        ? "the macOS Keychain cannot be read now (locked: sign in on the machine once)"
        : kind === "too-long"
          ? "agy's sign-in is too long to switch"
          : "the macOS Keychain refused the change",
    );
  }
}

export interface AgyKeychain {
  /** agy's sign-in now; undefined when there is none. */
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

/** The `add-generic-password` line for `value`; refused when longer than security takes. */
export function writeLine(value: string): string {
  const line = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -X ${Buffer.from(value, "utf8").toString("hex")}\n`;
  if (Buffer.byteLength(line) > MAX_LINE) throw new KeychainError("too-long");
  return line;
}

/** The email agy's sign-in is for; undefined when the value is not one tunelo knows. */
export function emailOf(value: string): string | undefined {
  const prefix = "go-keyring-base64:";
  if (!value.startsWith(prefix)) return undefined;
  try {
    const email: unknown = (JSON.parse(Buffer.from(value.slice(prefix.length), "base64").toString("utf8")) as { id_token_email?: unknown }).id_token_email;
    return typeof email === "string" && email.includes("@") ? email : undefined;
  } catch {
    return undefined;
  }
}

export const macKeychain: AgyKeychain = {
  async read() {
    try {
      const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { timeout: 15_000, maxBuffer: 256 * 1024 });
      return stdout.replace(/\n$/, "");
    } catch (err) {
      if ((err as { code?: unknown }).code === 44) return undefined; // no item
      throw new KeychainError("locked");
    }
  },
  async write(value) {
    const line = writeLine(value);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new KeychainError("failed"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new KeychainError("failed"));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(line);
    });
  },
};

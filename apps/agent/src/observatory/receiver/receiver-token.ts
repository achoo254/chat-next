// The OTLP receiver's token: 32 random bytes (hex), kept in
// `<observatory data>/otlp-token.json` (0600), sent by Claude Code as
// `Authorization: Bearer <token>`. It reaches Claude Code only through an
// environment variable (OTEL_EXPORTER_OTLP_HEADERS, written by the install
// command into settings.json's env), never on a command line.
//
// Made once and kept: only a missing file makes a new one. A file that
// cannot be read (locked by a scanner at startup) or holds no token throws
// TokenUnreadable and is left alone: replacing it would make the token in
// settings.json wrong for good. Rotating keeps exactly one previous token
// accepted until the next rotation (a session keeps the environment it
// started with, for days if it runs that long), or until it is revoked.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OTLP_TOKEN_FILE = "otlp-token.json";
const TOKEN = /^[0-9a-f]{64}$/;
/** Waits between tries of a token file that cannot be read now. */
const READ_RETRY_MS = [50, 150, 400];

export type ReceiverTokens = {
  current: string;
  /** The token before the last rotation, accepted until the next one or until revoked. */
  previous?: string;
};

/** The token file exists but cannot be read, or holds no token; it was not replaced. */
export class TokenUnreadable extends Error {
  override readonly name = "TokenUnreadable";
}

/** The environment Claude Code needs to send logs here (for the install command): the endpoint by IP, JSON, the token. */
export function otlpClientEnv(port: number, token: string): Record<string, string> {
  return {
    // The receiver accepts exactly this Host (request-guard.ts): not localhost.
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    // Protobuf is refused (415).
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
  };
}

function tokenFile(dataDir: string): string {
  return join(dataDir, OTLP_TOKEN_FILE);
}

function parseTokens(text: string): ReceiverTokens | undefined {
  try {
    const value = JSON.parse(text) as { current?: unknown; previous?: unknown };
    if (typeof value.current !== "string" || !TOKEN.test(value.current)) return undefined;
    return typeof value.previous === "string" && TOKEN.test(value.previous) ? { current: value.current, previous: value.previous } : { current: value.current };
  } catch {
    return undefined;
  }
}

async function saveTokens(dataDir: string, tokens: ReceiverTokens): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = tokenFile(dataDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

const newToken = (): string => randomBytes(32).toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The saved tokens: the file read again a few times while it cannot be; a new token only when there is no file. */
export async function loadOrCreateTokens(dataDir: string, retryMs: readonly number[] = READ_RETRY_MS): Promise<ReceiverTokens> {
  for (let attempt = 0; ; attempt++) {
    let text: string;
    try {
      text = await readFile(tokenFile(dataDir), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const tokens: ReceiverTokens = { current: newToken() };
        await saveTokens(dataDir, tokens);
        return tokens;
      }
      const wait = retryMs[attempt];
      if (wait === undefined) throw new TokenUnreadable(`the OTLP token file cannot be read (${code ?? "error"})`, { cause: err });
      await sleep(wait);
      continue;
    }
    const tokens = parseTokens(text);
    if (!tokens) throw new TokenUnreadable("the OTLP token file holds no token");
    return tokens;
  }
}

/** A new token; the current one stays accepted (as the only previous one) until the next rotation or a revoke. */
export async function rotateTokens(dataDir: string): Promise<ReceiverTokens> {
  const old = await loadOrCreateTokens(dataDir);
  const tokens: ReceiverTokens = { current: newToken(), previous: old.current };
  await saveTokens(dataDir, tokens);
  return tokens;
}

/** Stops accepting the previous token now (it may have leaked). */
export async function revokePreviousToken(dataDir: string): Promise<ReceiverTokens> {
  const tokens: ReceiverTokens = { current: (await loadOrCreateTokens(dataDir)).current };
  await saveTokens(dataDir, tokens);
  return tokens;
}

function same(given: Buffer, token: string): boolean {
  const expected = Buffer.from(token, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Which token `given` (the header's) is, compared in constant time: the current one, the previous one, or neither. */
export function tokenMatch(given: string, tokens: ReceiverTokens): "current" | "previous" | undefined {
  const g = Buffer.from(given, "utf8");
  const current = same(g, tokens.current);
  const previous = tokens.previous !== undefined && same(g, tokens.previous);
  return current ? "current" : previous ? "previous" : undefined;
}

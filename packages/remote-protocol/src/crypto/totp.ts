// Time-based one-time codes (RFC 6238 over RFC 4226 HOTP) as authenticator
// apps compute them: HMAC-SHA1, 6 digits, 30-second steps, 20-byte secret.
// The machine's secret pairs new devices (see pairing.ts); a paired device
// makes it and shows it once as an otpauth:// URI. Synchronous and free of
// Node APIs, so the same code runs in browsers and in the agent.
import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { equal, random, u64, utf8 } from "../bytes.ts";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_MS = 30_000;
export const TOTP_SECRET_BYTES = 20;
/** Steps accepted either side of the current one, for clock drift. */
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_RE = /^\d{6}$/;

export function generateTotpSecret(): Uint8Array<ArrayBuffer> {
  return random(TOTP_SECRET_BYTES);
}

export function isTotpSecret(secret: Uint8Array): boolean {
  return secret.length === TOTP_SECRET_BYTES;
}

/** The 30-second step a Unix-millisecond time falls in. */
export function totpStep(now: number): number {
  return Math.floor(now / TOTP_PERIOD_MS);
}

/** HOTP value of one step, as the 6 digits an authenticator shows. */
export function totpCodeAt(secret: Uint8Array, step: number): string {
  if (secret.length === 0) throw new Error("empty TOTP secret");
  if (!Number.isSafeInteger(step) || step < 0) throw new Error("invalid TOTP step");
  const mac = hmac(sha1, secret, u64(BigInt(step)));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = new DataView(mac.buffer, mac.byteOffset + offset, 4).getUint32(0) & 0x7fff_ffff;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpCode(secret: Uint8Array, now: number = Date.now()): string {
  return totpCodeAt(secret, totpStep(now));
}

/** The codes accepted at `now`: previous, current and next step. */
export function totpCandidates(secret: Uint8Array, now: number = Date.now()): string[] {
  const step = totpStep(now);
  const out: string[] = [];
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    if (step + d >= 0) out.push(totpCodeAt(secret, step + d));
  }
  return out;
}

/**
 * Digits only, spaces and dashes removed (authenticators show "123 456");
 * null when the input is not a 6-digit code.
 */
export function normalizeTotpCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "");
  return CODE_RE.test(code) ? code : null;
}

/** Checks a typed code against the previous, current and next step. */
export function verifyTotp(secret: Uint8Array, input: string, now: number = Date.now()): boolean {
  const code = normalizeTotpCode(input);
  if (code === null) return false;
  let ok = false;
  // Every candidate is compared, so timing does not tell which step matched.
  for (const want of totpCandidates(secret, now)) ok = equal(utf8(want), utf8(code)) || ok;
  return ok;
}

/** RFC 4648 base32, upper case, without padding (what otpauth URIs carry). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces and "=" padding, as people copy secrets. */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The otpauth:// URI an authenticator app scans: `issuer:label` names the
 * entry (issuer: the product name from the brand package), and every
 * parameter is spelled out for apps that do not assume the defaults.
 */
export function totpUri(opts: { secret: Uint8Array; label: string; issuer: string }): string {
  const issuer = opts.issuer;
  const params = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_MS / 1000),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(opts.label)}?${params.toString()}`;
}

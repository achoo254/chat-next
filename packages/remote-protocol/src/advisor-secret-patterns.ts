// Shapes of secrets that must never go to Advisor: the machine refuses a
// request to Advisor that holds one (apps/agent advisor-outbound.ts), and the
// web leaves a copied text that holds one out of what it offers to attach.
// One list for both sides, so that what the web offers the machine never
// refuses for this reason. A basic gitleaks-like set: a few well-known token
// prefixes, private key blocks, credentials in URLs and assignments, and long
// random-looking strings. The agent's redaction (apps/agent mcp/redact.ts)
// hides the token shapes of this same list, so web, Advisor and redaction
// never drift apart.

/**
 * One shape: a regular expression's source and flags (no `g`: test() only).
 * `prefixes`, for a token shape: the literal texts one of which every match
 * starts with, so a scanner can find them first (indexOf) and run the
 * expression only there.
 */
export type SecretPattern = { id: string; source: string; flags: string; prefixes?: readonly string[] };

export const ADVISOR_SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: "jwt", source: String.raw`eyJ[\w-]{8,}\.[\w-]{8,}`, flags: "" },
  { id: "bearer", source: String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`, flags: "i" },
  { id: "sk", source: String.raw`\bsk-[A-Za-z0-9_-]{16,}`, flags: "", prefixes: ["sk-"] },
  { id: "typesafe", source: String.raw`\bts_[A-Za-z0-9_]{16,}`, flags: "", prefixes: ["ts_"] },
  { id: "github", source: String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`, flags: "", prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] },
  { id: "github-pat", source: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`, flags: "", prefixes: ["github_pat_"] },
  { id: "gitlab", source: String.raw`\bglpat-[A-Za-z0-9_-]{20,}`, flags: "", prefixes: ["glpat-"] },
  { id: "aws", source: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: "", prefixes: ["AKIA", "ASIA"] },
  { id: "slack", source: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, flags: "", prefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"] },
  { id: "google", source: String.raw`\bAIza[0-9A-Za-z_-]{35}`, flags: "", prefixes: ["AIza"] },
  { id: "pem", source: String.raw`-----BEGIN [A-Z0-9 ]+-----`, flags: "" },
  { id: "url-userinfo", source: String.raw`[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`, flags: "i" },
  // A key, password, token or secret set to a value that looks like one: at
  // least 8 characters with letters and digits (not `max_token=1000`).
  {
    id: "assignment",
    source: String.raw`\b[A-Za-z0-9_]*(?:_key|password|passwd|token|secret)\s*=\s*["']?(?=[^\s"']*[A-Za-z])(?=[^\s"']*[0-9])[^\s"']{8,}`,
    flags: "i",
  },
];

/** A run of token characters at least this long is weighed for randomness. */
export const HIGH_ENTROPY_MIN_CHARS = 32;
/**
 * Bits of Shannon entropy per character above which such a run reads as a
 * secret. Hex (a commit hash, a UUID) stays at or below 4 bits; a random
 * base64 or base62 token of that length is well above.
 */
export const HIGH_ENTROPY_BITS = 4.2;

const TOKEN_RUN = new RegExp(String.raw`[A-Za-z0-9+/_=-]{${HIGH_ENTROPY_MIN_CHARS},}`, "g");

function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long run of upper-case letters, lower-case letters and digits that looks random. */
function highEntropyRun(text: string): boolean {
  for (const m of text.matchAll(TOKEN_RUN)) {
    const run = m[0];
    if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) continue;
    if (entropyBits(run) >= HIGH_ENTROPY_BITS) return true;
  }
  return false;
}

const COMPILED = ADVISOR_SECRET_PATTERNS.map((p) => ({ id: p.id, re: new RegExp(p.source, p.flags) }));

/** The id of the first secret shape `text` holds ("entropy" for a random-looking run); undefined when none. */
export function secretShapeIn(text: string): string | undefined {
  for (const p of COMPILED) if (p.re.test(text)) return p.id;
  return highEntropyRun(text) ? "entropy" : undefined;
}

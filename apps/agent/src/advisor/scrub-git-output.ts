// git's output as Advisor's AI may read it: what git printed of a failure the
// machine kept (git-failure-memory.ts), and what advisor_git prints. Nothing
// of the machine's own folders, no password or token in a URL, no secret
// tunelo holds, nothing shaped like a secret (the shared list of
// @achoo254/chat-remote-protocol, which the web and the outbound check use
// too), no control characters, and at most a fixed size.
import { homedir } from "node:os";
import { ADVISOR_SECRET_PATTERNS, secretShapeIn } from "@achoo254/chat-remote-protocol";
import { redact } from "../mcp/redact.ts";

/** What a failure adds to a question, at most. */
export const FAILURE_OUTPUT_MAX_BYTES = 4 * 1024;

const HIDDEN = "[hidden]";

/** A private key block, header to footer (or to the end when cut). */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
/** The user and password part of a URL: `https://user:token@host` → `https://host`. */
const URL_USERINFO = /:\/\/[^/@\s]+@/g;
/** Runs long enough to be weighed as random (the shared list's high-entropy rule). */
const TOKEN_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const SHAPES = ADVISOR_SECRET_PATTERNS.filter((p) => p.id !== "pem").map((p) => new RegExp(p.source, `${p.flags}g`));

const ESC = String.fromCharCode(0x1b);
/** A terminal color or cursor sequence (ESC [ … letter). */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/** Characters below space (but tab and new line) and the C1 controls go; so do terminal colors. */
function withoutControls(text: string): string {
  let out = "";
  for (const ch of text.replace(CSI, "")) {
    const c = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || !(c < 0x20 || (c >= 0x7f && c <= 0x9f))) out += ch;
  }
  return out;
}

/** Cuts at `maxBytes` of UTF-8 without splitting a character, saying it was cut. */
export function cutBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const note = "\n… (cut)";
  let bytes = Buffer.byteLength(note, "utf8");
  let out = "";
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out + note;
}

export type ScrubOptions = {
  /** The repository's folder: named "." (as a device sees git's last line). */
  root?: string;
  /** The user's home folder: named "~"; the machine's own when unset. */
  home?: string;
  maxBytes?: number;
};

/** `text` as it may reach Advisor's AI. */
export function scrubGitOutput(text: string, opts: ScrubOptions = {}): string {
  let out = withoutControls(text.replace(/\r\n?/g, "\n"));
  if (opts.root) out = out.replaceAll(opts.root, ".");
  const home = opts.home ?? homedir();
  if (home) out = out.replaceAll(home, "~");
  return cutBytes(hideSecretShapes(out), opts.maxBytes ?? FAILURE_OUTPUT_MAX_BYTES);
}

/**
 * `text` without anything shaped like a secret: private key blocks, the
 * password of a URL, every secret tunelo holds, the shared list's shapes and
 * random-looking runs, each as "[hidden]".
 */
export function hideSecretShapes(text: string): string {
  let out = text.replace(PEM_BLOCK, HIDDEN).replace(URL_USERINFO, "://");
  out = redact(out);
  for (const re of SHAPES) out = out.replace(re, HIDDEN);
  return out.replace(TOKEN_RUN, (run) => (secretShapeIn(run) === undefined ? run : HIDDEN));
}

// Credentials by their well-known shape, hidden by redact() (redact.ts):
// the token shapes of the list Advisor and the web use too
// (@achoo254/chat-remote-protocol ADVISOR_SECRET_PATTERNS, the entries with
// `prefixes`), private key blocks, and the password of a URL. Each is found
// by its fixed prefix first (indexOf, which is fast), and its expression
// runs only there, anchored at that spot: ordinary text of megabytes costs a
// few scans for short literals, not a regular expression tried at every
// position.
//
// hideNamedSecrets() is apart: values of secret-named fields, for the content
// Observatory stores (not for MCP results, whose `confirm_token` Claude must
// send back).
import { ADVISOR_SECRET_PATTERNS } from "@achoo254/chat-remote-protocol";

const HIDDEN = "[hidden]";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Trie = Map<string, Trie>;

/**
 * An expression matching exactly `words`, their common beginnings factored
 * (`g(?:h(?:p_|o_)|lpat-)`): both Node and Bun scan that several times faster
 * than a plain alternation of the words, or one scan per word.
 */
function wordsExpression(words: readonly string[]): string {
  const root: Trie = new Map();
  for (const word of words) {
    let node = root;
    for (const ch of word) {
      const next = node.get(ch) ?? new Map<string, Trie>();
      node.set(ch, next);
      node = next;
    }
    node.set("", new Map());
  }
  const source = (node: Trie): string => {
    const branches = [...node].filter(([ch]) => ch !== "").map(([ch, next]) => escapeRegExp(ch) + source(next));
    if (branches.length === 0) return "";
    const body = branches.length === 1 ? (branches[0] ?? "") : `(?:${branches.join("|")})`;
    return node.has("") ? `(?:${body})?` : body;
  };
  return source(root);
}

const PEM_START = "-----BEGIN ";
const PEM_HEADER = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/y;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
/** A private key block without its END line is hidden this far past its header (an RSA 4096 key is about 3.3 KB). */
export const PEM_BODY_MAX_CHARS = 4096;

/**
 * At a `://`: the user, then the password up to `@`. Neither crosses a
 * space, a slash, a quote, a comma or a bracket, so a URL in compact JSON
 * (`"url":"http://localhost:3000","email":"a@b.c"`) never reaches the next field.
 */
const URL_USERINFO = /:\/\/([^\s/@"',()<>[\]{}\\:]{1,256}):([^\s/@"',()<>[\]{}\\]{1,1024})@/y;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;

type Range = { start: number; end: number };
/** Where a credential found at `at` (the start of its prefix) ends, and what of it is hidden; undefined when there is none there. */
type Finder = (text: string, at: number) => Range | undefined;

function tokenFinder(re: RegExp): Finder {
  return (text, at) => {
    re.lastIndex = at;
    const m = re.exec(text);
    return m ? { start: at, end: at + m[0].length } : undefined;
  };
}

const pemFinder: Finder = (text, at) => {
  PEM_HEADER.lastIndex = at;
  const header = PEM_HEADER.exec(text);
  if (!header) return undefined;
  const bodyStart = at + header[0].length;
  const end = PEM_END.exec(text.slice(bodyStart, bodyStart + PEM_BODY_MAX_CHARS + 60));
  return { start: at, end: end ? bodyStart + end.index + end[0].length : Math.min(text.length, bodyStart + PEM_BODY_MAX_CHARS) };
};

/** Only the password is hidden: the scheme and the user stay. */
const urlPasswordFinder: Finder = (text, at) => {
  if (at === 0 || !SCHEME_CHAR.test(text[at - 1] ?? "")) return undefined;
  URL_USERINFO.lastIndex = at;
  const m = URL_USERINFO.exec(text);
  if (!m?.[1] || !m[2]) return undefined;
  const start = at + 3 + m[1].length + 1;
  return { start, end: start + m[2].length };
};

/** Every prefix and what to do where it is found: the shared list's token shapes (compiled sticky), private key blocks, URL passwords. */
const FINDERS = new Map<string, Finder>([
  ...ADVISOR_SECRET_PATTERNS.flatMap((p) => {
    const find = tokenFinder(new RegExp(p.source, `${p.flags}y`));
    return (p.prefixes ?? []).map((prefix): [string, Finder] => [prefix, find]);
  }),
  [PEM_START, pemFinder],
  ["://", urlPasswordFinder],
]);

/**
 * The prefixes, looked for in two scans (those starting with a lower-case
 * letter, and the rest), each a factored expression: measured on 8 MB of
 * source, about 3.3 ms under Node and Bun, against 4–7 ms for one scan of all
 * of them or chunks of them, and 15–22 ms for one indexOf scan per prefix.
 */
const SCANNERS = [
  [...FINDERS.keys()].filter((p) => /^[a-z]/.test(p)),
  [...FINDERS.keys()].filter((p) => !/^[a-z]/.test(p)),
].map((group) => new RegExp(wordsExpression(group), "g"));

/** `text` with credentials of a well-known shape replaced by "[hidden]" (overlapping finds merged). */
export function hideCredentialShapes(text: string): string {
  const ranges: Range[] = [];
  for (const scanner of SCANNERS) {
    scanner.lastIndex = 0;
    for (let m = scanner.exec(text); m; m = scanner.exec(text)) {
      const found = FINDERS.get(m[0])?.(text, m.index);
      if (!found) continue;
      ranges.push(found);
      scanner.lastIndex = Math.max(found.end, m.index + 1);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const r of ranges) {
    if (r.end <= at) continue;
    if (r.start >= at) out += text.slice(at, r.start) + HIDDEN;
    at = r.end;
  }
  return out + text.slice(at);
}

/** A name that says its value is a secret. */
const SECRET_NAME = /secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key/i;
/** `NAME=value` (an env line, a shell assignment, a query parameter). */
const ASSIGNED = /(?<![\w.-])([\w.-]{1,64})(\s*=\s*)(["']?)([^\s"'\\,;&]{1,4096})/g;
/** `"name": "value"` in JSON, as written or escaped inside a JSON string. */
const JSON_PAIR = /(\\?")([\w.-]{1,64})(\\?"\s*:\s*\\?")([^"\\]{1,4096})(?=\\?")/g;
/** `name: value` at the start of a YAML line. */
const YAML_PAIR = /^([ \t]*)([\w.-]{1,64})(:[ \t]+)(["']?)([^\s"'#]{1,4096})/gm;

/** A value worth hiding: not a short number (`max_tokens=4096`) nor a reference (`$TOKEN`, `${…}`, `%X%`, `<token>`). */
function secretValue(value: string): boolean {
  return value.length >= 3 && !/^\d{1,7}$/.test(value) && !/^[$%{<(]/.test(value) && value !== HIDDEN;
}

/**
 * `text` with the values of names that say they are secret hidden
 * (`DB_PASSWORD=…`, `"client_secret": "…"`, `api_key: …`). Not part of
 * redact(): tool results tunelo's MCP hands to Claude carry values Claude
 * must send back under such names (a dry run's `confirm_token`). Observatory
 * applies it to the content it stores (at most a few KB).
 */
export function hideNamedSecrets(text: string): string {
  const named = (name: string, value: string): boolean => SECRET_NAME.test(name) && secretValue(value);
  let out = text.replace(ASSIGNED, (m, name: string, eq: string, quote: string, value: string) => (named(name, value) ? `${name}${eq}${quote}${HIDDEN}` : m));
  out = out.replace(JSON_PAIR, (m, open: string, name: string, sep: string, value: string) => (named(name, value) ? `${open}${name}${sep}${HIDDEN}` : m));
  return out.replace(YAML_PAIR, (m, indent: string, name: string, sep: string, quote: string, value: string) =>
    named(name, value) ? `${indent}${name}${sep}${quote}${HIDDEN}` : m,
  );
}

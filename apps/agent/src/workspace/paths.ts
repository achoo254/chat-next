// Paths inside a workspace as devices name them: relative, "/"-separated,
// without "." or ".." parts. Every one is resolved against the workspace's
// real folder (symbolic links included) and refused when it ends outside it,
// so `..`, an absolute path, a link to elsewhere or a name that only looks
// like ".." never reach another folder. Secret files (dotenv, private keys,
// credential files, git internals) and anything in a folder the machine
// holds sensitive are refused whatever a device asks.
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import { OutsideFolderError } from "../safety/session-files.ts";

/** Folders whose content is never shown: git internals and stores of keys or credentials (aws, kube config too). */
const SECRET_DIRS = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube", ".docker"]);

/** Files that hold credentials by their name alone. */
const SECRET_FILES = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".my.cnf",
  ".htpasswd",
  ".git-credentials",
  ".gitcookies",
  ".dockercfg",
  ".envrc",
  ".vault-token",
  ".boto",
  ".s3cfg",
  "credentials",
  "credentials.json",
]);

/** Key and certificate stores, and Terraform state (which keeps secrets in clear), by extension. */
const SECRET_EXT = /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ppk|tfstate|tfstate\.backup)$/;
/** dotenv files hold secrets; their committed templates do not. */
const DOTENV = /^\.env(\..+)?$|\.env$/;
const DOTENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/;
/** ssh private keys and their copies (id_rsa, id_rsa.bak, id_rsa~); the .pub halves are public. */
const SSH_KEY = /^id_[a-z0-9_]+([.~].*)?$/;
const SERVICE_ACCOUNT = /^service-account.*\.json$/;

/** Code points that show as nothing (zero-width, joiners, direction marks, BOM, soft hyphen, variation selectors). */
function invisible(cp: number): boolean {
  return (
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0
  );
}

/** A name as the secret lists see it: composed, invisible characters dropped, lower case (".GIT\u200b" is ".git"). */
export function secretKey(name: string): string {
  return [...name.normalize("NFC")]
    .filter((ch) => !invisible(ch.codePointAt(0) ?? 0))
    .join("")
    .toLowerCase();
}

/** The name of a file or folder that is never listed, read, searched or diffed. */
export function isSecretName(name: string): boolean {
  const n = secretKey(name);
  if (SECRET_DIRS.has(n) || SECRET_FILES.has(n) || SECRET_EXT.test(n) || SERVICE_ACCOUNT.test(n)) return true;
  if (SSH_KEY.test(n) && !n.endsWith(".pub")) return true;
  return DOTENV.test(n) && !DOTENV_TEMPLATE.test(n);
}

/** Some part of a relative path ("/"-separated) is secret. */
export function isSecretPath(rel: string): boolean {
  return rel.split("/").some(isSecretName);
}

export function secretFileError(): AgentError {
  return new AgentError(ErrorCode.INVALID, "a secret file is never read", { reason: ErrorReason.SECRET_FILE });
}

/** Folders the machine holds sensitive (safety/sensitive-paths.ts), by absolute path. */
export type IsSensitive = (abs: string) => boolean;

const windows = process.platform === "win32";

/** The parts of a device's relative path; throws OutsideFolderError for anything but plain names. */
export function relParts(rel: string): string[] {
  if (rel === "") return [];
  if (rel.includes("\0") || rel.length > 4096) throw new OutsideFolderError();
  const slashed = windows ? rel.replaceAll("\\", "/") : rel;
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || isAbsolute(rel)) throw new OutsideFolderError();
  const parts = slashed.split("/");
  // Windows also reads "name:stream" (an alternate data stream) and drops trailing dots and spaces.
  if (parts.some((p) => p === "" || p === "." || p === ".." || (windows && (p.includes(":") || /[. ]$/.test(p))))) throw new OutsideFolderError();
  return parts;
}

/** `real` is `root` or below it (both real paths). */
export function within(root: string, real: string): boolean {
  const r = relative(root, real);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** A relative path from the workspace root with "/". */
export function toRel(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

/**
 * `rel` in the workspace whose real folder is `root`: its real path, which
 * must exist and lie inside the root, and which is no secret and in no
 * folder the machine holds sensitive, either as asked or as resolved.
 */
export async function resolveInside(root: string, rel: string, isSensitive: IsSensitive): Promise<{ parts: string[]; real: string }> {
  const parts = relParts(rel);
  const asked = join(root, ...parts);
  if (parts.some(isSecretName) || isSensitive(asked)) throw secretFileError();
  const real = await realpath(asked);
  if (!within(root, real)) throw new OutsideFolderError();
  if (isSecretPath(toRel(root, real)) || isSensitive(real)) throw secretFileError();
  return { parts, real };
}

/** A path git takes as a pathspec: plain parts, inside the workspace, outside git's own folder. */
export function gitPath(rel: string): string {
  const parts = relParts(rel);
  if (parts.length === 0) throw new OutsideFolderError();
  if (parts.some((p) => secretKey(p) === ".git")) throw secretFileError();
  return parts.join("/");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural order (9 before 10, case folded), ties broken by code point so the order is total. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

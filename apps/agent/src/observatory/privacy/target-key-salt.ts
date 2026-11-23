// The key that tells one file from another without naming it. A file tool's
// call keeps only `folder/name` as its label, which two `src/index.ts` of a
// monorepo share; `target_key` is an HMAC-SHA-256, under a salt of this
// machine, of the file's full path (home folder as `~`, forward slashes,
// lower case on Windows), cut to 16 bytes. The same file gives the same key
// from the SDK callbacks and the hook process, a different file a different
// one, and without the salt the key cannot be checked against a list of
// likely paths.
//
// The salt is 32 random bytes in the Observatory data folder (0600), made by
// the agent when missing and deleted with the database by a wipe; the hook
// process only reads it, and without it keeps no key. It is never exported.
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { tildePath } from "./home-and-account.ts";

export const TARGET_KEY_SALT_FILE = "target-key.salt";
const SALT_BYTES = 32;
const KEY_BYTES = 16;

const saltPath = (dataDir: string): string => join(dataDir, TARGET_KEY_SALT_FILE);

/** The salt, or undefined when there is none (or it cannot be read, or is not 32 bytes). */
export async function readTargetKeySalt(dataDir: string): Promise<Buffer | undefined> {
  try {
    const salt = await readFile(saltPath(dataDir));
    return salt.length === SALT_BYTES ? salt : undefined;
  } catch {
    return undefined;
  }
}

/** The salt, made (0600, never replacing one another process made first) when missing. */
export async function ensureTargetKeySalt(dataDir: string): Promise<Buffer> {
  const existing = await readTargetKeySalt(dataDir);
  if (existing) return existing;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A salt of the wrong size is replaced; a new one is only ever written whole.
  await rm(saltPath(dataDir), { force: true });
  try {
    await writeFile(saltPath(dataDir), randomBytes(SALT_BYTES), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const salt = await readTargetKeySalt(dataDir);
  if (!salt) throw new Error("the Observatory target key salt could not be read back");
  return salt;
}

/** Deletes the salt (with the database: the keys stored under it go too). */
export async function deleteTargetKeySalt(dataDir: string): Promise<void> {
  await rm(saltPath(dataDir), { force: true });
}

/** The path a key is made of: absolute (against `cwd`), home folder as `~`, forward slashes, lower case on Windows. */
export function targetKeyPath(path: string, home: string, cwd: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const paths = platform === "win32" ? win32 : posix;
  const absolute = paths.isAbsolute(path) ? path : cwd ? paths.resolve(cwd, path) : undefined;
  if (absolute === undefined) return undefined;
  const p = tildePath(absolute, home).replaceAll("\\", "/");
  return platform === "win32" ? p.toLowerCase() : p;
}

/** The key of `path` under `salt`: 32 hex characters; undefined for a relative path without a `cwd`. */
export function targetKeyOf(salt: Uint8Array, path: string, home: string, cwd: string | undefined): string | undefined {
  const normal = targetKeyPath(path, home, cwd);
  if (normal === undefined) return undefined;
  return createHmac("sha256", salt).update(normal, "utf8").digest().subarray(0, KEY_BYTES).toString("hex");
}

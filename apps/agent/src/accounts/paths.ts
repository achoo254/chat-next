// Where the saved accounts of every AI live, and the checks every path goes
// through before tunelo creates, links or deletes anything there. An account
// of an AI is <tunelo config>/ai-accounts/<provider>/<id>/; what the AI keeps
// inside it is the adapter's business. Paths are always derived from
// (provider, id), never read from a file.
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const ACCOUNT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** An AI id as the registry names it (ProviderInfo.id). */
export const PROVIDER_ID_RE = /^[a-z0-9-]{1,32}$/;

/** The folder holding every AI's accounts and ai-accounts.json. */
export function accountsRoot(configDir: string): string {
  return join(configDir, "ai-accounts");
}

/** The folder of one AI's accounts. */
export function providerAccountsRoot(configDir: string, provider: string): string {
  assertProviderId(provider);
  return join(accountsRoot(configDir), provider);
}

/** The folder of one account of an AI. */
export function accountDir(configDir: string, provider: string, id: string): string {
  assertAccountId(id);
  return join(providerAccountsRoot(configDir, provider), id);
}

export function assertAccountId(id: string): void {
  if (!ACCOUNT_ID_RE.test(id)) throw new Error("not an account id");
}

export function assertProviderId(provider: string): void {
  if (!PROVIDER_ID_RE.test(provider)) throw new Error("not an AI id");
}

const caseless = process.platform === "win32" || process.platform === "darwin";

export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** True when `child` is `parent` or inside it (no resolving of links). */
export function isInside(child: string, parent: string): boolean {
  const c = caseless ? resolve(child).toLowerCase() : resolve(child);
  const p = caseless ? resolve(parent).toLowerCase() : resolve(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuses a path under an AI's accounts folder that would mix with one of
 * the AI's own folders (`avoid`: inside it or holding it), and any link on
 * the way from the accounts root down to it: tunelo only ever writes and
 * deletes there.
 */
export function assertSafeAccountPath(configDir: string, provider: string, path: string, avoid: readonly string[] = []): void {
  for (const own of avoid) {
    if (isInside(path, own) || isInside(own, path)) throw new Error("an account folder may not be inside the AI's own folder or hold it");
  }
  const root = providerAccountsRoot(configDir, provider);
  if (!isInside(path, root) || samePath(path, root)) throw new Error("an account folder must be under ai-accounts");
  const parts = relative(accountsRoot(configDir), path).split(sep).filter(Boolean);
  let cur = accountsRoot(configDir);
  for (const part of ["", ...parts]) {
    cur = part === "" ? cur : join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // not created yet: nothing below it can be a link
    }
    if (st.isSymbolicLink()) throw new Error("an account folder may not be reached through a link");
    if (!st.isDirectory()) throw new Error("an account folder path holds a file");
  }
}

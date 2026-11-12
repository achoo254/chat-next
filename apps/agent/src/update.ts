// `tunelo update`: fetch the newest tunelo-v* release's archive for this
// platform (`tunelo-<os>-<arch>.tar.gz`, `tunelo-windows-x64.zip`), check its
// minisign signature (key built into this binary) and its SHA-256 (from the
// signed SHA256SUMS), unpack it in memory and check the signature of each of
// the two files inside, tunelo itself and tunelo-term-host (the terminal
// process), and only then replace anything: the terminal process goes into a
// folder named after its version (with its signature, which names that
// version) and is staged in `<config>/term-host/bin/next/`, where the agent's
// supervisor (terminal/host-supervisor.ts) switches to it once no terminal
// runs; then tunelo's own file is swapped (the previous one kept as
// `<file>.old`) and the service restarts itself. `tunelo update --rollback`
// puts the previous release back the same way, from that release's archive.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { z } from "zod";
import { AGENT_VERSION } from "./version.ts";

/** Public half of the release signing key (`minisign -G`). */
export const MINISIGN_PUBKEY = "RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D";
const REPO = "achoo254/chat-next";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
/** The checksums file of a release, signed like every other file. */
export const SUMS_FILE = "SHA256SUMS";

const b64 = (s: string) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Verifies a minisign signature (Ed25519, legacy or BLAKE2b-prehashed). */
export function verifyMinisign(file: Uint8Array, sigText: string, pubkey = MINISIGN_PUBKEY): boolean {
  const pk = b64(pubkey);
  const lines = sigText.split(/\r?\n/);
  const sigLine = lines[1];
  const trusted = lines[2] ?? "";
  const globalLine = lines[3];
  if (pk.length !== 42 || !sigLine || !globalLine || !trusted.startsWith("trusted comment: ")) return false;
  const sig = b64(sigLine);
  if (sig.length !== 74 || !same(sig.subarray(2, 10), pk.subarray(2, 10))) return false;
  const alg = String.fromCharCode(sig[0] ?? 0, sig[1] ?? 0);
  const msg = alg === "ED" ? blake2b(file, { dkLen: 64 }) : alg === "Ed" ? file : null;
  if (!msg) return false;
  const key = pk.subarray(10);
  const signature = sig.subarray(10);
  if (!ed25519.verify(signature, msg, key)) return false;
  const comment = new TextEncoder().encode(trusted.slice("trusted comment: ".length));
  const globalSig = b64(globalLine);
  const signed = new Uint8Array(signature.length + comment.length);
  signed.set(signature);
  signed.set(comment, signature.length);
  return ed25519.verify(globalSig, signed, key);
}

/** The trusted comment of a minisign signature (checked by verifyMinisign). */
export function trustedComment(sigText: string): string {
  const line = sigText.split(/\r?\n/)[2] ?? "";
  return line.startsWith("trusted comment: ") ? line.slice("trusted comment: ".length) : "";
}

/**
 * Tags of tunelo releases: `tunelo-v<semver>`; other release lines share the
 * repo. A test release (`tunelo-v3.0.0-rc.1`) does not match, so no machine
 * updates to it.
 */
const RELEASE_TAG = /^tunelo-v(\d+\.\d+\.\d+)$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export function assetName(os = platform(), cpu = arch()): string {
  if (os === "darwin") return `tunelo-darwin-${cpu === "arm64" ? "arm64" : "x64"}`;
  if (os === "win32") return "tunelo-windows-x64.exe";
  if (os === "linux") {
    if (cpu === "x64" || cpu === "arm64") return `tunelo-linux-${cpu}`;
    throw new Error(`no tunelo build for Linux on ${cpu}; there are builds for x64 and arm64`);
  }
  throw new Error(`no tunelo build for ${os}`);
}

/** The release file of the terminal process for the same platform as `assetName`. */
export function termHostAssetName(os = platform(), cpu = arch()): string {
  return assetName(os, cpu).replace(/^tunelo-/, "tunelo-term-host-");
}

/**
 * The file a release publishes for a platform: an archive holding
 * `assetName` and `termHostAssetName`, each next to its `.minisig`.
 */
export function archiveName(os = platform(), cpu = arch()): string {
  const binary = assetName(os, cpu);
  return os === "win32" ? binary.replace(/\.exe$/, ".zip") : `${binary}.tar.gz`;
}

/** A Node Buffer as a plain Uint8Array over the same memory (its `slice` copies, as the readers expect). */
const plain = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** A NUL-terminated text field of a tar header. */
function tarField(header: Uint8Array, from: number, length: number): string {
  const field = header.subarray(from, from + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

/** The regular files of a tar archive (ustar, as the release packs it), by name. */
function readTar(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((b) => b === 0)) break;
    const sizeText = tarField(header, 124, 12).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("a tar header has no valid size");
    const start = at + 512;
    if (start + size > tar.length) throw new Error("the tar archive is cut short");
    const type = tarField(header, 156, 1);
    if (type === "0" || type === "") {
      const prefix = tarField(header, 257, 6) === "ustar" ? tarField(header, 345, 155) : "";
      const name = (prefix ? `${prefix}/` : "") + tarField(header, 0, 100);
      files.set(name.replace(/^(\.\/)+/, ""), tar.slice(start, start + size));
    }
    at = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

const ZIP_END = 0x06054b50;
const ZIP_ENTRY = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

/** The files of a zip archive (stored or deflated, no zip64), by name. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u32 = (at: number) => (at >= 0 && at + 4 <= zip.length ? view.getUint32(at, true) : -1);
  const u16 = (at: number) => (at >= 0 && at + 2 <= zip.length ? view.getUint16(at, true) : -1);
  // The end record sits in the last 22 bytes plus at most a 64 KiB comment.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(i) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive");
  const files = new Map<string, Uint8Array>();
  const count = u16(end + 10);
  let at = u32(end + 16);
  for (let n = 0; n < count; n++) {
    if (u32(at) !== ZIP_ENTRY) throw new Error("the zip directory is damaged");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const packedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const local = u32(at + 42);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (flags & 1) throw new Error(`${name} is encrypted in the zip archive`);
    if (packedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 archives are not supported");
    if (u32(local) !== ZIP_LOCAL) throw new Error("the zip archive is damaged");
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + packedSize > zip.length) throw new Error("the zip archive is cut short");
    const packed = zip.subarray(start, start + packedSize);
    if (!name.endsWith("/")) {
      let bytes: Uint8Array;
      if (method === 0) bytes = packed.slice();
      else if (method === 8) bytes = plain(inflateRawSync(packed));
      else throw new Error(`${name} uses an unsupported zip compression (${method})`);
      if (bytes.length !== size) throw new Error(`${name} has the wrong size in the zip archive`);
      files.set(name, bytes);
    }
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  return files;
}

/** The files of a release archive (`archiveName`), by name. */
export function unpackArchive(name: string, bytes: Uint8Array): Map<string, Uint8Array> {
  return name.endsWith(".zip") ? readZip(bytes) : readTar(plain(gunzipSync(bytes)));
}

/** The trusted comment a release signs into each file's signature. */
export function signedComment(version: string, asset: string): string {
  return `tunelo ${version} ${asset}`;
}

/** File name to lowercase SHA-256, from `sha256sum` output (text or binary mode). */
export function parseSums(text: string): Map<string, string> {
  return new Map(
    text
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => {
        const [hash, name] = l.trim().split(/\s+\*?/);
        return [name ?? "", (hash ?? "").toLowerCase()] as const;
      }),
  );
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

const assetSchema = z.object({ name: z.string(), url: z.string(), browser_download_url: z.string(), size: z.number().optional() });
const releaseSchema = z.object({ tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), assets: z.array(assetSchema) });
type Asset = z.infer<typeof assetSchema>;
type Release = z.infer<typeof releaseSchema>;

/** The newest published tunelo release, with its version. */
export function newestRelease<R extends Omit<Release, "assets">>(releases: readonly R[]): { release: R; version: string } | null {
  let best: { release: R; version: string } | null = null;
  for (const r of releases) {
    const version = r.draft || r.prerelease ? undefined : RELEASE_TAG.exec(r.tag_name)?.[1];
    if (version && (!best || newer(version, best.version))) best = { release: r, version };
  }
  return best;
}

/** Called while a file downloads; `total` is 0 when the server did not say how big the file is. */
export type DownloadProgress = (received: number, total: number) => void;

/** What an update or a rollback works on; every field defaults to this running tunelo. */
export type UpdateEnv = {
  /** tunelo's config folder (TUNELO_HOME or the default). */
  configDir?: string;
  /** The running tunelo file, replaced by the update. */
  execPath?: string;
  /** The version of the running tunelo. */
  currentVersion?: string;
  os?: NodeJS.Platform;
  cpu?: NodeJS.Architecture;
  pubkey?: string;
  fetch?: typeof fetch;
  /** Where TUNELO_TERM_HOST_BIN is read from. */
  processEnv?: NodeJS.ProcessEnv;
};

type Resolved = {
  configDir: string;
  execPath: string;
  currentVersion: string;
  agentAsset: string;
  hostAsset: string;
  /** The release archive holding both. */
  archive: string;
  /** The terminal process's file name on this OS. */
  hostBinary: string;
  /** `<config>/term-host/bin`, where the supervisor looks for `current/` and `next/`. */
  binDir: string;
  /** `<config>/term-host/versions`, one folder per release version. */
  versionsDir: string;
  pubkey: string;
  fetch: typeof fetch;
};

async function resolveEnv(env: UpdateEnv): Promise<Resolved> {
  // Imported lazily: the pin scripts import this file under plain Node,
  // which cannot load these modules.
  const [{ configDir }, { termHostDir }, { TERM_HOST_BINARY }] = await Promise.all([
    import("./config.ts"),
    import("./terminal/host-link.ts"),
    import("./terminal/host-supervisor.ts"),
  ]);
  const dir = env.configDir ?? configDir();
  return {
    configDir: dir,
    execPath: env.execPath ?? process.execPath,
    currentVersion: env.currentVersion ?? AGENT_VERSION,
    agentAsset: assetName(env.os, env.cpu),
    hostAsset: termHostAssetName(env.os, env.cpu),
    archive: archiveName(env.os, env.cpu),
    hostBinary: TERM_HOST_BINARY,
    binDir: join(termHostDir(dir), "bin"),
    versionsDir: join(termHostDir(dir), "versions"),
    pubkey: env.pubkey ?? MINISIGN_PUBKEY,
    fetch: env.fetch ?? fetch,
  };
}

/** Reads a response body, reporting progress as the chunks arrive. */
async function readBody(res: Response, onProgress?: DownloadProgress): Promise<Uint8Array> {
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

/**
 * Downloads a release file. GitHub's public download link sometimes answers
 * 5xx for a while; those are retried, then the same file is fetched through
 * the API. Either way the signature check decides what gets installed.
 */
async function fetchBytes(get: typeof fetch, asset: Asset, onProgress?: DownloadProgress, tries = 3): Promise<Uint8Array> {
  let status = 0;
  for (let i = 1; i <= tries; i++) {
    const res = await get(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
    if (res.ok) return readBody(res, onProgress);
    status = res.status;
    if (status < 500) break;
    if (i < tries) await new Promise((r) => setTimeout(r, i * 2000));
  }
  const api = await get(asset.url, { headers: { accept: "application/octet-stream" }, signal: AbortSignal.timeout(300_000) });
  if (api.ok) return readBody(api, onProgress);
  throw new Error(`download failed (${status}, then ${api.status}): ${asset.browser_download_url}`);
}

async function listReleases(get: typeof fetch): Promise<Release[]> {
  // Other lines share the repo; a full page keeps the newest tunelo-v* in view.
  const res = await get(RELEASES_URL, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`cannot list releases (${res.status})`);
  const parsed = z.array(releaseSchema).safeParse(await res.json());
  if (!parsed.success) throw new Error("the release list has an unexpected shape");
  return parsed.data;
}

/** The newest tunelo release when it is newer than `current`. */
async function findUpdate(get: typeof fetch, current: string): Promise<{ release: Release; version: string } | null> {
  const found = newestRelease(await listReleases(get));
  return found && newer(found.version, current) ? found : null;
}

/** `tunelo update --check`: the newer version, or null when up to date. */
export async function checkForUpdate(env: UpdateEnv = {}): Promise<string | null> {
  return (await findUpdate(env.fetch ?? fetch, env.currentVersion ?? AGENT_VERSION))?.version ?? null;
}

function findAsset(release: Release, version: string, name: string): Asset {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`tunelo ${version} has no ${name} for this computer; nothing was installed`);
  return asset;
}

/** Throws unless `sigText` signs `bytes` with the release key, for exactly this file of this version. */
function checkSignature(bytes: Uint8Array, sigText: string, version: string, name: string, pubkey: string): void {
  if (!verifyMinisign(bytes, sigText, pubkey)) throw new Error(`signature check of ${name} failed; nothing was installed`);
  // The signed comment names the file and version, so an older signed build
  // cannot be served in place of this one.
  if (trustedComment(sigText) !== signedComment(version, name)) throw new Error(`the signature of ${name} is for another file or version; nothing was installed`);
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Writes a file and reads it back; throws (leaving nothing) when the bytes differ. */
function writeChecked(path: string, bytes: Uint8Array, mode: number): void {
  writeFileSync(path, bytes, { mode });
  if (!same(new Uint8Array(readFileSync(path)), bytes)) {
    rmSync(path, { force: true });
    throw new Error(`${path} did not write correctly`);
  }
}

/** The release version a terminal process folder holds, from its signature (empty when unknown). */
function folderVersion(folder: string, r: Resolved): string {
  try {
    const comment = trustedComment(readFileSync(join(folder, `${r.hostBinary}.minisig`), "utf8"));
    const [program, version, file] = comment.split(" ");
    return program === "tunelo" && version && VERSION.test(version) && file === r.hostAsset ? version : "";
  } catch {
    return "";
  }
}

/** Keeps a verified terminal process (and its signature) in `versions/<version>/`. */
function keepTermHostVersion(r: Resolved, version: string, bin: Uint8Array, sigText: string): void {
  const target = join(r.versionsDir, version);
  const partial = join(r.versionsDir, `${version}.partial`);
  mkdirSync(r.versionsDir, { recursive: true, mode: 0o700 });
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { mode: 0o700 });
  try {
    writeChecked(join(partial, r.hostBinary), bin, 0o755);
    writeFileSync(join(partial, `${r.hostBinary}.minisig`), sigText, { mode: 0o644 });
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
}

/** How `pointTermHostAt` moved the terminal process (an undo needs to know). */
type Pointed = "current" | "next" | "dropped";

/**
 * Points the terminal process at `version`. When `bin/current/` already holds
 * it, a staged `bin/next/` is dropped. When there is no `bin/current/` yet,
 * nothing runs from it, so `versions/<version>/` is copied straight there
 * (the supervisor finds it at once; a process running from tunelo's folder
 * keeps running until it exits). Otherwise it is copied into `bin/next/`,
 * which the supervisor switches to once no terminal runs, so open shells keep
 * the process they started in. Without that version folder, only a staged
 * `bin/next/` is dropped.
 */
function pointTermHostAt(r: Resolved, version: string): Pointed {
  const next = join(r.binDir, "next");
  const current = join(r.binDir, "current");
  const source = join(r.versionsDir, version);
  if (folderVersion(current, r) === version || !existsSync(join(source, r.hostBinary))) {
    rmSync(next, { recursive: true, force: true });
    return "dropped";
  }
  const pointed: Pointed = existsSync(current) ? "next" : "current";
  const target = pointed === "current" ? current : next;
  const partial = join(r.binDir, `${pointed}.partial`);
  mkdirSync(r.binDir, { recursive: true, mode: 0o700 });
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { mode: 0o700 });
  try {
    writeChecked(join(partial, r.hostBinary), new Uint8Array(readFileSync(join(source, r.hostBinary))), 0o755);
    writeFileSync(join(partial, `${r.hostBinary}.minisig`), readFileSync(join(source, `${r.hostBinary}.minisig`)), { mode: 0o644 });
    rmSync(next, { recursive: true, force: true });
    renameSync(partial, target);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  return pointed;
}

/** Undoes `pointTermHostAt` after tunelo's own file could not be swapped: back to `version`. */
function unpointTermHost(r: Resolved, pointed: Pointed, version: string, log: (l: string) => void): void {
  try {
    // A `bin/current/` made a moment ago: nothing started from it yet.
    if (pointed === "current") rmSync(join(r.binDir, "current"), { recursive: true, force: true });
    else pointTermHostAt(r, version);
  } catch (err) {
    log(`could not point the terminal process back at ${version} (${(err as Error).message})`);
  }
}

/** A terminal process this tunelo can find: named by the environment, in the config folder, or next to tunelo. */
function termHostPresent(r: Resolved, env: NodeJS.ProcessEnv): boolean {
  if (env.TUNELO_TERM_HOST_BIN) return true;
  return [join(r.binDir, "current"), join(r.binDir, "next"), join(r.versionsDir, r.currentVersion), dirname(r.execPath)].some((dir) =>
    existsSync(join(dir, r.hostBinary)),
  );
}

/** One update or rollback at a time per config folder (the CLI and a device may both start one). */
async function withUpdateLock<T>(r: Resolved, run: () => Promise<T>): Promise<T> {
  const lock = join(r.configDir, "update.lock");
  mkdirSync(r.configDir, { recursive: true, mode: 0o700 });
  if (!createLock(lock)) {
    const holder = readLockHolder(lock);
    if (holder && processAlive(holder.pid) && Date.now() - holder.at < LOCK_STALE_MS) {
      throw new Error(`another tunelo update or rollback is running (pid ${holder.pid}); try again when it is done`);
    }
    // Left by a process that is gone, or one stuck far longer than any download.
    rmSync(lock, { force: true });
    if (!createLock(lock)) throw new Error("another tunelo update or rollback is running; try again when it is done");
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Creates the lock file; false when it already exists. */
function createLock(lock: string): boolean {
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** A lock older than this is stale even when its pid was reused by another process. */
const LOCK_STALE_MS = 60 * 60 * 1000;
const lockSchema = z.object({ pid: z.number().int().positive(), at: z.number() });

function readLockHolder(lock: string): z.infer<typeof lockSchema> | undefined {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(readFileSync(lock, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Only the versions an update or a rollback may still need stay on disk. */
function pruneTermHostVersions(r: Resolved, keep: readonly string[]): void {
  let names: string[];
  try {
    names = readdirSync(r.versionsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.includes(name)) continue;
    try {
      rmSync(join(r.versionsDir, name), { recursive: true, force: true });
    } catch {
      // A locked file (Windows); the next update tries again.
    }
  }
}

const rollbackSchema = z.object({ from: z.string().regex(VERSION), to: z.string().regex(VERSION) });
type RollbackRecord = z.infer<typeof rollbackSchema>;
const rollbackFile = (r: Resolved) => join(r.configDir, "update-rollback.json");

function writeRollbackRecord(r: Resolved, record: RollbackRecord): void {
  const file = rollbackFile(r);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function readRollbackRecord(r: Resolved): RollbackRecord | undefined {
  try {
    const parsed = rollbackSchema.safeParse(JSON.parse(readFileSync(rollbackFile(r), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Removes a file tunelo replaced; Windows keeps it locked while it still runs, so the next update tries again. */
function removeIfUnlocked(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // still running (Windows)
  }
}

/**
 * Swaps tunelo's file for `incoming` (a file next to it), keeping the running
 * one as `aside`. A running executable cannot be overwritten on Windows, but
 * it can be renamed; a failed swap puts the running file back.
 */
function swapAgent(exe: string, incoming: string, aside: string): void {
  rmSync(aside, { force: true });
  renameSync(exe, aside);
  try {
    renameSync(incoming, exe);
  } catch (err) {
    renameSync(aside, exe);
    throw err;
  }
}

type Verified = { agent: Uint8Array; host: Uint8Array; hostSig: string };

/** One file of an unpacked release archive; throws when the archive lacks it. */
function archiveEntry(files: Map<string, Uint8Array>, r: Resolved, version: string, name: string): Uint8Array {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`${r.archive} of tunelo ${version} has no ${name}; nothing was installed`);
  return bytes;
}

/**
 * Downloads this platform's archive of `version`, its signature and the
 * signed SHA256SUMS; checks the archive against both, unpacks it in memory
 * and checks the signature of tunelo and of its terminal process inside.
 * Nothing on disk changes here.
 */
async function downloadVerified(
  r: Resolved,
  release: Release,
  version: string,
  log: (l: string) => void,
  onProgress?: DownloadProgress,
  onPhase?: (phase: "verifying" | "installing") => void,
): Promise<Verified> {
  const archive = findAsset(release, version, r.archive);
  const text = (name: string) => fetchBytes(r.fetch, findAsset(release, version, name)).then(decode);
  const [archiveSig, sumsSig, sums] = await Promise.all([text(`${r.archive}.minisig`), text(`${SUMS_FILE}.minisig`), text(SUMS_FILE)]);

  log(`downloading tunelo ${version}…`);
  const bytes = await fetchBytes(r.fetch, archive, onProgress && ((received, total) => onProgress(received, archive.size ?? total)));

  onPhase?.("verifying");
  checkSignature(new TextEncoder().encode(sums), sumsSig, version, SUMS_FILE, r.pubkey);
  checkSignature(bytes, archiveSig, version, r.archive, r.pubkey);
  if (parseSums(sums).get(r.archive) !== sha256(bytes)) throw new Error(`${r.archive} does not match its SHA-256 in ${SUMS_FILE}; nothing was installed`);
  let files: Map<string, Uint8Array>;
  try {
    files = unpackArchive(r.archive, bytes);
  } catch (err) {
    throw new Error(`${r.archive} could not be unpacked (${(err as Error).message}); nothing was installed`, { cause: err });
  }
  // Each file keeps its own signature: the terminal process's names its
  // version, which the supervisor and a later update read from disk.
  const agent = archiveEntry(files, r, version, r.agentAsset);
  const host = archiveEntry(files, r, version, r.hostAsset);
  const hostSig = decode(archiveEntry(files, r, version, `${r.hostAsset}.minisig`));
  checkSignature(agent, decode(archiveEntry(files, r, version, `${r.agentAsset}.minisig`)), version, r.agentAsset, r.pubkey);
  checkSignature(host, hostSig, version, r.hostAsset, r.pubkey);
  return { agent, host, hostSig };
}

/**
 * The running release's own terminal process, when this machine has none
 * (the file was removed). Returns true when it installed it.
 */
async function repairTermHost(
  r: Resolved,
  releases: readonly Release[],
  log: (l: string) => void,
  onProgress?: DownloadProgress,
  onPhase?: (phase: "verifying" | "installing") => void,
): Promise<boolean> {
  const release = releases.find((x) => x.tag_name === `tunelo-v${r.currentVersion}`);
  // Not published (a development build).
  if (!release?.assets.some((a) => a.name === r.archive)) return false;
  log(`the terminal process of tunelo ${r.currentVersion} is missing; installing it again`);
  const verified = await downloadVerified(r, release, r.currentVersion, log, onProgress, onPhase);
  onPhase?.("installing");
  keepTermHostVersion(r, r.currentVersion, verified.host, verified.hostSig);
  pointTermHostAt(r, r.currentVersion);
  return true;
}

/**
 * Returns the version whose files were installed, or null when nothing
 * changed. That is a newer release, or this release itself when only its
 * terminal process was missing; either way the caller restarts tunelo so it
 * finds the new files.
 */
export async function update(
  log: (l: string) => void,
  onProgress?: DownloadProgress,
  onPhase?: (phase: "verifying" | "installing") => void,
  env: UpdateEnv = {},
): Promise<string | null> {
  const r = await resolveEnv(env);
  return withUpdateLock(r, async () => {
    const releases = await listReleases(r.fetch);
    const found = newestRelease(releases);
    if (!found || !newer(found.version, r.currentVersion)) {
      if (termHostPresent(r, env.processEnv ?? process.env)) return null;
      return (await repairTermHost(r, releases, log, onProgress, onPhase)) ? r.currentVersion : null;
    }
    const { release, version } = found;
    const verified = await downloadVerified(r, release, version, log, onProgress, onPhase);

    // Both files are verified: from here on files change.
    onPhase?.("installing");
    const exe = r.execPath;
    const next = `${exe}.new`;
    keepTermHostVersion(r, version, verified.host, verified.hostSig);
    try {
      writeChecked(next, verified.agent, 0o755);
    } catch {
      throw new Error("the new file did not write correctly; kept the old one");
    }
    removeIfUnlocked(`${exe}.rollback`);
    const pointed = pointTermHostAt(r, version);
    try {
      swapAgent(exe, next, `${exe}.old`);
    } catch (err) {
      rmSync(next, { force: true });
      // The terminal process goes back to the release of the running tunelo.
      unpointTermHost(r, pointed, r.currentVersion, log);
      throw err;
    }
    try {
      writeRollbackRecord(r, { from: r.currentVersion, to: version });
    } catch (err) {
      // The update itself is done; only `--rollback` is not available for it.
      log(`could not record the previous version for \`tunelo update --rollback\` (${(err as Error).message})`);
    }
    pruneTermHostVersions(r, [version, r.currentVersion]);
    return version;
  });
}

/**
 * `tunelo update --rollback`: puts back the release the last `tunelo update`
 * replaced. That release's archive is downloaded and checked again, and the
 * kept `.old` file must be byte for byte the signed tunelo inside it, before
 * anything changes; then the terminal process is pointed back (it switches
 * once no terminal runs) and tunelo's `.old` file is restored. The caller
 * restarts the service. Returns the version now installed.
 */
export async function rollback(log: (l: string) => void, env: UpdateEnv = {}): Promise<string> {
  const r = await resolveEnv(env);
  return withUpdateLock(r, () => rollbackLocked(r, log));
}

async function rollbackLocked(r: Resolved, log: (l: string) => void): Promise<string> {
  const record = readRollbackRecord(r);
  if (!record) throw new Error("there is nothing to roll back: no update by `tunelo update` is recorded on this machine");
  const exe = r.execPath;
  const old = `${exe}.old`;
  let oldBytes: Uint8Array;
  try {
    oldBytes = new Uint8Array(readFileSync(old));
  } catch {
    throw new Error(`the previous tunelo (${old}) is gone; install ${record.from} with the install script instead`);
  }
  const release = (await listReleases(r.fetch)).find((x) => x.tag_name === `tunelo-v${record.from}`);
  if (!release) throw new Error(`tunelo ${record.from} is no longer published; nothing was changed`);

  const previous = await downloadVerified(r, release, record.from, log);
  if (!same(oldBytes, previous.agent)) throw new Error(`${old} is not the signed tunelo ${record.from}; nothing was changed`);

  keepTermHostVersion(r, record.from, previous.host, previous.hostSig);
  const pointed = pointTermHostAt(r, record.from);
  try {
    swapAgent(exe, old, `${exe}.rollback`);
  } catch (err) {
    // tunelo stays on the newer release, so its terminal process does too.
    unpointTermHost(r, pointed, record.to, log);
    throw err;
  }
  removeIfUnlocked(`${exe}.rollback`);
  rmSync(rollbackFile(r), { force: true });
  return record.from;
}

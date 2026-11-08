// `tunelo update`: fetch the newest tunelo-v* release, check its minisign
// signature against the key built into this binary, replace the file and
// let the service restart itself. (The Tunelo CLI 1.x updated through npm;
// tunelo has one way: this signed binary.)
//
// The same repo also holds the agent-v* releases of hda, the earlier name.
// hda 0.2.x only looks there (assets hda-*, comment "hda <version> <asset>"),
// so its last release, agent-v0.3.0, carries the tunelo 2.0.0 binary under
// those names; that binary moves the install to tunelo (migrate-from-hda.ts).
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { AGENT_VERSION } from "./version.ts";

/** Public half of the release signing key (`minisign -G`). */
export const MINISIGN_PUBKEY = "RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D";
const REPO = "achoo254/chat-next";

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

/** A line of releases: its file names and its tags (`<tagPrefix><semver>`). */
export type ReleaseLine = { readonly name: "tunelo" | "hda"; readonly tagPrefix: string };
export const TUNELO_RELEASES: ReleaseLine = { name: "tunelo", tagPrefix: "tunelo-v" };
export const HDA_RELEASES: ReleaseLine = { name: "hda", tagPrefix: "agent-v" };

export function assetName(os = platform(), cpu = arch(), line = TUNELO_RELEASES): string {
  if (os === "darwin") return `${line.name}-darwin-${cpu === "arm64" ? "arm64" : "x64"}`;
  if (os === "win32") return `${line.name}-windows-x64.exe`;
  throw new Error(`no ${line.name} build for this OS`);
}

/** The trusted comment a release signs into each file's signature. */
export function signedComment(line: ReleaseLine, version: string, asset: string): string {
  return `${line.name} ${version} ${asset}`;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

type Asset = { name: string; url: string; browser_download_url: string };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] };

/** The newest published release of a line, with its version. */
export function newestRelease<R extends Omit<Release, "assets">>(releases: readonly R[], line: ReleaseLine): { release: R; version: string } | null {
  const tag = new RegExp(`^${line.tagPrefix}(\\d+\\.\\d+\\.\\d+)$`);
  let best: { release: R; version: string } | null = null;
  for (const r of releases) {
    const version = r.draft || r.prerelease ? undefined : tag.exec(r.tag_name)?.[1];
    if (version && (!best || newer(version, best.version))) best = { release: r, version };
  }
  return best;
}

/**
 * Downloads a release file. GitHub's public download link sometimes answers
 * 5xx for a while; those are retried, then the same file is fetched through
 * the API. Either way the signature check decides what gets installed.
 */
async function fetchBytes(asset: Asset, tries = 3): Promise<Uint8Array> {
  let status = 0;
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    status = res.status;
    if (status < 500) break;
    if (i < tries) await new Promise((r) => setTimeout(r, i * 2000));
  }
  const api = await fetch(asset.url, { headers: { accept: "application/octet-stream" }, signal: AbortSignal.timeout(300_000) });
  if (api.ok) return new Uint8Array(await api.arrayBuffer());
  throw new Error(`download failed (${status}, then ${api.status}): ${asset.browser_download_url}`);
}

/** The newest tunelo release when it is newer than this binary. */
async function findUpdate(): Promise<{ release: Release; version: string } | null> {
  // Other lines share the repo; a full page keeps the newest tunelo-v* in view.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`cannot list releases (${res.status})`);
  const found = newestRelease((await res.json()) as Release[], TUNELO_RELEASES);
  return found && newer(found.version, AGENT_VERSION) ? found : null;
}

/** `tunelo update --check`: the newer version, or null when up to date. */
export async function checkForUpdate(): Promise<string | null> {
  return (await findUpdate())?.version ?? null;
}

/** Returns the installed version, or null when already up to date. */
export async function update(log: (l: string) => void): Promise<string | null> {
  const line = TUNELO_RELEASES;
  const found = await findUpdate();
  if (!found) return null;
  const { release, version: latest } = found;
  const asset = assetName(platform(), arch(), line);
  const file = release.assets.find((a) => a.name === asset);
  const sigFile = release.assets.find((a) => a.name === `${asset}.minisig`);
  if (!file || !sigFile) throw new Error(`${line.name} ${latest} has no ${asset} for this computer`);
  log(`downloading ${line.name} ${latest}…`);
  const [bin, sig] = await Promise.all([fetchBytes(file), fetchBytes(sigFile)]);
  const sigText = new TextDecoder().decode(sig);
  if (!verifyMinisign(bin, sigText)) throw new Error("signature check failed; the download was not installed");
  // The signed comment names the file and version, so an older signed build
  // cannot be served in place of this one.
  if (trustedComment(sigText) !== signedComment(line, latest, asset)) throw new Error("the signature is for another file or version; not installed");
  const exe = process.execPath;
  const next = `${exe}.new`;
  const old = `${exe}.old`;
  writeFileSync(next, bin, { mode: 0o755 });
  if (!same(new Uint8Array(readFileSync(next)), bin)) {
    rmSync(next, { force: true });
    throw new Error("the new file did not write correctly; kept the old one");
  }
  rmSync(old, { force: true });
  // A running executable cannot be overwritten on Windows, but it can be renamed.
  renameSync(exe, old);
  try {
    renameSync(next, exe);
  } catch (err) {
    renameSync(old, exe);
    throw err;
  }
  return latest;
}

// `hda update`: fetch the newest agent-v* release, check its minisign
// signature against the key built into this binary, replace the file and
// let the service restart itself.
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

export function assetName(os = platform(), cpu = arch()): string {
  if (os === "darwin") return `hda-darwin-${cpu === "arm64" ? "arm64" : "x64"}`;
  if (os === "win32") return "hda-windows-x64.exe";
  throw new Error("no hda build for this OS");
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

type Asset = { name: string; url: string; browser_download_url: string };

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

/** Returns the installed version, or null when already up to date. */
export async function update(log: (l: string) => void): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`cannot list releases (${res.status})`);
  const releases = (await res.json()) as { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] }[];
  const release = releases
    .filter((r) => !r.draft && !r.prerelease && /^agent-v\d+\.\d+\.\d+$/.test(r.tag_name))
    .sort((a, b) => (newer(a.tag_name.slice("agent-v".length), b.tag_name.slice("agent-v".length)) ? -1 : 1))[0];
  const latest = release?.tag_name.slice("agent-v".length);
  if (!release || !latest || !newer(latest, AGENT_VERSION)) return null;
  const asset = assetName();
  const file = release.assets.find((a) => a.name === asset);
  const sigFile = release.assets.find((a) => a.name === `${asset}.minisig`);
  if (!file || !sigFile) throw new Error(`hda ${latest} has no ${asset} for this computer`);
  log(`downloading hda ${latest}…`);
  const [bin, sig] = await Promise.all([fetchBytes(file), fetchBytes(sigFile)]);
  const sigText = new TextDecoder().decode(sig);
  if (!verifyMinisign(bin, sigText)) throw new Error("signature check failed; the download was not installed");
  // The signed comment names the file and version, so an older signed build
  // cannot be served in place of this one.
  if (trustedComment(sigText) !== `hda ${latest} ${asset}`) throw new Error("the signature is for another file or version; not installed");
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

// The pins of the install scripts for one tunelo release: version, SHA-256 of
// each released file (from the release's SHA256SUMS) and the minisign key.
// Every platform gets two files: tunelo and tunelo-term-host (the terminal
// process). Pure text in, text out; pin-release.ts reads and writes the files.
import { MINISIGN_PUBKEY, assetName, parseSums, termHostAssetName } from "../src/update.ts";

export interface InstallScripts {
  /** apps/web/public/agent/install.sh (macOS, Linux) */
  sh: string;
  /** apps/web/public/agent/install.ps1 (Windows) */
  ps1: string;
}

const PLATFORMS = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
] as const;

/** Every file a release must list in SHA256SUMS for the install scripts. */
export const PINNED_ASSETS = [...PLATFORMS.map(([os, cpu]) => assetName(os, cpu)), ...PLATFORMS.map(([os, cpu]) => termHostAssetName(os, cpu))] as const;

function replaceAll(file: string, text: string, pairs: readonly (readonly [RegExp, string])[]): string {
  let s = text;
  for (const [re, value] of pairs) {
    if (!re.test(s)) throw new Error(`${file}: ${re} not found`);
    s = s.replace(re, value);
  }
  return s;
}

/** The scripts pinned to `version`; throws when a file lacks its SHA-256 or a pin line is missing. */
export function pinInstallScripts(version: string, sumsText: string, scripts: InstallScripts): InstallScripts {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version}`);
  const sums = parseSums(sumsText);
  const need = (name: string): string => {
    const h = sums.get(name);
    if (!h || !/^[0-9a-f]{64}$/.test(h)) throw new Error(`no SHA-256 for ${name}`);
    return h;
  };
  const shPin = (variable: string, file: string) => [new RegExp(`^${variable}=".*"$`, "m"), `${variable}="${need(file)}"`] as const;
  const sh = replaceAll("install.sh", scripts.sh, [
    [/^TUNELO_VERSION=".*"$/m, `TUNELO_VERSION="${version}"`],
    shPin("SHA256_DARWIN_ARM64", assetName("darwin", "arm64")),
    shPin("SHA256_DARWIN_X64", assetName("darwin", "x64")),
    shPin("SHA256_LINUX_X64", assetName("linux", "x64")),
    shPin("SHA256_LINUX_ARM64", assetName("linux", "arm64")),
    shPin("SHA256_TERM_HOST_DARWIN_ARM64", termHostAssetName("darwin", "arm64")),
    shPin("SHA256_TERM_HOST_DARWIN_X64", termHostAssetName("darwin", "x64")),
    shPin("SHA256_TERM_HOST_LINUX_X64", termHostAssetName("linux", "x64")),
    shPin("SHA256_TERM_HOST_LINUX_ARM64", termHostAssetName("linux", "arm64")),
    [/^MINISIGN_PUBKEY=".*"$/m, `MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`],
  ]);
  const ps1 = replaceAll("install.ps1", scripts.ps1, [
    [/^\$TuneloVersion = '.*'$/m, `$TuneloVersion = '${version}'`],
    [/^\$Sha256WindowsX64 = '.*'$/m, `$Sha256WindowsX64 = '${need(assetName("win32", "x64"))}'`],
    [/^\$Sha256TermHostWindowsX64 = '.*'$/m, `$Sha256TermHostWindowsX64 = '${need(termHostAssetName("win32", "x64"))}'`],
    [/^\$MinisignPubKey = '.*'$/m, `$MinisignPubKey = '${MINISIGN_PUBKEY}'`],
  ]);
  return { sh, ps1 };
}

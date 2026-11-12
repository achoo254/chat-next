// The pins of the install scripts for one tunelo release: version, SHA-256 of
// each platform's archive (from the release's SHA256SUMS) and the minisign
// key. An archive holds tunelo and tunelo-term-host (the terminal process),
// each with its signature. Pure text in, text out; pin-release.ts reads and
// writes the files.
import { MINISIGN_PUBKEY, archiveName, parseSums } from "../src/update.ts";

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
export const PINNED_ASSETS = PLATFORMS.map(([os, cpu]) => archiveName(os, cpu));

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
    shPin("SHA256_DARWIN_ARM64", archiveName("darwin", "arm64")),
    shPin("SHA256_DARWIN_X64", archiveName("darwin", "x64")),
    shPin("SHA256_LINUX_X64", archiveName("linux", "x64")),
    shPin("SHA256_LINUX_ARM64", archiveName("linux", "arm64")),
    [/^MINISIGN_PUBKEY=".*"$/m, `MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`],
  ]);
  // install.ps1 runs inside `& { … }`, so its pin lines are indented.
  const psPin = (variable: string, value: string) => [new RegExp(`^([ \\t]*)\\$${variable} = '.*'$`, "m"), `$1$$${variable} = '${value}'`] as const;
  const ps1 = replaceAll("install.ps1", scripts.ps1, [
    psPin("TuneloVersion", version),
    psPin("Sha256WindowsX64", need(archiveName("win32", "x64"))),
    psPin("MinisignPubKey", MINISIGN_PUBKEY),
  ]);
  return { sh, ps1 };
}

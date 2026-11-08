// Pins the install scripts to a published hda release: version,
// SHA-256 of each file (from the release's SHA256SUMS) and the minisign key.
//   node apps/agent/scripts/pin-release.ts <version> <SHA256SUMS file>
// Commit and push the result; the web deploy then serves the new scripts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MINISIGN_PUBKEY } from "../src/update.ts";

const [version, sumsFile] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !sumsFile) {
  console.error("usage: pin-release.ts <version> <SHA256SUMS>");
  process.exit(1);
}
const sums = new Map(
  readFileSync(sumsFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [hash, name] = l.trim().split(/\s+\*?/);
      return [name ?? "", (hash ?? "").toLowerCase()] as const;
    }),
);
const need = (name: string) => {
  const h = sums.get(name);
  if (!h || !/^[0-9a-f]{64}$/.test(h)) throw new Error(`no SHA-256 for ${name}`);
  return h;
};
const dir = join(import.meta.dirname, "..", "..", "web", "public", "agent");
const set = (file: string, pairs: [RegExp, string][]) => {
  let s = readFileSync(join(dir, file), "utf8");
  for (const [re, value] of pairs) {
    if (!re.test(s)) throw new Error(`${file}: ${re} not found`);
    s = s.replace(re, value);
  }
  writeFileSync(join(dir, file), s);
};
set("install.sh", [
  [/^AGENT_VERSION=".*"$/m, `AGENT_VERSION="${version}"`],
  [/^SHA256_DARWIN_ARM64=".*"$/m, `SHA256_DARWIN_ARM64="${need("hda-darwin-arm64")}"`],
  [/^SHA256_DARWIN_X64=".*"$/m, `SHA256_DARWIN_X64="${need("hda-darwin-x64")}"`],
  [/^MINISIGN_PUBKEY=".*"$/m, `MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`],
]);
set("install.ps1", [
  [/^\$AgentVersion = '.*'$/m, `$AgentVersion = '${version}'`],
  [/^\$Sha256WindowsX64 = '.*'$/m, `$Sha256WindowsX64 = '${need("hda-windows-x64.exe")}'`],
  [/^\$MinisignPubKey = '.*'$/m, `$MinisignPubKey = '${MINISIGN_PUBKEY}'`],
]);
console.log(`install scripts pinned to hda ${version}`);

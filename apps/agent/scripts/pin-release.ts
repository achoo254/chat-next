// Pins the install scripts to a published tunelo release (tag tunelo-v<version>): version,
// SHA-256 of each file, tunelo and tunelo-term-host for every platform (from
// the release's SHA256SUMS), and the minisign key.
//   node apps/agent/scripts/pin-release.ts <version> <SHA256SUMS file>
// Commit and push the result; the web deploy then serves the new scripts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinInstallScripts } from "./pin-install-scripts.ts";

const [version, sumsFile] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !sumsFile) {
  console.error("usage: pin-release.ts <version> <SHA256SUMS>");
  process.exit(1);
}
const dir = join(import.meta.dirname, "..", "..", "web", "public", "agent");
const shFile = join(dir, "install.sh");
const ps1File = join(dir, "install.ps1");
// Both are checked before either is written, so a missing file changes nothing.
const pinned = pinInstallScripts(version, readFileSync(sumsFile, "utf8"), { sh: readFileSync(shFile, "utf8"), ps1: readFileSync(ps1File, "utf8") });
writeFileSync(shFile, pinned.sh);
writeFileSync(ps1File, pinned.ps1);
console.log(`install scripts pinned to tunelo ${version}`);

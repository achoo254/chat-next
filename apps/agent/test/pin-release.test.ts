// The install scripts are pinned to every archive of a release: both macOS
// builds, both Linux builds and the Windows build, each holding tunelo and
// tunelo-term-host (the terminal process).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_ASSETS, pinInstallScripts } from "../scripts/pin-install-scripts.ts";
import { MINISIGN_PUBKEY } from "../src/update.ts";

const agentDir = join(import.meta.dirname, "..", "..", "web", "public", "agent");
const scripts = { sh: readFileSync(join(agentDir, "install.sh"), "utf8"), ps1: readFileSync(join(agentDir, "install.ps1"), "utf8") };
const hashOf = (i: number) => (i + 1).toString(16).repeat(64);
const sums = PINNED_ASSETS.map((name, i) => `${hashOf(i)}  ${name}`).join("\n") + "\n";
const line = (text: string, name: string) => text.split("\n").map((l) => l.trim()).find((l) => l.startsWith(name)) ?? "";
const sha = (name: string) => hashOf(PINNED_ASSETS.indexOf(name));

describe("pin-release", () => {
  it("names the five released archives", () => {
    expect([...PINNED_ASSETS].sort()).toEqual([
      "tunelo-darwin-arm64.tar.gz",
      "tunelo-darwin-x64.tar.gz",
      "tunelo-linux-arm64.tar.gz",
      "tunelo-linux-x64.tar.gz",
      "tunelo-windows-x64.zip",
    ]);
  });

  it("pins the version, the key and the SHA-256 of every archive", () => {
    const pinned = pinInstallScripts("9.8.7", sums, scripts);
    expect(line(pinned.sh, "TUNELO_VERSION=")).toBe('TUNELO_VERSION="9.8.7"');
    expect(line(pinned.sh, "SHA256_DARWIN_ARM64=")).toBe(`SHA256_DARWIN_ARM64="${sha("tunelo-darwin-arm64.tar.gz")}"`);
    expect(line(pinned.sh, "SHA256_DARWIN_X64=")).toBe(`SHA256_DARWIN_X64="${sha("tunelo-darwin-x64.tar.gz")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_X64=")).toBe(`SHA256_LINUX_X64="${sha("tunelo-linux-x64.tar.gz")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_ARM64=")).toBe(`SHA256_LINUX_ARM64="${sha("tunelo-linux-arm64.tar.gz")}"`);
    expect(line(pinned.sh, "MINISIGN_PUBKEY=")).toBe(`MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`);
    expect(line(pinned.ps1, "$TuneloVersion =")).toBe("$TuneloVersion = '9.8.7'");
    expect(line(pinned.ps1, "$Sha256WindowsX64 =")).toBe(`$Sha256WindowsX64 = '${sha("tunelo-windows-x64.zip")}'`);
    expect(line(pinned.ps1, "$MinisignPubKey =")).toBe(`$MinisignPubKey = '${MINISIGN_PUBKEY}'`);
  });

  it("keeps the indentation of the PowerShell pins and changes nothing else", () => {
    const pinned = pinInstallScripts("9.8.7", sums, scripts);
    expect(pinned.ps1).toContain("\n\t$TuneloVersion = '9.8.7'\n");
    const others = (text: string) => text.split("\n").filter((l) => !/^\s*\$(TuneloVersion|Sha256WindowsX64|MinisignPubKey) = /.test(l));
    expect(others(pinned.ps1)).toEqual(others(scripts.ps1));
    const shOthers = (text: string) => text.split("\n").filter((l) => !/^(TUNELO_VERSION|SHA256_[A-Z0-9_]+|MINISIGN_PUBKEY)=/.test(l));
    expect(shOthers(pinned.sh)).toEqual(shOthers(scripts.sh));
  });

  it("refuses a SHA256SUMS without a Linux archive", () => {
    const withoutArm = sums
      .split("\n")
      .filter((l) => !l.endsWith("tunelo-linux-arm64.tar.gz"))
      .join("\n");
    expect(() => pinInstallScripts("9.8.7", withoutArm, scripts)).toThrow("no SHA-256 for tunelo-linux-arm64.tar.gz");
  });

  it("refuses a SHA256SUMS without the Windows archive", () => {
    const withoutWindows = sums
      .split("\n")
      .filter((l) => !l.endsWith("tunelo-windows-x64.zip"))
      .join("\n");
    expect(() => pinInstallScripts("9.8.7", withoutWindows, scripts)).toThrow("no SHA-256 for tunelo-windows-x64.zip");
  });

  it("refuses a test release version", () => {
    expect(() => pinInstallScripts("3.0.0-rc.1", sums, scripts)).toThrow("not a version: 3.0.0-rc.1");
  });

  it("refuses a script without a pin line", () => {
    const sh = scripts.sh.replace(/^SHA256_LINUX_X64=.*$/m, "");
    expect(() => pinInstallScripts("9.8.7", sums, { ...scripts, sh })).toThrow(/install\.sh: .*SHA256_LINUX_X64/);
    const ps1 = scripts.ps1.replace(/^\s*\$Sha256WindowsX64 = .*$/m, "");
    expect(() => pinInstallScripts("9.8.7", sums, { ...scripts, ps1 })).toThrow(/install\.ps1: .*Sha256WindowsX64/);
  });
});

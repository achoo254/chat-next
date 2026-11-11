// The install scripts are pinned to every file of a release: both macOS
// builds, both Linux builds and the Windows build, each of tunelo and of
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
const line = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(name)) ?? "";

describe("pin-release", () => {
  it("names the ten released files", () => {
    expect([...PINNED_ASSETS].sort()).toEqual([
      "tunelo-darwin-arm64",
      "tunelo-darwin-x64",
      "tunelo-linux-arm64",
      "tunelo-linux-x64",
      "tunelo-term-host-darwin-arm64",
      "tunelo-term-host-darwin-x64",
      "tunelo-term-host-linux-arm64",
      "tunelo-term-host-linux-x64",
      "tunelo-term-host-windows-x64.exe",
      "tunelo-windows-x64.exe",
    ]);
  });

  it("pins the version, the key and the SHA-256 of every file", () => {
    const pinned = pinInstallScripts("9.8.7", sums, scripts);
    const sha = (name: string) => hashOf(PINNED_ASSETS.indexOf(name as (typeof PINNED_ASSETS)[number]));
    expect(line(pinned.sh, "TUNELO_VERSION=")).toBe('TUNELO_VERSION="9.8.7"');
    expect(line(pinned.sh, "SHA256_DARWIN_ARM64=")).toBe(`SHA256_DARWIN_ARM64="${sha("tunelo-darwin-arm64")}"`);
    expect(line(pinned.sh, "SHA256_DARWIN_X64=")).toBe(`SHA256_DARWIN_X64="${sha("tunelo-darwin-x64")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_X64=")).toBe(`SHA256_LINUX_X64="${sha("tunelo-linux-x64")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_ARM64=")).toBe(`SHA256_LINUX_ARM64="${sha("tunelo-linux-arm64")}"`);
    expect(line(pinned.sh, "SHA256_TERM_HOST_DARWIN_ARM64=")).toBe(`SHA256_TERM_HOST_DARWIN_ARM64="${sha("tunelo-term-host-darwin-arm64")}"`);
    expect(line(pinned.sh, "SHA256_TERM_HOST_DARWIN_X64=")).toBe(`SHA256_TERM_HOST_DARWIN_X64="${sha("tunelo-term-host-darwin-x64")}"`);
    expect(line(pinned.sh, "SHA256_TERM_HOST_LINUX_X64=")).toBe(`SHA256_TERM_HOST_LINUX_X64="${sha("tunelo-term-host-linux-x64")}"`);
    expect(line(pinned.sh, "SHA256_TERM_HOST_LINUX_ARM64=")).toBe(`SHA256_TERM_HOST_LINUX_ARM64="${sha("tunelo-term-host-linux-arm64")}"`);
    expect(line(pinned.sh, "MINISIGN_PUBKEY=")).toBe(`MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`);
    expect(line(pinned.ps1, "$TuneloVersion =")).toBe("$TuneloVersion = '9.8.7'");
    expect(line(pinned.ps1, "$Sha256WindowsX64 =")).toBe(`$Sha256WindowsX64 = '${sha("tunelo-windows-x64.exe")}'`);
    expect(line(pinned.ps1, "$Sha256TermHostWindowsX64 =")).toBe(`$Sha256TermHostWindowsX64 = '${sha("tunelo-term-host-windows-x64.exe")}'`);
  });

  it("refuses a SHA256SUMS without a Linux build", () => {
    const withoutArm = sums
      .split("\n")
      .filter((l) => !l.endsWith("tunelo-linux-arm64"))
      .join("\n");
    expect(() => pinInstallScripts("9.8.7", withoutArm, scripts)).toThrow("no SHA-256 for tunelo-linux-arm64");
  });

  it("refuses a SHA256SUMS without the terminal process of a platform", () => {
    const withoutHost = sums
      .split("\n")
      .filter((l) => !l.endsWith("tunelo-term-host-windows-x64.exe"))
      .join("\n");
    expect(() => pinInstallScripts("9.8.7", withoutHost, scripts)).toThrow("no SHA-256 for tunelo-term-host-windows-x64.exe");
  });

  it("refuses a script without a pin line of the terminal process", () => {
    const ps1 = scripts.ps1.replace(/^\$Sha256TermHostWindowsX64 = .*$/m, "");
    expect(() => pinInstallScripts("9.8.7", sums, { ...scripts, ps1 })).toThrow(/install\.ps1: .*Sha256TermHostWindowsX64/);
  });

  it("refuses a script without a pin line", () => {
    const sh = scripts.sh.replace(/^SHA256_LINUX_X64=.*$/m, "");
    expect(() => pinInstallScripts("9.8.7", sums, { ...scripts, sh })).toThrow(/install\.sh: .*SHA256_LINUX_X64/);
  });
});

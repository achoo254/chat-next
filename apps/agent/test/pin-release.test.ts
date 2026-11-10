// The install scripts are pinned to every file of a release: both macOS
// builds, both Linux builds and the Windows build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_ASSETS, pinInstallScripts } from "../scripts/pin-install-scripts.ts";
import { MINISIGN_PUBKEY } from "../src/update.ts";

const agentDir = join(import.meta.dirname, "..", "..", "web", "public", "agent");
const scripts = { sh: readFileSync(join(agentDir, "install.sh"), "utf8"), ps1: readFileSync(join(agentDir, "install.ps1"), "utf8") };
const hashOf = (i: number) => String(i + 1).repeat(64);
const sums = PINNED_ASSETS.map((name, i) => `${hashOf(i)}  ${name}`).join("\n") + "\n";
const line = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(name)) ?? "";

describe("pin-release", () => {
  it("names the five released files", () => {
    expect([...PINNED_ASSETS].sort()).toEqual(["tunelo-darwin-arm64", "tunelo-darwin-x64", "tunelo-linux-arm64", "tunelo-linux-x64", "tunelo-windows-x64.exe"]);
  });

  it("pins the version, the key and the SHA-256 of every file", () => {
    const pinned = pinInstallScripts("9.8.7", sums, scripts);
    const sha = (name: string) => hashOf(PINNED_ASSETS.indexOf(name as (typeof PINNED_ASSETS)[number]));
    expect(line(pinned.sh, "TUNELO_VERSION=")).toBe('TUNELO_VERSION="9.8.7"');
    expect(line(pinned.sh, "SHA256_DARWIN_ARM64=")).toBe(`SHA256_DARWIN_ARM64="${sha("tunelo-darwin-arm64")}"`);
    expect(line(pinned.sh, "SHA256_DARWIN_X64=")).toBe(`SHA256_DARWIN_X64="${sha("tunelo-darwin-x64")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_X64=")).toBe(`SHA256_LINUX_X64="${sha("tunelo-linux-x64")}"`);
    expect(line(pinned.sh, "SHA256_LINUX_ARM64=")).toBe(`SHA256_LINUX_ARM64="${sha("tunelo-linux-arm64")}"`);
    expect(line(pinned.sh, "MINISIGN_PUBKEY=")).toBe(`MINISIGN_PUBKEY="${MINISIGN_PUBKEY}"`);
    expect(line(pinned.ps1, "$TuneloVersion =")).toBe("$TuneloVersion = '9.8.7'");
    expect(line(pinned.ps1, "$Sha256WindowsX64 =")).toBe(`$Sha256WindowsX64 = '${sha("tunelo-windows-x64.exe")}'`);
  });

  it("refuses a SHA256SUMS without a Linux build", () => {
    const withoutArm = sums
      .split("\n")
      .filter((l) => !l.endsWith("tunelo-linux-arm64"))
      .join("\n");
    expect(() => pinInstallScripts("9.8.7", withoutArm, scripts)).toThrow("no SHA-256 for tunelo-linux-arm64");
  });

  it("refuses a script without a pin line", () => {
    const sh = scripts.sh.replace(/^SHA256_LINUX_X64=.*$/m, "");
    expect(() => pinInstallScripts("9.8.7", sums, { ...scripts, sh })).toThrow(/install\.sh: .*SHA256_LINUX_X64/);
  });
});

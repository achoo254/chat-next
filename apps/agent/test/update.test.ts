import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HDA_RELEASES, TUNELO_RELEASES, assetName, newestRelease, signedComment, trustedComment, verifyMinisign } from "../src/update.ts";

const dir = join(import.meta.dirname, "fixtures");
const file = new Uint8Array(readFileSync(join(dir, "payload.bin")));
const pub = readFileSync(join(dir, "test.pub"), "utf8").split(/\r?\n/)[1] ?? "";

describe("minisign", () => {
  it("accepts a signature made by minisign (prehashed and legacy)", () => {
    expect(verifyMinisign(file, readFileSync(join(dir, "payload.bin.minisig"), "utf8"), pub)).toBe(true);
    expect(verifyMinisign(file, readFileSync(join(dir, "payload.bin.legacy.minisig"), "utf8"), pub)).toBe(true);
  });

  it("rejects a changed file, a changed trusted comment and another key", () => {
    const sig = readFileSync(join(dir, "payload.bin.minisig"), "utf8");
    const changed = file.slice();
    changed[10] = (changed[10] ?? 0) ^ 1;
    expect(verifyMinisign(changed, sig, pub)).toBe(false);
    expect(verifyMinisign(file, sig.replace(/^trusted comment: /m, "trusted comment: x"), pub)).toBe(false);
    expect(verifyMinisign(file, sig)).toBe(false);
  });

  it("reads the signed comment", () => {
    expect(trustedComment(readFileSync(join(dir, "payload.bin.minisig"), "utf8"))).toBe("chat-agent test");
  });

  it("names the right asset per platform", () => {
    expect(assetName("darwin", "arm64")).toBe("tunelo-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("tunelo-darwin-x64");
    expect(assetName("win32", "x64")).toBe("tunelo-windows-x64.exe");
    expect(() => assetName("linux", "x64")).toThrow(/no tunelo build/);
  });
});

describe("release lines", () => {
  const rel = (tag_name: string, extra: { draft?: boolean; prerelease?: boolean } = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
  const releases = [
    rel("tunelo-v2.0.0"),
    rel("agent-v0.3.0"),
    rel("tunelo-v2.1.0"),
    rel("tunelo-v2.10.0", { draft: true }),
    rel("tunelo-v3.0.0-rc.1"),
    rel("tunelo-v2.2.0", { prerelease: true }),
    rel("agent-v0.2.4"),
    rel("chat-v1.40.0"),
  ];

  it("tunelo updates from tunelo-v* only, newest published first", () => {
    expect(newestRelease(releases, TUNELO_RELEASES)?.version).toBe("2.1.0");
    expect(newestRelease([rel("agent-v0.3.0")], TUNELO_RELEASES)).toBeNull();
  });

  it("the bridge matches what hda 0.2.x looks for: agent-v*, hda-* files, hda comments", () => {
    expect(newestRelease(releases, HDA_RELEASES)).toMatchObject({ version: "0.3.0", release: { tag_name: "agent-v0.3.0" } });
    expect(assetName("darwin", "arm64", HDA_RELEASES)).toBe("hda-darwin-arm64");
    expect(assetName("darwin", "x64", HDA_RELEASES)).toBe("hda-darwin-x64");
    expect(assetName("win32", "x64", HDA_RELEASES)).toBe("hda-windows-x64.exe");
    expect(signedComment(HDA_RELEASES, "0.3.0", "hda-windows-x64.exe")).toBe("hda 0.3.0 hda-windows-x64.exe");
    expect(signedComment(TUNELO_RELEASES, "2.0.0", "tunelo-darwin-arm64")).toBe("tunelo 2.0.0 tunelo-darwin-arm64");
  });
});

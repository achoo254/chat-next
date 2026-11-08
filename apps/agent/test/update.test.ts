import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assetName, trustedComment, verifyMinisign } from "../src/update.ts";

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
    expect(assetName("darwin", "arm64")).toBe("hda-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("hda-darwin-x64");
    expect(assetName("win32", "x64")).toBe("hda-windows-x64.exe");
  });
});

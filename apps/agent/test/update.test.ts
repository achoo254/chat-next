import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { archiveName, assetName, newestRelease, signedComment, termHostAssetName, trustedComment, unpackArchive, verifyMinisign } from "../src/update.ts";

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
    expect(trustedComment(readFileSync(join(dir, "payload.bin.minisig"), "utf8"))).toBe("tunelo test");
  });

  it("names the right asset per platform", () => {
    expect(assetName("darwin", "arm64")).toBe("tunelo-darwin-arm64");
    expect(assetName("darwin", "x64")).toBe("tunelo-darwin-x64");
    expect(assetName("win32", "x64")).toBe("tunelo-windows-x64.exe");
    expect(assetName("linux", "x64")).toBe("tunelo-linux-x64");
    expect(assetName("linux", "arm64")).toBe("tunelo-linux-arm64");
    expect(() => assetName("linux", "ia32")).toThrow(/no tunelo build for Linux on ia32/);
    expect(() => assetName("freebsd", "x64")).toThrow(/no tunelo build for freebsd/);
  });

  it("names the release archive per platform", () => {
    expect(archiveName("darwin", "arm64")).toBe("tunelo-darwin-arm64.tar.gz");
    expect(archiveName("darwin", "x64")).toBe("tunelo-darwin-x64.tar.gz");
    expect(archiveName("linux", "x64")).toBe("tunelo-linux-x64.tar.gz");
    expect(archiveName("linux", "arm64")).toBe("tunelo-linux-arm64.tar.gz");
    expect(archiveName("win32", "x64")).toBe("tunelo-windows-x64.zip");
  });
});

describe("release archives", () => {
  const PLATFORMS = [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const;

  it("unpacks every archive the release script packs, with the executable files and their signatures", () => {
    const root = mkdtempSync(join(tmpdir(), "tunelo-package-"));
    try {
      const dist = join(root, "dist");
      mkdirSync(dist);
      const names = PLATFORMS.flatMap(([os, cpu]) => [assetName(os, cpu), termHostAssetName(os, cpu)]);
      for (const name of names) {
        writeFileSync(join(dist, name), `${name} body`);
        writeFileSync(join(dist, `${name}.minisig`), `${name} signature`);
      }
      const script = join(import.meta.dirname, "..", "scripts", "package-release.sh");
      const run = spawnSync("sh", [script, dist, join(root, "out"), "--signed"], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
      expect(run.stderr).not.toMatch(/missing/);
      expect(run.status).toBe(0);
      const sums = readFileSync(join(root, "out", "SHA256SUMS"), "utf8");
      for (const [os, cpu] of PLATFORMS) {
        const archive = archiveName(os, cpu);
        expect(sums).toContain(`  ${archive}`);
        const files = unpackArchive(archive, new Uint8Array(readFileSync(join(root, "out", archive))));
        const want = [assetName(os, cpu), termHostAssetName(os, cpu)];
        expect([...files.keys()].sort()).toEqual([...want, ...want.map((n) => `${n}.minisig`)].sort());
        for (const name of want) {
          expect(new TextDecoder().decode(files.get(name))).toBe(`${name} body`);
          expect(new TextDecoder().decode(files.get(`${name}.minisig`))).toBe(`${name} signature`);
        }
      }
      // Cut short: the tar's first file ends past the data, the zip lost its directory.
      const tar = gunzipSync(readFileSync(join(root, "out", archiveName("linux", "x64"))));
      expect(() => unpackArchive("x.tar.gz", new Uint8Array(gzipSync(tar.subarray(0, 520))))).toThrow("cut short");
      const zip = readFileSync(join(root, "out", archiveName("win32", "x64")));
      expect(() => unpackArchive("x.zip", new Uint8Array(zip.subarray(0, zip.length - 30)))).toThrow("not a zip archive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops before packing anything when a file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "tunelo-package-"));
    try {
      const script = join(import.meta.dirname, "..", "scripts", "package-release.sh");
      const run = spawnSync("sh", [script, root, join(root, "out")], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses broken archives", () => {
    expect(() => unpackArchive("x.zip", new TextEncoder().encode("not a zip"))).toThrow("not a zip archive");
    expect(() => unpackArchive("x.tar.gz", new TextEncoder().encode("not gzip"))).toThrow();
  });
});

describe("releases", () => {
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
    expect(newestRelease(releases)?.version).toBe("2.1.0");
    expect(newestRelease([rel("agent-v0.3.0")])).toBeNull();
  });

  it("signs the program, version and file into the trusted comment", () => {
    expect(signedComment("2.0.0", "tunelo-darwin-arm64")).toBe("tunelo 2.0.0 tunelo-darwin-arm64");
  });
});

// @-mention listing: only inside the session's folder, prefix matching,
// skipped folders, no symbolic link walked into, bounded results.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OutsideFolderError, listSessionFiles } from "../src/safety/session-files.ts";
import { tempDir } from "./harness.ts";

function project() {
  const root = tempDir();
  const outside = tempDir();
  for (const d of ["src/machines", "src/link", "node_modules/pkg", ".git/objects", "secrets"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["README.md", "src/main.ts", "src/machines/new-session.tsx", "src/link/socket.ts", "node_modules/pkg/index.js", ".git/HEAD", "secrets/key.pem"]) {
    writeFileSync(join(root, f), "x");
  }
  writeFileSync(join(outside, "elsewhere.txt"), "x");
  symlinkSync(outside, join(root, "linked"));
  return { root, outside };
}

const open = { isSensitive: () => false };
const paths = (l: { entries: { path: string }[] }) => l.entries.map((e) => e.path);

describe("session files", () => {
  it("lists shallow paths first and skips .git and node_modules", () => {
    const { root } = project();
    const all = paths(listSessionFiles(root, "", open));
    expect(all.slice(0, 4)).toEqual(["linked", "README.md", "secrets/", "src/"]);
    expect(all).toContain("src/machines/new-session.tsx");
    expect(all.some((p) => p.startsWith(".git") || p.startsWith("node_modules"))).toBe(false);
  });

  it("matches a path prefix, and a name anywhere when there is no folder part", () => {
    const { root } = project();
    expect(paths(listSessionFiles(root, "src/ma", open))).toEqual(["src/machines/", "src/main.ts", "src/machines/new-session.tsx"]);
    expect(paths(listSessionFiles(root, "SOCK", open))).toEqual(["src/link/socket.ts"]);
    const dirEntry = listSessionFiles(root, "src/li", open).entries[0];
    expect(dirEntry).toEqual({ path: "src/link/", dir: true });
  });

  it("never walks into a symbolic link or out of the folder", () => {
    const { root } = project();
    expect(paths(listSessionFiles(root, "elsewhere", open))).toEqual([]);
    expect(listSessionFiles(root, "linked", open).entries).toEqual([{ path: "linked", dir: false }]);
    for (const bad of ["../", "../x", "src/../../x", "/etc/pa"]) expect(() => listSessionFiles(root, bad, open)).toThrow(OutsideFolderError);
  });

  it("skips sensitive paths and caps the answer", () => {
    const { root } = project();
    const listing = listSessionFiles(root, "", { isSensitive: (p) => p.includes("secrets") });
    expect(paths(listing).some((p) => p.startsWith("secrets"))).toBe(false);
    const capped = listSessionFiles(root, "", { ...open, limit: 2 });
    expect(capped.entries).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(listSessionFiles(root, "", { ...open, limit: 10_000 }).truncated).toBe(false);
  });
});

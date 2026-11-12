// The Explorer's reads of a workspace: a device names a workspace and
// relative paths only, and never gets past the workspace's real folder (by
// "..", an absolute path, a link elsewhere or a name that looks like ".."),
// never sees a secret file, and every listing, read and search is capped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { FILE_LIMITS, parseGrep } from "../src/workspace/files.ts";
import { isSecretName, naturalCompare, relParts } from "../src/workspace/paths.ts";
import { tempDir } from "./harness.ts";
import { commitAll, git, reasonOf, repo, workspaces } from "./support/workspace-fixture.ts";

const PAGE = { afterName: "", afterDir: false, limit: 0, showHidden: false, hideIgnored: false };
const posix = process.platform !== "win32";

/** A workspace "w" in a fresh repository, beside a folder outside it with a file the tests must never reach. */
function setup() {
  const base = tempDir("ws-files-");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-CONTENT");
  const dir = repo(join(base, "work"));
  const svc = workspaces({ w: dir });
  return { base, dir, outside, ...svc };
}

describe("paths a device names", () => {
  it("are relative, plain parts only", () => {
    for (const bad of ["..", "../x", "a/../b", "a/./b", "./a", "/etc/passwd", "a//b", "a/", "\0", "a\0b", "C:/x", `${"a/".repeat(3000)}`]) {
      expect(() => relParts(bad), JSON.stringify(bad)).toThrow();
    }
    expect(relParts("")).toEqual([]);
    expect(relParts("src/a b/$(x)")).toEqual(["src", "a b", "$(x)"]);
  });

  it("knows secret names and leaves their public halves and templates alone", () => {
    for (const s of [".env", ".env.local", ".ENV.production", "prod.env", "id_rsa", "id_ed25519", "server.pem", "tls.KEY", "cert.p12", ".npmrc", ".netrc", "credentials", ".git", ".ssh", ".git-credentials", ".envrc"]) {
      expect(isSecretName(s), s).toBe(true);
    }
    for (const s of [".env.example", ".env.sample", "id_rsa.pub", "keys.ts", "environment.ts", "README.md", ".gitignore", "env"]) {
      expect(isSecretName(s), s).toBe(false);
    }
  });

  it("sorts names naturally", () => {
    expect(["file10", "file9", "File1", "file1"].sort(naturalCompare)).toEqual(["File1", "file1", "file9", "file10"]);
  });
});

describe("escaping the workspace", () => {
  it("refuses .., absolute paths and links that end outside, and reads nothing there", async () => {
    const { ws, dir, outside } = setup();
    symlinkSync(outside, join(dir, "out-dir"));
    symlinkSync(join(outside, "secret.txt"), join(dir, "out-file"));
    for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "out-dir/secret.txt", "out-file", "out-dir"]) {
      expect((await reasonOf(ws.fileRead("w", path))).reason, path).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
      expect((await reasonOf(ws.dirList("w", path, PAGE))).reason, path).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
    }
    // Listed, but as what they are: links pointing outside, never folders to open.
    const page = await ws.dirList("w", "", PAGE);
    expect(page.entries.find((e) => e.name === "out-dir")).toMatchObject({ symlink: true, outside: true, dir: false, size: 0 });
    expect(page.entries.find((e) => e.name === "out-file")).toMatchObject({ symlink: true, outside: true });
  });

  it("follows a link that stays inside, and survives a link loop", async () => {
    const { ws, dir } = setup();
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "a.txt"), "inside");
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
    symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
    expect((await ws.fileRead("w", "alias/a.txt")).text).toBe("inside");
    const page = await ws.dirList("w", "", PAGE);
    expect(page.entries.find((e) => e.name === "alias")).toMatchObject({ symlink: true, dir: true, outside: false });
    expect(page.entries.find((e) => e.name === "loop-a")).toMatchObject({ symlink: true, outside: true, dir: false });
    await expect(ws.fileRead("w", "loop-a")).rejects.toThrow();
    await expect(ws.dirList("w", "loop-a", PAGE)).rejects.toThrow();
  });

  it("treats names that only look like .. or / as plain names", async () => {
    const { ws, dir } = setup();
    // ONE DOT LEADER twice, FULLWIDTH FULL STOP twice, DIVISION SLASH, a zero-width space after "..".
    const lookalikes = ["\u2024\u2024", "\uff0e\uff0e", "a\u2215b", "..\u200b"];
    for (const name of lookalikes) writeFileSync(join(dir, name), `named ${name}`);
    for (const name of lookalikes) expect((await ws.fileRead("w", name)).text).toBe(`named ${name}`);
    for (const path of ["\u2024\u2024/outside/secret.txt", "\uff0e\uff0e/outside/secret.txt", "..\u200b/outside/secret.txt", "\u2215etc\u2215passwd"]) {
      const r = await reasonOf(ws.fileRead("w", path));
      expect(r.reason, path).toBe(ErrorReason.FOLDER_NOT_FOUND);
    }
    // The same name in another Unicode form reaches the same file or none, never another folder.
    writeFileSync(join(dir, "caf\u00e9.txt"), "nfc");
    const nfd = await ws.fileRead("w", "cafe\u0301.txt").then(
      (f) => f.text,
      () => "missing",
    );
    expect(["nfc", "missing"]).toContain(nfd);
  });

  it("never opens a device, pipe or socket", async () => {
    if (!posix) return;
    const { ws, dir } = setup();
    execFileSync("mkfifo", [join(dir, "pipe")]);
    symlinkSync("/dev/zero", join(dir, "zero"));
    expect((await ws.dirList("w", "", PAGE)).entries.map((e) => e.name)).not.toContain("pipe");
    expect((await reasonOf(ws.fileRead("w", "pipe"))).reason).toBe(ErrorReason.UNSPECIFIED);
    expect((await reasonOf(ws.fileRead("w", "zero"))).reason).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
  });

  it("knows no workspace a device makes up, nor a folder that is gone", async () => {
    const base = tempDir("ws-gone-");
    const { ws } = workspaces({ gone: join(base, "nope") });
    expect((await reasonOf(ws.dirList("other", "", PAGE))).reason).toBe(ErrorReason.PROJECT_NOT_FOUND);
    expect((await reasonOf(ws.dirList("gone", "", PAGE))).reason).toBe(ErrorReason.FOLDER_NOT_FOUND);
  });
});

describe("secret files", () => {
  it("are never listed, read or found, even with hidden files shown", async () => {
    const { ws, dir } = setup();
    const secrets = [".env", ".env.local", "id_rsa", "server.pem", ".npmrc", "credentials"];
    for (const name of secrets) writeFileSync(join(dir, name), "TOKEN=SECRET-VALUE-123");
    writeFileSync(join(dir, ".env.example"), "TOKEN=");
    writeFileSync(join(dir, "id_rsa.pub"), "ssh-ed25519 AAAA");
    writeFileSync(join(dir, "notes.txt"), "SECRET-VALUE-123 is mentioned here");
    mkdirSync(join(dir, "config"));
    symlinkSync(join(dir, ".env"), join(dir, "config", "settings"));
    const names = (await ws.dirList("w", "", { ...PAGE, showHidden: true })).entries.map((e) => e.name);
    for (const name of [...secrets, ".git"]) expect(names, name).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining([".env.example", "id_rsa.pub", "notes.txt"]));
    expect((await ws.dirList("w", "config", { ...PAGE, showHidden: true })).entries).toEqual([]);
    for (const path of [...secrets, ".git/config", ".git/HEAD", "config/settings", "sub/.env"]) {
      expect((await reasonOf(ws.fileRead("w", path))).reason, path).toBe(ErrorReason.SECRET_FILE);
    }
    expect((await reasonOf(ws.dirList("w", ".git", PAGE))).reason).toBe(ErrorReason.SECRET_FILE);
    expect((await ws.findNames("w", "env", 0)).paths).toEqual([".env.example"]);
    const found = await ws.findContents("w", { query: "SECRET-VALUE-123", caseSensitive: true, wholeWord: false, regex: false, limit: 0 });
    expect(found.files.map((f) => f.path)).toEqual(["notes.txt"]);
  });
});

describe("listing a folder", () => {
  it("pages a large folder in natural order, folders first, without repeats or gaps", async () => {
    const { ws, dir } = setup();
    for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `file${i}`), "");
    for (const d of ["b-dir", "a-dir"]) mkdirSync(join(dir, d));
    const seen: string[] = [];
    let after = { afterName: "", afterDir: false };
    for (;;) {
      const page = await ws.dirList("w", "", { ...PAGE, ...after, limit: 2000 });
      expect(page.total).toBe(3002);
      seen.push(...page.entries.map((e) => e.name));
      const last = page.entries.at(-1);
      if (!page.hasMore || !last) break;
      after = { afterName: last.name, afterDir: last.dir };
    }
    expect(seen.length).toBe(3002);
    expect(new Set(seen).size).toBe(3002);
    expect(seen.slice(0, 4)).toEqual(["a-dir", "b-dir", "file0", "file1"]);
    expect(seen.indexOf("file9")).toBeLessThan(seen.indexOf("file10"));
    // Capped at 2000 a page whatever is asked; 500 by default.
    expect((await ws.dirList("w", "", { ...PAGE, limit: 100_000 })).entries.length).toBe(2000);
    expect((await ws.dirList("w", "", PAGE)).entries.length).toBe(500);
  });

  it("starts after a cursor entry that was removed meanwhile", async () => {
    const { ws, dir } = setup();
    for (const n of ["a", "b", "c", "d"]) writeFileSync(join(dir, n), "");
    const first = await ws.dirList("w", "", { ...PAGE, limit: 2 });
    expect(first.entries.map((e) => e.name)).toEqual(["a", "b"]);
    execFileSync("rm", [join(dir, "b")]);
    const next = await ws.dirList("w", "", { ...PAGE, limit: 2, afterName: "b", afterDir: false });
    expect(next.entries.map((e) => e.name)).toEqual(["c", "d"]);
  });

  it("refuses a folder past the entry cap", async () => {
    const { ws, dir } = setup();
    const cap = FILE_LIMITS.dirEntries;
    FILE_LIMITS.dirEntries = 50;
    try {
      for (let i = 0; i < 51; i++) writeFileSync(join(dir, `f${i}`), "");
      expect((await reasonOf(ws.dirList("w", "", PAGE))).reason).toBe(ErrorReason.FOLDER_TOO_LARGE);
    } finally {
      FILE_LIMITS.dirEntries = cap;
    }
  });

  it("marks what git ignores and what changed, and hides ignored entries on request", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".gitignore"), "build/\n*.log\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "kept.ts"), "1");
    writeFileSync(join(dir, "tracked.txt"), "1");
    commitAll(dir);
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "out.js"), "");
    writeFileSync(join(dir, "debug.log"), "");
    writeFileSync(join(dir, "tracked.txt"), "2");
    writeFileSync(join(dir, "src", "kept.ts"), "2");
    mkdirSync(join(dir, "fresh"));
    writeFileSync(join(dir, "fresh", "new.ts"), "");
    writeFileSync(join(dir, "added.ts"), "");
    git(dir, "add", "added.ts");
    const byName = new Map((await ws.dirList("w", "", { ...PAGE, showHidden: true })).entries.map((e) => [e.name, e]));
    expect(byName.get("build")).toMatchObject({ dir: true, ignored: true });
    expect(byName.get("debug.log")).toMatchObject({ ignored: true });
    expect(byName.get("tracked.txt")).toMatchObject({ ignored: false, git: "modified" });
    expect(byName.get("src")).toMatchObject({ git: "modified" });
    expect(byName.get("fresh")).toMatchObject({ git: "untracked" });
    expect(byName.get("added.ts")).toMatchObject({ git: "added" });
    expect(byName.get(".gitignore")?.git).toBe("");
    const hidden = (await ws.dirList("w", "", { ...PAGE, hideIgnored: true })).entries.map((e) => e.name);
    expect(hidden).not.toContain("build");
    expect(hidden).not.toContain("debug.log");
    expect((await ws.dirList("w", "src", PAGE)).entries).toMatchObject([{ name: "kept.ts", git: "modified", size: 1 }]);
  });

  it("works outside git too", async () => {
    const plain = join(tempDir("ws-plain-"), "p");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.txt"), "x");
    const { ws } = workspaces({ p: plain });
    expect((await ws.dirList("p", "", PAGE)).entries).toMatchObject([{ name: "a.txt", git: "", ignored: false }]);
  });
});

describe("reading a file", () => {
  it("gives text, pictures and binary within their limits", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.md"), "# hello\n");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(join(dir, "p.png"), png);
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(FILE_LIMITS.textBytes + 1));
    writeFileSync(join(dir, "big.png"), Buffer.alloc(FILE_LIMITS.imageBytes + 1));
    writeFileSync(join(dir, "pic.svg"), "<svg/>");
    expect(await ws.fileRead("w", "a.md")).toMatchObject({ kind: "text", text: "# hello\n", size: 8 });
    const pic = await ws.fileRead("w", "p.png");
    expect(pic).toMatchObject({ kind: "image", mime: "image/png" });
    expect(Buffer.from(pic.data).equals(png)).toBe(true);
    expect(await ws.fileRead("w", "bin.dat")).toMatchObject({ kind: "binary", text: "" });
    expect(await ws.fileRead("w", "latin1.txt")).toMatchObject({ kind: "binary" });
    expect(await ws.fileRead("w", "big.txt")).toMatchObject({ kind: "tooLarge", text: "", size: FILE_LIMITS.textBytes + 1 });
    expect((await ws.fileRead("w", "big.png")).data.length).toBe(0);
    expect((await ws.fileRead("w", "big.png")).kind).toBe("tooLarge");
    expect(await ws.fileRead("w", "pic.svg")).toMatchObject({ kind: "text", mime: "" });
    expect((await reasonOf(ws.fileRead("w", "missing.txt"))).reason).toBe(ErrorReason.FOLDER_NOT_FOUND);
  });
});

describe("finding files", () => {
  it("finds by every word of the query among what git does not ignore, shortest first", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    mkdirSync(join(dir, "src", "machines"), { recursive: true });
    mkdirSync(join(dir, "dist"));
    for (const p of ["src/machines/changes-panel.tsx", "src/machines/panel.ts", "src/other.ts", "dist/panel.js", "Panel.md"]) writeFileSync(join(dir, p), "");
    commitAll(dir);
    writeFileSync(join(dir, "src", "untracked-panel.ts"), "");
    expect((await ws.findNames("w", "panel", 0)).paths).toEqual(["Panel.md", "src/machines/panel.ts", "src/untracked-panel.ts", "src/machines/changes-panel.tsx"]);
    expect((await ws.findNames("w", "MACH  panel", 0)).paths).toEqual(["src/machines/panel.ts", "src/machines/changes-panel.tsx"]);
    expect(await ws.findNames("w", "panel", 2)).toEqual({ paths: ["Panel.md", "src/machines/panel.ts"], truncated: true });
    expect((await ws.findNames("w", "   ", 0)).paths).toEqual([]);
    expect((await reasonOf(ws.findNames("w", "x".repeat(2049), 0))).reason).toBe(ErrorReason.UNSPECIFIED);
  });

  it("walks a folder outside git, skipping dependencies", async () => {
    const plain = join(tempDir("ws-walk-"), "p");
    mkdirSync(join(plain, "node_modules", "lib"), { recursive: true });
    mkdirSync(join(plain, "src"));
    writeFileSync(join(plain, "node_modules", "lib", "index.js"), "");
    writeFileSync(join(plain, "src", "index.js"), "");
    const { ws } = workspaces({ p: plain });
    expect((await ws.findNames("p", "index", 0)).paths).toEqual(["src/index.js"]);
  });

  it("parses git grep's output whatever the file names hold", () => {
    expect(parseGrep("a b.txt\x001\x003\x00hello\nx\ny.md\x0012\x001\x00line two\ncut\x001")).toEqual([
      { path: "a b.txt", line: 1, column: 3, text: "hello" },
      { path: "x\ny.md", line: 12, column: 1, text: "line two" },
    ]);
  });

  it("searches contents literally, by regex, by case and whole words, within limits", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "a.ts"), "const Foo = 1;\nfoo(bar);\nfood\n");
    writeFileSync(join(dir, "ignored.txt"), "foo\n");
    writeFileSync(join(dir, "b.bin"), Buffer.from("foo\0bar"));
    commitAll(dir);
    writeFileSync(join(dir, "new.ts"), "foo in an untracked file\n");
    const q = { query: "foo", caseSensitive: false, wholeWord: false, regex: false, limit: 0 };
    const all = await ws.findContents("w", q);
    expect(all.files.map((f) => f.path)).toEqual(["a.ts", "new.ts"]);
    expect(all.files[0]?.matches).toEqual([
      { line: 1, column: 7, text: "const Foo = 1;" },
      { line: 2, column: 1, text: "foo(bar);" },
      { line: 3, column: 1, text: "food" },
    ]);
    expect((await ws.findContents("w", { ...q, caseSensitive: true, wholeWord: true })).totalMatches).toBe(2);
    expect((await ws.findContents("w", { ...q, query: "fo+d$", regex: true })).totalMatches).toBe(1);
    // A literal query is not a pattern.
    expect((await ws.findContents("w", { ...q, query: "foo(" })).totalMatches).toBe(1);
    expect((await ws.findContents("w", { ...q, query: "-e" })).totalMatches).toBe(0);
    expect((await reasonOf(ws.findContents("w", { ...q, query: "(", regex: true }))).reason).toBe(ErrorReason.GIT_FAILED);
  });

  it("stops at 2000 matches and leaves out files over 5 MiB", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "many.txt"), "needle\n".repeat(3000));
    writeFileSync(join(dir, "huge.txt"), `needle\n${"x".repeat(FILE_LIMITS.grepFileBytes)}`);
    const r = await ws.findContents("w", { query: "needle", caseSensitive: true, wholeWord: false, regex: false, limit: 0 });
    expect(r.totalMatches).toBe(2000);
    expect(r.truncated).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["many.txt"]);
    const few = await ws.findContents("w", { query: "needle", caseSensitive: true, wholeWord: false, regex: false, limit: 5 });
    expect(few).toMatchObject({ totalMatches: 5, truncated: true });
  });

  it("searches a folder outside git", async () => {
    const plain = join(tempDir("ws-grep-"), "p");
    mkdirSync(plain);
    writeFileSync(join(plain, "a.txt"), "needle\n");
    const { ws } = workspaces({ p: plain });
    expect((await ws.findContents("p", { query: "needle", caseSensitive: true, wholeWord: false, regex: false, limit: 0 })).files).toEqual([
      { path: "a.txt", matches: [{ line: 1, column: 1, text: "needle" }] },
    ]);
  });
});

describe("hostile file names", () => {
  it("are only characters: listed, read and found, running nothing", async () => {
    const { ws, dir, base } = setup();
    // A shell would make "pwned" in its working folder: the workspace, its parent or the test's.
    const markers = [join(dir, "pwned"), join(base, "pwned"), join(process.cwd(), "pwned")];
    const names = ["$(touch pwned)", "`touch pwned`", "-rf", "--help", "a\nb", "a b", `'";touch pwned;'`, "-e"];
    for (const name of names) writeFileSync(join(dir, name), `content of ${name}`);
    const listed = (await ws.dirList("w", "", PAGE)).entries.map((e) => e.name);
    expect(listed).toEqual(expect.arrayContaining(names));
    for (const name of names) expect((await ws.fileRead("w", name)).text).toBe(`content of ${name}`);
    expect((await ws.findNames("w", "touch", 0)).paths.length).toBe(3);
    const found = await ws.findContents("w", { query: "content of", caseSensitive: true, wholeWord: false, regex: false, limit: 0 });
    expect(found.files.map((f) => f.path).sort()).toEqual([...names].sort());
    for (const m of markers) expect(existsSync(m)).toBe(false);
  });
});

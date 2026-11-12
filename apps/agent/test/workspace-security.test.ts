// What the security review of the right panel found, each held by a test:
// discarding a link moves the link, never its target; a diff never shows a
// secret file through its old path; a stuck git helper cannot hold a
// workspace; the machine's sensitive folders hold for every read; LFS
// objects go up before the commits; git works only at the repository's top
// folder; the repository's own network settings and signing are refused;
// config changed during a command is noticed; watch requests apply in
// order; and errors never carry an absolute path.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, WsWatchSchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { WorkspaceLink } from "../src/link/workspace-link.ts";
import { OPS_LIMITS } from "../src/workspace/git-ops.ts";
import { isSecretName } from "../src/workspace/paths.ts";
import type { FileWatch, WorkspaceChange } from "../src/workspace/watch.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";
import { TEST_GIT_CONFIG, commitAll, git, reasonOf, repo, workspaces } from "./support/workspace-fixture.ts";

const posix = process.platform !== "win32";
const PAGE = { afterName: "", afterDir: false, limit: 0, showHidden: true, hideIgnored: false };

function setup(extra: Parameters<typeof workspaces>[1] = {}) {
  const base = tempDir("ws-sec-");
  const dir = repo(join(base, "work"));
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "README.md"), "readme\n");
  commitAll(dir, "first");
  return { base, dir, ...workspaces({ w: dir }, extra) };
}

/** An executable script in a fresh folder, and that folder first on PATH for the rest of the test. */
function onPath(name: string, script: string): string {
  const bin = tempDir("ws-bin-");
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return bin;
}

function withRemote(base: string, dir: string): string {
  const bare = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  return bare;
}

describe("discarding untracked links and folders", () => {
  it("moves a link to a folder of the workspace, never the folder", async () => {
    if (!posix) return;
    const { ws, dir, trashed } = setup();
    mkdirSync(join(dir, "kept"));
    writeFileSync(join(dir, "kept", "k.txt"), "keep\n");
    commitAll(dir, "kept");
    symlinkSync(join(dir, "kept"), join(dir, "alias"));
    symlinkSync(join(dir, "kept", "k.txt"), join(dir, "file-alias"));
    await ws.discard("w", ["alias", "file-alias"], true, "dev");
    expect(trashed.sort()).toEqual([join(dir, "alias"), join(dir, "file-alias")]);
    expect(readFileSync(join(dir, "kept", "k.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(dir, "alias"))).toBe(false);
  });

  it("moves links pointing outside and dangling links themselves, in one request", async () => {
    if (!posix) return;
    const { ws, dir, base, trashed } = setup();
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(base, "elsewhere", "keep.txt"), "keep\n");
    symlinkSync(join(base, "elsewhere"), join(dir, "out"));
    symlinkSync(join(base, "elsewhere", "keep.txt"), join(dir, "out-file"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    writeFileSync(join(dir, "plain.txt"), "p\n");
    await ws.discard("w", ["out", "out-file", "dangling", "plain.txt"], true, "dev");
    expect(trashed.sort()).toEqual(["dangling", "out", "out-file", "plain.txt"].map((n) => join(dir, n)));
    expect(readFileSync(join(base, "elsewhere", "keep.txt"), "utf8")).toBe("keep\n");
    expect((await reasonOf(ws.discard("w", ["../elsewhere/keep.txt"], true, "dev"))).reason).toBe(ErrorReason.PATH_OUTSIDE_FOLDER);
    expect(existsSync(join(base, "elsewhere", "keep.txt"))).toBe(true);
  });

  it("moves an untracked nested repository as that folder", async () => {
    const { ws, dir, trashed } = setup();
    const nested = repo(join(dir, "nested"));
    writeFileSync(join(nested, "n.txt"), "n\n");
    commitAll(nested, "nested");
    await ws.discard("w", ["nested"], true, "dev");
    expect(trashed).toEqual([join(dir, "nested")]);
    expect(existsSync(nested)).toBe(false);
  });

  it("leaves a path swapped for a link between listing and moving, and the link's target", async () => {
    if (!posix) return;
    const { base, dir } = setup();
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(base, "elsewhere", "keep.txt"), "keep\n");
    writeFileSync(join(dir, "victim.txt"), "untracked\n");
    const { ws, trashed } = workspaces(
      { w: dir },
      {
        beforeTrash: async () => {
          rmSync(join(dir, "victim.txt"));
          symlinkSync(join(base, "elsewhere"), join(dir, "victim.txt"));
        },
      },
    );
    const r = await reasonOf(ws.discard("w", ["victim.txt"], true, "dev"));
    expect(r.reason).toBe(ErrorReason.GIT_FAILED);
    expect(r.subject).toContain("changed");
    expect(trashed).toEqual([]);
    expect(readFileSync(join(base, "elsewhere", "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("moves many files in batches, and restores tracked files only once the trash took the rest", async () => {
    const { dir } = setup();
    for (let i = 0; i < 250; i++) writeFileSync(join(dir, `u${i}.txt`), "u\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const sizes: number[] = [];
    let fail = false;
    const { ws, auditFile } = workspaces(
      { w: dir },
      {
        trash: async (paths) => {
          sizes.push(paths.length);
          if (fail) throw new Error(`cannot move ${paths[0] ?? ""}`);
          for (const p of paths) rmSync(p);
        },
      },
    );
    const paths = [...Array.from({ length: 250 }, (_, i) => `u${i}.txt`), "a.txt"];
    fail = true;
    const r = await reasonOf(ws.discard("w", paths, true, "dev"));
    expect(r.reason).toBe(ErrorReason.TRASH_UNAVAILABLE);
    expect(r.subject).toBe("moved 0 of 250 files to the trash; nothing restored");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("changed\n");
    fail = false;
    sizes.length = 0;
    await ws.discard("w", paths, true, "dev");
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
    const last = readFileSync(auditFile, "utf8").trim().split("\n").at(-1) ?? "";
    expect((JSON.parse(last) as { detail: string }).detail).toBe("workspace w: restored 1, trashed 250");
  });
});

describe("diffs and old paths", () => {
  it("never shows a secret file named as the old path of another", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".env"), "TOKEN=LEAKED-VALUE\n");
    git(dir, "add", "-f", ".env");
    for (const source of ["staged", "unstaged"] as const) {
      const r = await ws.diff("w", { path: "README.md", oldPath: ".env", source, commit: "", base: "" }).then(
        (f) => JSON.stringify(f),
        (err: unknown) => String(err),
      );
      expect(r, source).not.toContain("LEAKED-VALUE");
    }
    expect(await ws.diff("w", { path: "README.md", oldPath: ".env", source: "staged", commit: "", base: "" })).toMatchObject({ sensitive: true, unified: "" });
  });

  it("takes an old path only when git reports it as the rename source", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "other.txt"), "OTHER-CONTENT\n");
    git(dir, "add", "other.txt");
    const r = await reasonOf(ws.diff("w", { path: "README.md", oldPath: "other.txt", source: "staged", commit: "", base: "" }));
    expect(r.reason).toBe(ErrorReason.NAME_INVALID);
    git(dir, "mv", "a.txt", "b.txt");
    const renamed = await ws.diff("w", { path: "b.txt", oldPath: "a.txt", source: "staged", commit: "", base: "" });
    expect(renamed.unified).not.toContain("OTHER-CONTENT");
  });

  it("shows a commit that deleted a secret file without its content", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".env"), "TOKEN=OLD-SECRET\n");
    git(dir, "add", "-f", ".env");
    git(dir, "commit", "-qm", "add");
    git(dir, "rm", "-q", ".env");
    git(dir, "commit", "-qm", "remove");
    const oid = git(dir, "rev-parse", "HEAD").trim();
    const d = await ws.diff("w", { path: ".env", oldPath: "", source: "commit", commit: oid, base: "" });
    expect(d).toMatchObject({ sensitive: true, unified: "" });
    const viaOld = await ws.diff("w", { path: "a.txt", oldPath: ".env", source: "commit", commit: oid, base: "" }).then(
      (f) => JSON.stringify(f),
      (err: unknown) => String(err),
    );
    expect(viaOld).not.toContain("OLD-SECRET");
  });
});

describe("a stuck git", () => {
  it("is stopped with every helper it started, and the workspace is free again", async () => {
    if (!posix) return;
    onPath("git-remote-slow", "sleep 31.5 &\nsleep 31.5");
    const { ws, dir } = setup({ extraGitConfig: [...TEST_GIT_CONFIG, "-c", "protocol.slow.allow=always"] });
    git(dir, "remote", "add", "origin", "slow::nowhere");
    const limit = OPS_LIMITS.networkTimeoutMs;
    OPS_LIMITS.networkTimeoutMs = 1_500;
    try {
      const started = Date.now();
      const r = await reasonOf(ws.fetch("w"));
      expect(r.reason).toBe(ErrorReason.GIT_FAILED);
      expect(Date.now() - started).toBeLessThan(10_000);
      writeFileSync(join(dir, "a.txt"), "changed\n");
      expect((await ws.stage("w", ["a.txt"], false, "dev")).entries).toMatchObject([{ area: "staged", path: "a.txt" }]);
      await vi.waitFor(() => expect(execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })).not.toContain("sleep 31.5"), { timeout: 5_000 });
    } finally {
      OPS_LIMITS.networkTimeoutMs = limit;
      vi.unstubAllEnvs();
    }
  });
});

describe("the machine's sensitive folders", () => {
  it("hold for every read inside a workspace", async () => {
    const base = tempDir("ws-sens-");
    const dir = repo(join(base, "work"));
    mkdirSync(join(dir, "private"));
    writeFileSync(join(dir, "private", "a.txt"), "PRIVATE-NEEDLE\n");
    writeFileSync(join(dir, "open.txt"), "open\n");
    symlinkSync(join(dir, "private", "a.txt"), join(dir, "alias.txt"));
    const { ws } = workspaces({ w: dir }, { isSensitive: (p) => p.includes(`${join("work", "private")}`) });
    expect((await ws.dirList("w", "", PAGE)).entries.map((e) => e.name).sort()).toEqual(["open.txt"]);
    for (const path of ["private/a.txt", "alias.txt"]) expect((await reasonOf(ws.fileRead("w", path))).reason, path).toBe(ErrorReason.SECRET_FILE);
    expect((await reasonOf(ws.dirList("w", "private", PAGE))).reason).toBe(ErrorReason.SECRET_FILE);
    expect((await ws.findNames("w", "a.txt", 0)).paths).toEqual([]);
    expect((await ws.findContents("w", { query: "PRIVATE-NEEDLE", caseSensitive: true, wholeWord: false, regex: false, limit: 0 })).files).toEqual([]);
  });

  it("hold for a workspace that lies in one", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "x\n");
    const { ws } = workspaces({ w: dir }, { isSensitive: () => true });
    expect((await reasonOf(ws.fileRead("w", "a.txt"))).reason).toBe(ErrorReason.SECRET_FILE);
    expect((await reasonOf(ws.dirList("w", "", PAGE))).reason).toBe(ErrorReason.SECRET_FILE);
  });

  it("refuse a hard link, which may be a key file under another name", async () => {
    const { ws, dir, base } = setup();
    writeFileSync(join(base, "id_key"), "PRIVATE KEY\n");
    linkSync(join(base, "id_key"), join(dir, "innocent.txt"));
    expect((await reasonOf(ws.fileRead("w", "innocent.txt"))).reason).toBe(ErrorReason.SECRET_FILE);
  });
});

describe("Git LFS", () => {
  function lfsRepo() {
    const s = setup();
    withRemote(s.base, s.dir);
    writeFileSync(join(s.dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(s.dir, "x.bin"), "binary\n");
    commitAll(s.dir, "lfs");
    return s;
  }

  it("runs git lfs pre-push with the refs before pushing", async () => {
    if (!posix) return;
    const { ws, dir, base } = lfsRepo();
    const log = join(base, "lfs.log");
    onPath("git-lfs", `echo "args: $*" >> "${log}"\ncat >> "${log}"`);
    try {
      await ws.push("w", "dev");
    } finally {
      vi.unstubAllEnvs();
    }
    const head = git(dir, "rev-parse", "HEAD").trim();
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain(`args: pre-push origin ${join(base, "remote.git")}`);
    expect(logged).toMatch(new RegExp(`refs/heads/main ${head} refs/heads/main [0-9a-f]{40}`));
  });

  it("refuses to push without git-lfs, pushing nothing", async () => {
    const { ws, dir, base } = lfsRepo();
    expect((await reasonOf(ws.push("w", "dev"))).reason).toBe(ErrorReason.GIT_LFS_MISSING);
    expect(git(join(base, "remote.git"), "rev-parse", "main").trim()).not.toBe(git(dir, "rev-parse", "HEAD").trim());
  });

  it("refuses when git lfs pre-push fails", async () => {
    if (!posix) return;
    const { ws } = lfsRepo();
    onPath("git-lfs", 'if [ "$1" = version ]; then exit 0; fi\nexit 2');
    try {
      expect((await reasonOf(ws.push("w", "dev"))).reason).toBe(ErrorReason.GIT_FAILED);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the repository's top folder", () => {
  it("is required: a folder inside a larger repository gets no git", async () => {
    const dir = repo();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a.txt"), "a\n");
    const { ws } = workspaces({ s: join(dir, "sub") });
    for (const op of [() => ws.status("s"), () => ws.stage("s", ["a.txt"], false, "dev"), () => ws.log("s", "", 0, 0), () => ws.commit("s", "m", "dev")]) {
      expect((await reasonOf(op())).reason).toBe(ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT);
    }
    // The Explorer still lists the folder, without git's marks.
    expect((await ws.dirList("s", "", PAGE)).entries).toMatchObject([{ name: "a.txt", git: "" }]);
  });

  it("refuses a repository whose own config moves its work tree", async () => {
    const { ws, dir, base } = setup();
    mkdirSync(join(base, "elsewhere"));
    git(dir, "config", "core.worktree", join(base, "elsewhere"));
    for (const op of [() => ws.status("w"), () => ws.stage("w", [], true, "dev")]) {
      expect(await reasonOf(op())).toMatchObject({ reason: ErrorReason.GIT_UNSAFE_CONFIG, subject: "core.worktree" });
    }
  });
});

describe("the repository's own network settings", () => {
  const keys: [string, string][] = [
    ["http.sslVerify", "false"],
    ["http.https://example.com/.sslVerify", "no"],
    ["http.proxy", "http://127.0.0.1:9"],
    ["http.sslCAInfo", "/tmp/ca.pem"],
    ["http.sslCAPath", "/tmp/ca"],
    ["http.curloptResolve", "example.com:443:127.0.0.1"],
    ["http.extraHeader", "Authorization: x"],
    ["remote.origin.proxy", "http://127.0.0.1:9"],
  ];

  it.each(keys)("refuses fetch, pull and push when it sets %s", async (key, value) => {
    const { ws, dir, base } = setup();
    withRemote(base, dir);
    git(dir, "config", key, value);
    for (const op of [() => ws.fetch("w"), () => ws.pull("w", "dev"), () => ws.push("w", "dev")]) {
      const r = await reasonOf(op());
      expect(r.reason).toBe(ErrorReason.GIT_UNSAFE_CONFIG);
      expect(r.subject.toLowerCase()).toBe(key.toLowerCase());
    }
    writeFileSync(join(dir, "a.txt"), "changed\n");
    expect((await ws.stage("w", ["a.txt"], false, "dev")).entries).toMatchObject([{ area: "staged" }]);
  });

  it("leaves TLS verification on as it is by default", async () => {
    const { ws, dir, base } = setup();
    withRemote(base, dir);
    git(dir, "config", "http.sslVerify", "true");
    await ws.fetch("w");
  });
});

describe("config changed by a command", () => {
  it("is noticed after a write or network command", async () => {
    if (!posix) return;
    onPath("git-remote-cfg", `git config credential.helper '!touch MARKER'\nexit 1`);
    const { ws, dir } = setup({ extraGitConfig: [...TEST_GIT_CONFIG, "-c", "protocol.cfg.allow=always"] });
    git(dir, "remote", "add", "origin", "cfg::nowhere");
    try {
      const r = await reasonOf(ws.fetch("w"));
      expect(r).toMatchObject({ reason: ErrorReason.GIT_UNSAFE_CONFIG, subject: "credential.helper" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("signing", () => {
  it("refuses a commit git would sign, and signs nothing otherwise", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    git(dir, "add", "a.txt");
    git(dir, "config", "commit.gpgSign", "true");
    expect((await reasonOf(ws.commit("w", "signed?", "dev"))).reason).toBe(ErrorReason.GIT_COMMIT_SIGNING);
    git(dir, "config", "commit.gpgSign", "false");
    git(dir, "config", "gpg.format", "ssh");
    expect((await reasonOf(ws.commit("w", "signed?", "dev"))).reason).toBe(ErrorReason.GIT_COMMIT_SIGNING);
    git(dir, "config", "--unset", "gpg.format");
    await ws.commit("w", "plain", "dev");
    expect(git(dir, "cat-file", "commit", "HEAD")).not.toContain("gpgsig");
  });
});

describe("operations in progress and detached HEAD", () => {
  it("refuses commit, checkout and pull during a merge", async () => {
    const { ws, dir } = setup();
    git(dir, "switch", "-q", "-c", "side");
    writeFileSync(join(dir, "a.txt"), "side\n");
    commitAll(dir, "side");
    git(dir, "switch", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "main\n");
    commitAll(dir, "main");
    try {
      git(dir, "merge", "-q", "side");
    } catch {
      // conflict
    }
    for (const op of [() => ws.commit("w", "m", "dev"), () => ws.checkout("w", "side", "dev"), () => ws.pull("w", "dev")]) {
      expect(await reasonOf(op())).toMatchObject({ reason: ErrorReason.GIT_OPERATION_IN_PROGRESS, subject: "merge" });
    }
  });

  it("commits on a detached HEAD only when asked to", async () => {
    const { ws, dir } = setup();
    git(dir, "checkout", "-q", "--detach");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    git(dir, "add", "a.txt");
    expect((await reasonOf(ws.commit("w", "m", "dev"))).reason).toBe(ErrorReason.GIT_DETACHED_HEAD);
    expect((await ws.commit("w", "m", "dev", { allowDetached: true })).subject).toBe("m");
  });
});

describe("secret files and the index", () => {
  it("are staged and committed only when the request names them", async () => {
    const { ws, dir } = setup();
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    let r = await reasonOf(ws.stage("w", [".env", "b.txt"], false, "dev"));
    expect(r).toMatchObject({ code: ErrorCode.NEEDS_CONSENT, reason: ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, subject: ".env" });
    expect((await reasonOf(ws.stage("w", [], true, "dev"))).subject).toBe(".env");
    await ws.stage("w", [".env", "b.txt"], false, "dev", [".env"]);
    r = await reasonOf(ws.commit("w", "with secret", "dev"));
    expect(r).toMatchObject({ reason: ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, subject: ".env" });
    expect((await ws.commit("w", "with secret", "dev", { confirmSensitive: [".env"] })).subject).toBe("with secret");
  });
});

describe("secret names", () => {
  it("cover key backups, tokens, state files and names hidden by invisible characters", () => {
    for (const s of ["id_rsa.bak", "id_ed25519.old", "id_rsa~", ".vault-token", "terraform.tfstate", "prod.tfstate.backup", "service-account-prod.json", ".my.cnf", ".git​", ".e​nv", "﻿.env", ".GIT"]) {
      expect(isSecretName(s), JSON.stringify(s)).toBe(true);
    }
    expect(isSecretName("id_rsa.pub")).toBe(false);
  });
});

describe("watch requests", () => {
  const manual = (): { fileWatch: FileWatch } => ({ fileWatch: () => () => undefined });

  it("apply in order: on then off sent together leaves nothing watched", async () => {
    const dir = repo();
    const { ws } = workspaces({ w: dir }, manual());
    const link = new WorkspaceLink(ws, () => undefined, () => "dev");
    await Promise.all([
      link.handle("1", { case: "wsWatch", value: create(WsWatchSchema, { workspaceId: "w", on: true }) }),
      link.handle("2", { case: "wsWatch", value: create(WsWatchSchema, { workspaceId: "w", on: false }) }),
    ]);
    expect(ws.watched).toBe(0);
    await Promise.all([
      link.handle("3", { case: "wsWatch", value: create(WsWatchSchema, { workspaceId: "w", on: false }) }),
      link.handle("4", { case: "wsWatch", value: create(WsWatchSchema, { workspaceId: "w", on: true }) }),
    ]);
    expect(ws.watched).toBe(1);
    link.close();
    expect(ws.watched).toBe(0);
  });

  it("say when watching falls back to polling", async () => {
    const dir = repo();
    const failing: FileWatch = (_root, _onEvent, onError) => {
      onError();
      return () => undefined;
    };
    const { ws } = workspaces({ w: dir }, { fileWatch: failing });
    const changes: WorkspaceChange[] = [];
    const stop = await ws.watch("w", (c) => changes.push(c));
    expect(changes).toEqual([{ dirs: [], overflow: false, git: false, polling: true }]);
    stop();
  });
});

describe("errors a device gets", () => {
  it("never carry an absolute path of the machine", async () => {
    const { ws, dir, audit } = setup();
    const { core } = makeCore([fakeProvider()]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, workspaces: ws });
    const asks = [
      { case: "wsFileRead", value: { workspaceId: "w", path: "missing/file.txt" } },
      { case: "wsDirList", value: { workspaceId: "w", path: "a.txt" } },
      { case: "wsDirList", value: { workspaceId: "w", path: "gone" } },
    ] as const;
    let i = 0;
    for (const body of asks) {
      const f = await device.request(String(++i), body);
      expect(f.body.case).toBe("error");
      expect(JSON.stringify(f.body.value)).not.toContain(dir);
      expect(JSON.stringify(f.body.value)).not.toContain(tempDir().split("/").slice(0, 4).join("/"));
    }
    device.close();
  });
});

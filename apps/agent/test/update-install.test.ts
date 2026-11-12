// `tunelo update` and `tunelo update --rollback` against a fake GitHub that
// serves release archives packed with the real tar and zip: the archive and
// both files inside it (tunelo and its terminal process) are verified before
// anything on disk changes, the terminal process is staged for the supervisor
// to switch to, and a rollback checks the previous release again first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERM_HOST_BINARY, switchStagedTermHost } from "../src/terminal/host-supervisor.ts";
import { type UpdateEnv, archiveName, assetName, rollback, signedComment, termHostAssetName, update } from "../src/update.ts";
import { type TestSigner, testSigner } from "./support/minisign-sign.ts";

const RELEASES_URL = "https://api.github.com/repos/achoo254/chat-next/releases?per_page=100";

type Platform = { os: NodeJS.Platform; cpu: NodeJS.Architecture; agent: string; host: string; archive: string };
const platformOf = (os: NodeJS.Platform, cpu: NodeJS.Architecture): Platform => ({
  os,
  cpu,
  agent: assetName(os, cpu),
  host: termHostAssetName(os, cpu),
  archive: archiveName(os, cpu),
});
const MAC = platformOf("darwin", "arm64");
const WINDOWS = platformOf("win32", "x64");

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (path: string) => readFileSync(path, "utf8");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the fake server answers for a file: its bytes, a body that breaks halfway, or 404. */
type Served = Uint8Array<ArrayBuffer> | "breaks-halfway" | "missing";

type FakeRelease = { version: string; files: Map<string, Served> };

/** Packs files into a release archive with the system's tar or zip, as the release workflow does. */
function pack(archive: string, files: ReadonlyMap<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), "tunelo-pack-"));
  try {
    for (const [name, content] of files) writeFileSync(join(dir, name), content, { mode: 0o755 });
    const names = [...files.keys()];
    const run = archive.endsWith(".zip")
      ? spawnSync("zip", ["-q", "-X", archive, ...names], { cwd: dir })
      : // No macOS metadata entries (._name) in the archive.
        spawnSync("tar", ["--format=ustar", "-czf", archive, ...names], { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    if (run.status !== 0) throw new Error(`packing ${archive} failed: ${String(run.stderr)}`);
    return new Uint8Array(readFileSync(join(dir, archive)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const agentBytes = (version: string) => bytes(`tunelo agent ${version}`);
const hostBytes = (version: string) => bytes(`tunelo-term-host ${version}`);

/** The files inside an archive: both programs, each with its signature. */
function innerFiles(signer: TestSigner, version: string, p: Platform): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [p.agent, agentBytes(version)],
    [`${p.agent}.minisig`, bytes(signer.sign(agentBytes(version), signedComment(version, p.agent)))],
    [p.host, hostBytes(version)],
    [`${p.host}.minisig`, bytes(signer.sign(hostBytes(version), signedComment(version, p.host)))],
  ]);
}

/** A signed release for one platform; `edit` changes the files packed into the archive. */
function release(signer: TestSigner, version: string, opts: { platform?: Platform; edit?: (inner: Map<string, Uint8Array>) => void } = {}): FakeRelease {
  const p = opts.platform ?? MAC;
  const inner = innerFiles(signer, version, p);
  opts.edit?.(inner);
  const archive = pack(p.archive, inner);
  const sums = bytes(`${sha256(archive)}  ${p.archive}\n`);
  return {
    version,
    files: new Map<string, Served>([
      [p.archive, archive],
      [`${p.archive}.minisig`, bytes(signer.sign(archive, signedComment(version, p.archive)))],
      ["SHA256SUMS", sums],
      ["SHA256SUMS.minisig", bytes(signer.sign(sums, signedComment(version, "SHA256SUMS")))],
    ]),
  };
}

function fakeGitHub(releases: FakeRelease[]): typeof fetch {
  const served = (url: string): Served | undefined => {
    const m = /^https:\/\/(?:dl|api)\.test\/([^/]+)\/(.+)$/.exec(url);
    return m ? releases.find((r) => r.version === m[1])?.files.get(m[2] ?? "") : undefined;
  };
  const get = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === RELEASES_URL) {
      return Response.json(
        releases.map((r) => ({
          tag_name: `tunelo-v${r.version}`,
          draft: false,
          prerelease: false,
          assets: [...r.files.entries()]
            .filter(([, content]) => content !== "missing")
            .map(([name, content]) => ({
              name,
              url: `https://api.test/${r.version}/${name}`,
              browser_download_url: `https://dl.test/${r.version}/${name}`,
              size: content instanceof Uint8Array ? content.length : 1000,
            })),
        })),
      );
    }
    const content = served(url);
    if (content === "breaks-halfway") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("first half"));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    }
    if (content instanceof Uint8Array) return new Response(content, { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return get as typeof fetch;
}

let root: string;
let signer: TestSigner;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tunelo-update-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "bin", "tunelo"), agentBytes("3.0.0"), { mode: 0o755 });
  signer = testSigner();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const exe = () => join(root, "bin", "tunelo");
const hostDir = () => join(root, "config", "term-host");
const staged = () => join(hostDir(), "bin", "next", TERM_HOST_BINARY);
const current = () => join(hostDir(), "bin", "current", TERM_HOST_BINARY);
const record = () => join(root, "config", "update-rollback.json");

function env(releases: FakeRelease[], over: Partial<UpdateEnv> = {}): UpdateEnv {
  return { configDir: join(root, "config"), execPath: exe(), currentVersion: "3.0.0", os: "darwin", cpu: "arm64", pubkey: signer.pubkey, fetch: fakeGitHub(releases), processEnv: {}, ...over };
}

const quiet = () => undefined;

/** The bytes a fake release serves for one of its files. */
function fileOf(r: FakeRelease, name: string): Uint8Array {
  const content = r.files.get(name);
  if (!(content instanceof Uint8Array)) throw new Error(`${name} is not in the release`);
  return content;
}

/** Signs the file of a release again, for another version or with another key. */
function resign(r: FakeRelease, name: string, comment: string, by: TestSigner = signer): void {
  r.files.set(`${name}.minisig`, bytes(by.sign(fileOf(r, name), comment)));
}

describe("tunelo update", () => {
  it("verifies the archive and both files in it, keeps the terminal process by version, puts it in place, then swaps tunelo", async () => {
    mkdirSync(join(hostDir(), "versions", "2.9.0"), { recursive: true });
    const progress: [number, number][] = [];
    const phases: string[] = [];
    const next = release(signer, "3.0.1");
    const installed = await update(quiet, (r, t) => progress.push([r, t]), (p) => phases.push(p), env([next]));

    expect(installed).toBe("3.0.1");
    expect(phases).toEqual(["verifying", "installing"]);
    expect(text(exe())).toBe("tunelo agent 3.0.1");
    expect(text(`${exe()}.old`)).toBe("tunelo agent 3.0.0");
    expect(existsSync(`${exe()}.new`)).toBe(false);
    const kept = join(hostDir(), "versions", "3.0.1");
    expect(text(join(kept, TERM_HOST_BINARY))).toBe("tunelo-term-host 3.0.1");
    // The signature from inside the archive names the version the supervisor reads.
    expect(text(join(kept, `${TERM_HOST_BINARY}.minisig`))).toContain(`trusted comment: ${signedComment("3.0.1", MAC.host)}`);
    // No terminal process ran from the config folder yet: it goes straight to bin/current.
    expect(text(current())).toBe("tunelo-term-host 3.0.1");
    expect(existsSync(staged())).toBe(false);
    // Releases no update or rollback needs any more are removed.
    expect(existsSync(join(hostDir(), "versions", "2.9.0"))).toBe(false);
    expect(JSON.parse(text(record()))).toEqual({ from: "3.0.0", to: "3.0.1" });
    const size = fileOf(next, MAC.archive).length;
    expect(progress.at(-1)).toEqual([size, size]);
  });

  it("unpacks the Windows zip the same way", async () => {
    const installed = await update(quiet, undefined, undefined, env([release(signer, "3.0.1", { platform: WINDOWS })], { os: "win32", cpu: "x64" }));
    expect(installed).toBe("3.0.1");
    expect(text(exe())).toBe("tunelo agent 3.0.1");
    expect(text(current())).toBe("tunelo-term-host 3.0.1");
  });

  it("never updates to a test release (tunelo-v<version>-rc.<n>), even one not marked prerelease", async () => {
    const releases = [release(signer, "3.0.1"), release(signer, "3.1.0-rc.1")];
    expect(await update(quiet, undefined, undefined, env(releases))).toBe("3.0.1");
    expect(text(exe())).toBe("tunelo agent 3.0.1");
  });

  it("leaves the running terminal process alone; its sessions keep it until the supervisor switches", async () => {
    mkdirSync(join(hostDir(), "bin", "current"), { recursive: true });
    writeFileSync(current(), hostBytes("3.0.0"));
    await update(quiet, undefined, undefined, env([release(signer, "3.0.1")]));
    expect(text(current())).toBe("tunelo-term-host 3.0.0");
    expect(switchStagedTermHost(join(root, "config"))).toBe(true);
    expect(text(current())).toBe("tunelo-term-host 3.0.1");
  });

  it("an archive download that breaks halfway leaves tunelo as it was, and a second try works", async () => {
    const broken = release(signer, "3.0.1");
    broken.files.set(MAC.archive, "breaks-halfway");
    await expect(update(quiet, undefined, undefined, env([broken]))).rejects.toThrow(/connection reset/);
    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(`${exe()}.new`)).toBe(false);
    expect(existsSync(hostDir())).toBe(false);
    expect(existsSync(record())).toBe(false);

    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.1")]))).toBe("3.0.1");
    expect(text(exe())).toBe("tunelo agent 3.0.1");
  });

  it("refuses an archive that is missing, unsigned by the key, signed for another version, or not the one in SHA256SUMS", async () => {
    const missing = release(signer, "3.0.1");
    missing.files.set(MAC.archive, "missing");
    await expect(update(quiet, undefined, undefined, env([missing]))).rejects.toThrow(`tunelo 3.0.1 has no ${MAC.archive}`);

    const otherKey = release(signer, "3.0.1");
    resign(otherKey, MAC.archive, signedComment("3.0.1", MAC.archive), testSigner());
    await expect(update(quiet, undefined, undefined, env([otherKey]))).rejects.toThrow(`signature check of ${MAC.archive} failed`);

    const olderSigned = release(signer, "3.0.1");
    resign(olderSigned, MAC.archive, signedComment("3.0.0", MAC.archive));
    await expect(update(quiet, undefined, undefined, env([olderSigned]))).rejects.toThrow("is for another file or version");

    const wrongSum = release(signer, "3.0.1");
    wrongSum.files.set("SHA256SUMS", bytes(`${"0".repeat(64)}  ${MAC.archive}\n`));
    resign(wrongSum, "SHA256SUMS", signedComment("3.0.1", "SHA256SUMS"));
    await expect(update(quiet, undefined, undefined, env([wrongSum]))).rejects.toThrow(`${MAC.archive} does not match its SHA-256`);

    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(hostDir())).toBe(false);
  });

  it("refuses a signed archive whose files inside are missing, unsigned by the key, or signed for another version", async () => {
    const noHost = release(signer, "3.0.1", { edit: (inner) => inner.delete(MAC.host) });
    await expect(update(quiet, undefined, undefined, env([noHost]))).rejects.toThrow(`${MAC.archive} of tunelo 3.0.1 has no ${MAC.host}`);

    const noSig = release(signer, "3.0.1", { edit: (inner) => inner.delete(`${MAC.agent}.minisig`) });
    await expect(update(quiet, undefined, undefined, env([noSig]))).rejects.toThrow(`has no ${MAC.agent}.minisig`);

    const otherKey = release(signer, "3.0.1", {
      edit: (inner) => inner.set(`${MAC.host}.minisig`, bytes(testSigner().sign(hostBytes("3.0.1"), signedComment("3.0.1", MAC.host)))),
    });
    await expect(update(quiet, undefined, undefined, env([otherKey]))).rejects.toThrow(`signature check of ${MAC.host} failed`);

    const olderAgent = release(signer, "3.0.1", {
      edit: (inner) => {
        inner.set(MAC.agent, agentBytes("3.0.0"));
        inner.set(`${MAC.agent}.minisig`, bytes(signer.sign(agentBytes("3.0.0"), signedComment("3.0.0", MAC.agent))));
      },
    });
    await expect(update(quiet, undefined, undefined, env([olderAgent]))).rejects.toThrow("is for another file or version");

    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(hostDir())).toBe(false);
  });

  it("refuses a signed archive that does not unpack", async () => {
    const garbage = release(signer, "3.0.1");
    const junk = bytes("not a gzip stream");
    garbage.files.set(MAC.archive, junk);
    resign(garbage, MAC.archive, signedComment("3.0.1", MAC.archive));
    const sums = bytes(`${sha256(junk)}  ${MAC.archive}\n`);
    garbage.files.set("SHA256SUMS", sums);
    resign(garbage, "SHA256SUMS", signedComment("3.0.1", "SHA256SUMS"));
    await expect(update(quiet, undefined, undefined, env([garbage]))).rejects.toThrow(`${MAC.archive} could not be unpacked`);
    expect(text(exe())).toBe("tunelo agent 3.0.0");
  });

  it("is a no-op when the running tunelo is the newest and has its terminal process", async () => {
    writeFileSync(join(root, "bin", TERM_HOST_BINARY), hostBytes("3.0.0"));
    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.0")]))).toBeNull();
    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(hostDir())).toBe(false);
    // Named by the environment counts as present too.
    rmSync(join(root, "bin", TERM_HOST_BINARY));
    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.0")], { processEnv: { TUNELO_TERM_HOST_BIN: "/elsewhere" } }))).toBeNull();
    expect(existsSync(hostDir())).toBe(false);
  });

  it("installs the missing terminal process of the running release from its archive, leaving tunelo itself alone", async () => {
    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.0")]))).toBe("3.0.0");
    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(record())).toBe(false);
    expect(text(current())).toBe("tunelo-term-host 3.0.0");
    expect(text(join(hostDir(), "versions", "3.0.0", TERM_HOST_BINARY))).toBe("tunelo-term-host 3.0.0");
    // Present now: nothing more to do.
    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.0")]))).toBeNull();
  });

  it("leaves the machine untouched when the missing terminal process does not verify", async () => {
    const bad = release(signer, "3.0.0", {
      edit: (inner) => inner.set(`${MAC.host}.minisig`, bytes(testSigner().sign(hostBytes("3.0.0"), signedComment("3.0.0", MAC.host)))),
    });
    await expect(update(quiet, undefined, undefined, env([bad]))).rejects.toThrow(`signature check of ${MAC.host} failed`);
    expect(existsSync(hostDir())).toBe(false);
    // None published for this version (a development build): nothing to install.
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.9.0")]))).toBeNull();
    expect(existsSync(hostDir())).toBe(false);
  });

  it("runs one update or rollback at a time per config folder", async () => {
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    const results = await Promise.allSettled([update(quiet, undefined, undefined, env(releases)), update(quiet, undefined, undefined, env(releases))]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((x) => x.status === "rejected");
    expect(refused?.status === "rejected" ? String(refused.reason) : "").toMatch(/another tunelo update or rollback is running/);
    expect(text(exe())).toBe("tunelo agent 3.0.1");
    expect(existsSync(join(root, "config", "update.lock"))).toBe(false);

    const both = await Promise.allSettled([rollback(quiet, env(releases, { currentVersion: "3.0.1" })), update(quiet, undefined, undefined, env(releases, { currentVersion: "3.0.1" }))]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("takes over a lock left by a process that is gone", async () => {
    writeFileSync(join(root, "config", "update.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await update(quiet, undefined, undefined, env([release(signer, "3.0.1")]))).toBe("3.0.1");
    expect(existsSync(join(root, "config", "update.lock"))).toBe(false);
  });
});

describe("tunelo update --rollback", () => {
  it("puts back tunelo and points the terminal process at the previous release (installed by the script)", async () => {
    // The install script put 3.0.0's terminal process next to tunelo.
    writeFileSync(join(root, "bin", TERM_HOST_BINARY), hostBytes("3.0.0"));
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    await update(quiet, undefined, undefined, env(releases));
    expect(text(current())).toBe("tunelo-term-host 3.0.1");

    expect(await rollback(quiet, env(releases, { currentVersion: "3.0.1" }))).toBe("3.0.0");
    expect(text(exe())).toBe("tunelo agent 3.0.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(`${exe()}.rollback`)).toBe(false);
    expect(existsSync(record())).toBe(false);
    // The open terminal keeps 3.0.1 until the supervisor switches with no terminal running.
    expect(text(current())).toBe("tunelo-term-host 3.0.1");
    expect(text(staged())).toBe("tunelo-term-host 3.0.0");
    expect(text(`${staged()}.minisig`)).toContain(`trusted comment: ${signedComment("3.0.0", MAC.host)}`);
    switchStagedTermHost(join(root, "config"));
    expect(text(current())).toBe("tunelo-term-host 3.0.0");
  });

  it("drops a staged terminal process the supervisor never switched to", async () => {
    mkdirSync(join(hostDir(), "bin", "current"), { recursive: true });
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    writeFileSync(current(), hostBytes("3.0.0"));
    writeFileSync(`${current()}.minisig`, signer.sign(hostBytes("3.0.0"), signedComment("3.0.0", MAC.host)));
    await update(quiet, undefined, undefined, env(releases));
    expect(text(staged())).toBe("tunelo-term-host 3.0.1");

    await rollback(quiet, env(releases, { currentVersion: "3.0.1" }));
    expect(existsSync(staged())).toBe(false);
    expect(text(current())).toBe("tunelo-term-host 3.0.0");
  });

  it("takes the previous terminal process from that release's archive", async () => {
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    await update(quiet, undefined, undefined, env(releases));
    await rollback(quiet, env(releases, { currentVersion: "3.0.1" }));
    expect(text(staged())).toBe("tunelo-term-host 3.0.0");
    expect(text(join(hostDir(), "versions", "3.0.0", TERM_HOST_BINARY))).toBe("tunelo-term-host 3.0.0");
  });

  it("changes nothing when the previous tunelo is not the signed one", async () => {
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    await update(quiet, undefined, undefined, env(releases));
    writeFileSync(`${exe()}.old`, "tampered");
    await expect(rollback(quiet, env(releases, { currentVersion: "3.0.1" }))).rejects.toThrow("is not the signed tunelo 3.0.0");
    expect(text(exe())).toBe("tunelo agent 3.0.1");
    expect(text(current())).toBe("tunelo-term-host 3.0.1");
    expect(existsSync(staged())).toBe(false);
    expect(existsSync(record())).toBe(true);
  });

  it("changes nothing when the previous release's archive does not verify", async () => {
    const releases = [release(signer, "3.0.0"), release(signer, "3.0.1")];
    await update(quiet, undefined, undefined, env(releases));
    const [previous] = releases;
    if (!previous) throw new Error("no previous release");
    resign(previous, MAC.archive, signedComment("3.0.0", MAC.archive), testSigner());
    await expect(rollback(quiet, env(releases, { currentVersion: "3.0.1" }))).rejects.toThrow(`signature check of ${MAC.archive} failed`);
    expect(text(exe())).toBe("tunelo agent 3.0.1");
    expect(existsSync(record())).toBe(true);
  });

  it("says there is nothing to roll back without an update recorded", async () => {
    await expect(rollback(quiet, env([release(signer, "3.0.0")]))).rejects.toThrow("nothing to roll back");
    expect(text(exe())).toBe("tunelo agent 3.0.0");
  });
});

// `tunelo update` and `tunelo update --rollback` against a fake GitHub:
// both files (tunelo and its terminal process) are verified before anything
// on disk changes, the terminal process is staged for the supervisor to
// switch to, and a rollback checks the previous release again first.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERM_HOST_BINARY, switchStagedTermHost } from "../src/terminal/host-supervisor.ts";
import { type UpdateEnv, rollback, signedComment, update } from "../src/update.ts";
import { type TestSigner, testSigner } from "./support/minisign-sign.ts";

const AGENT = "tunelo-darwin-arm64";
const HOST = "tunelo-term-host-darwin-arm64";
const RELEASES_URL = "https://api.github.com/repos/achoo254/chat-next/releases?per_page=100";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (path: string) => readFileSync(path, "utf8");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** What the fake server answers for a file: its bytes, a body that breaks halfway, or 404. */
type Served = Uint8Array<ArrayBuffer> | "breaks-halfway" | "missing";

type FakeRelease = { version: string; files: Map<string, Served> };

/** The files of a signed release; `withHost: false` is a release from before the terminal. */
function release(signer: TestSigner, version: string, opts: { withHost?: boolean } = {}): FakeRelease {
  const files = new Map<string, Served>();
  const add = (name: string, content: Uint8Array<ArrayBuffer>) => {
    files.set(name, content);
    files.set(`${name}.minisig`, bytes(signer.sign(content, signedComment(version, name))));
  };
  add(AGENT, agentBytes(version));
  if (opts.withHost !== false) {
    add(HOST, hostBytes(version));
    add("SHA256SUMS", bytes(`${sha256(agentBytes(version))}  ${AGENT}\n${sha256(hostBytes(version))}  ${HOST}\n`));
  }
  return { version, files };
}

const agentBytes = (version: string) => bytes(`tunelo agent ${version}`);
const hostBytes = (version: string) => bytes(`tunelo-term-host ${version}`);

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
  writeFileSync(join(root, "bin", "tunelo"), agentBytes("2.4.0"), { mode: 0o755 });
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
  return { configDir: join(root, "config"), execPath: exe(), currentVersion: "2.4.0", os: "darwin", cpu: "arm64", pubkey: signer.pubkey, fetch: fakeGitHub(releases), processEnv: {}, ...over };
}

const quiet = () => undefined;

describe("tunelo update", () => {
  it("verifies both files, keeps the terminal process by version, puts it in place, then swaps tunelo", async () => {
    mkdirSync(join(hostDir(), "versions", "2.3.0"), { recursive: true });
    const progress: [number, number][] = [];
    const phases: string[] = [];
    const installed = await update(quiet, (r, t) => progress.push([r, t]), (p) => phases.push(p), env([release(signer, "2.5.0")]));

    expect(installed).toBe("2.5.0");
    expect(phases).toEqual(["verifying", "installing"]);
    expect(text(exe())).toBe("tunelo agent 2.5.0");
    expect(text(`${exe()}.old`)).toBe("tunelo agent 2.4.0");
    expect(existsSync(`${exe()}.new`)).toBe(false);
    expect(text(join(hostDir(), "versions", "2.5.0", TERM_HOST_BINARY))).toBe("tunelo-term-host 2.5.0");
    // No terminal process ran from the config folder yet: it goes straight to bin/current.
    expect(text(current())).toBe("tunelo-term-host 2.5.0");
    expect(existsSync(staged())).toBe(false);
    // Releases no update or rollback needs any more are removed.
    expect(existsSync(join(hostDir(), "versions", "2.3.0"))).toBe(false);
    expect(JSON.parse(text(record()))).toEqual({ from: "2.4.0", to: "2.5.0" });
    const total = agentBytes("2.5.0").length + hostBytes("2.5.0").length;
    expect(progress.at(-1)).toEqual([total, total]);
  });

  it("leaves the running terminal process alone; its sessions keep it until the supervisor switches", async () => {
    mkdirSync(join(hostDir(), "bin", "current"), { recursive: true });
    writeFileSync(current(), hostBytes("2.4.0"));
    await update(quiet, undefined, undefined, env([release(signer, "2.5.0")]));
    expect(text(current())).toBe("tunelo-term-host 2.4.0");
    expect(switchStagedTermHost(join(root, "config"))).toBe(true);
    expect(text(current())).toBe("tunelo-term-host 2.5.0");
  });

  it("a terminal process download that breaks halfway leaves tunelo as it was, and a second try works", async () => {
    const broken = release(signer, "2.5.0");
    broken.files.set(HOST, "breaks-halfway");
    await expect(update(quiet, undefined, undefined, env([broken]))).rejects.toThrow(/connection reset/);
    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(`${exe()}.new`)).toBe(false);
    expect(existsSync(hostDir())).toBe(false);
    expect(existsSync(record())).toBe(false);

    expect(await update(quiet, undefined, undefined, env([release(signer, "2.5.0")]))).toBe("2.5.0");
    expect(text(exe())).toBe("tunelo agent 2.5.0");
  });

  it("refuses a release whose terminal process is missing, unsigned by the key, or not the one in SHA256SUMS", async () => {
    const noHost = release(signer, "2.5.0");
    noHost.files.set(HOST, "missing");
    await expect(update(quiet, undefined, undefined, env([noHost]))).rejects.toThrow(`tunelo 2.5.0 has no ${HOST}`);

    const otherKey = release(signer, "2.5.0");
    otherKey.files.set(`${HOST}.minisig`, bytes(testSigner().sign(hostBytes("2.5.0"), signedComment("2.5.0", HOST))));
    await expect(update(quiet, undefined, undefined, env([otherKey]))).rejects.toThrow(`signature check of ${HOST} failed`);

    const olderSigned = release(signer, "2.5.0");
    olderSigned.files.set(`${HOST}.minisig`, bytes(signer.sign(hostBytes("2.5.0"), signedComment("2.4.0", HOST))));
    await expect(update(quiet, undefined, undefined, env([olderSigned]))).rejects.toThrow("is for another file or version");

    const wrongSum = release(signer, "2.5.0");
    const sums = bytes(`${sha256(agentBytes("2.5.0"))}  ${AGENT}\n${"0".repeat(64)}  ${HOST}\n`);
    wrongSum.files.set("SHA256SUMS", sums);
    wrongSum.files.set("SHA256SUMS.minisig", bytes(signer.sign(sums, signedComment("2.5.0", "SHA256SUMS"))));
    await expect(update(quiet, undefined, undefined, env([wrongSum]))).rejects.toThrow(`${HOST} does not match its SHA-256`);

    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(hostDir())).toBe(false);
  });

  it("is a no-op when the running tunelo is the newest and has its terminal process", async () => {
    writeFileSync(join(root, "bin", TERM_HOST_BINARY), hostBytes("2.4.0"));
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.4.0")]))).toBeNull();
    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(hostDir())).toBe(false);
    // Named by the environment counts as present too.
    rmSync(join(root, "bin", TERM_HOST_BINARY));
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.4.0")], { processEnv: { TUNELO_TERM_HOST_BIN: "/elsewhere" } }))).toBeNull();
    expect(existsSync(hostDir())).toBe(false);
  });

  it("installs the missing terminal process of the running release, leaving tunelo itself alone", async () => {
    // Updated from a release before the terminal: tunelo is the newest, its terminal process is missing.
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.4.0")]))).toBe("2.4.0");
    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(record())).toBe(false);
    expect(text(current())).toBe("tunelo-term-host 2.4.0");
    expect(text(join(hostDir(), "versions", "2.4.0", TERM_HOST_BINARY))).toBe("tunelo-term-host 2.4.0");
    // Present now: nothing more to do.
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.4.0")]))).toBeNull();
  });

  it("leaves the machine untouched when the missing terminal process does not verify", async () => {
    const bad = release(signer, "2.4.0");
    bad.files.set(`${HOST}.minisig`, bytes(testSigner().sign(hostBytes("2.4.0"), signedComment("2.4.0", HOST))));
    await expect(update(quiet, undefined, undefined, env([bad]))).rejects.toThrow(`signature check of ${HOST} failed`);
    expect(existsSync(hostDir())).toBe(false);
    // A release from before the terminal, or none published for this version: nothing to install.
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.4.0", { withHost: false })]))).toBeNull();
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.3.0")]))).toBeNull();
    expect(existsSync(hostDir())).toBe(false);
  });

  it("runs one update or rollback at a time per config folder", async () => {
    const releases = [release(signer, "2.4.0"), release(signer, "2.5.0")];
    const results = await Promise.allSettled([update(quiet, undefined, undefined, env(releases)), update(quiet, undefined, undefined, env(releases))]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((x) => x.status === "rejected");
    expect(refused?.status === "rejected" ? String(refused.reason) : "").toMatch(/another tunelo update or rollback is running/);
    expect(text(exe())).toBe("tunelo agent 2.5.0");
    expect(existsSync(join(root, "config", "update.lock"))).toBe(false);

    const both = await Promise.allSettled([rollback(quiet, env(releases, { currentVersion: "2.5.0" })), update(quiet, undefined, undefined, env(releases, { currentVersion: "2.5.0" }))]);
    expect(both.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("takes over a lock left by a process that is gone", async () => {
    writeFileSync(join(root, "config", "update.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await update(quiet, undefined, undefined, env([release(signer, "2.5.0")]))).toBe("2.5.0");
    expect(existsSync(join(root, "config", "update.lock"))).toBe(false);
  });
});

describe("tunelo update --rollback", () => {
  it("puts back tunelo and points the terminal process at the previous release (installed by the script)", async () => {
    // The install script put 2.4.0's terminal process next to tunelo.
    writeFileSync(join(root, "bin", TERM_HOST_BINARY), hostBytes("2.4.0"));
    const releases = [release(signer, "2.4.0"), release(signer, "2.5.0")];
    await update(quiet, undefined, undefined, env(releases));
    expect(text(current())).toBe("tunelo-term-host 2.5.0");

    expect(await rollback(quiet, env(releases, { currentVersion: "2.5.0" }))).toBe("2.4.0");
    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(`${exe()}.old`)).toBe(false);
    expect(existsSync(`${exe()}.rollback`)).toBe(false);
    expect(existsSync(record())).toBe(false);
    // The open terminal keeps 2.5.0 until the supervisor switches with no terminal running.
    expect(text(current())).toBe("tunelo-term-host 2.5.0");
    expect(text(staged())).toBe("tunelo-term-host 2.4.0");
    switchStagedTermHost(join(root, "config"));
    expect(text(current())).toBe("tunelo-term-host 2.4.0");
  });

  it("drops a staged terminal process the supervisor never switched to", async () => {
    mkdirSync(join(hostDir(), "bin", "current"), { recursive: true });
    const releases = [release(signer, "2.4.0"), release(signer, "2.5.0")];
    writeFileSync(current(), hostBytes("2.4.0"));
    writeFileSync(`${current()}.minisig`, signer.sign(hostBytes("2.4.0"), signedComment("2.4.0", HOST)));
    await update(quiet, undefined, undefined, env(releases));
    expect(text(staged())).toBe("tunelo-term-host 2.5.0");

    await rollback(quiet, env(releases, { currentVersion: "2.5.0" }));
    expect(existsSync(staged())).toBe(false);
    expect(text(current())).toBe("tunelo-term-host 2.4.0");
  });

  it("downloads the previous terminal process again when no copy on this machine verifies", async () => {
    const releases = [release(signer, "2.4.0"), release(signer, "2.5.0")];
    await update(quiet, undefined, undefined, env(releases));
    await rollback(quiet, env(releases, { currentVersion: "2.5.0" }));
    expect(text(staged())).toBe("tunelo-term-host 2.4.0");
    expect(text(join(hostDir(), "versions", "2.4.0", TERM_HOST_BINARY))).toBe("tunelo-term-host 2.4.0");
  });

  it("back to a release from before the terminal: tunelo only, nothing staged", async () => {
    const releases = [release(signer, "2.4.0", { withHost: false }), release(signer, "2.5.0")];
    await update(quiet, undefined, undefined, env(releases));
    expect(await rollback(quiet, env(releases, { currentVersion: "2.5.0" }))).toBe("2.4.0");
    expect(text(exe())).toBe("tunelo agent 2.4.0");
    expect(existsSync(staged())).toBe(false);
  });

  it("changes nothing when the previous tunelo no longer matches its signature", async () => {
    const releases = [release(signer, "2.4.0"), release(signer, "2.5.0")];
    await update(quiet, undefined, undefined, env(releases));
    writeFileSync(`${exe()}.old`, "tampered");
    await expect(rollback(quiet, env(releases, { currentVersion: "2.5.0" }))).rejects.toThrow(`signature check of ${AGENT} failed`);
    expect(text(exe())).toBe("tunelo agent 2.5.0");
    expect(text(current())).toBe("tunelo-term-host 2.5.0");
    expect(existsSync(staged())).toBe(false);
    expect(existsSync(record())).toBe(true);
  });

  it("says there is nothing to roll back without an update recorded", async () => {
    await expect(rollback(quiet, env([release(signer, "2.4.0")]))).rejects.toThrow("nothing to roll back");
    expect(text(exe())).toBe("tunelo agent 2.4.0");
  });
});

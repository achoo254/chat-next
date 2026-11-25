// The Observatory service: spool records reach the ingest redacted a second
// time with the machine's own secrets; the projects without content live in
// the config and state.json and the store are rebuilt from it (after many
// changes at once, after a broken state.json, after a wipe); a token file
// that cannot be read is never replaced; a rotation reaches the running
// receiver; and the service starts again after a stop.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import type { GhRunner } from "../../src/observatory/ci/gh-runner.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { FilteredRecord, ObservatorySink } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { OTLP_TOKEN_FILE } from "../../src/observatory/receiver/receiver-token.ts";
import { hookStatePath, readHookState } from "../../src/observatory/spool/hook-state-file.ts";
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";
import { SPOOL_GRACE_MS } from "../../src/observatory/spool/spool-files.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import type { LiveTailEvent } from "../../src/observatory/spool/spool-live-tail.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

type Made = { s: ObservatoryService; config: ConfigStore; data: string };

async function service(dir: string, sink: ObservatorySink = { accept: async () => undefined }, now: () => number = Date.now, runGh?: GhRunner): Promise<Made> {
  const config = new ConfigStore(join(dir, "config"));
  const port = await pickFreePort();
  config.update((c) => (c.observatory = { otlpPort: port ?? 47_399, enabled: true }));
  config.update((c) => (c.machineSecret = "example-machine-secret-value"));
  let pushed = 0;
  // A stand-in for the ingest: one prompt row per record.
  const ingest = (push: (op: WriteOp) => void): ObservatorySink => ({
    accept: async (record, origin) => {
      await sink.accept(record, origin);
      push({ kind: "prompt", row: { promptId: `p-${pushed++}`, sessionId: String(record.f.session_id), at: record.at } });
    },
  });
  const data = join(dir, "data");
  const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [config.get().machineSecret ?? ""], ingest, now, tokenTimings: { tokenRetryMs: [] }, ...(runGh ? { runGh } : {}) });
  await s.start();
  stops.push(() => s.stop());
  return { s, config, data };
}

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/logs", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end('{"resourceLogs":[]}');
  });
}

const tokenFile = (data: string): { current: string; previous?: string } => JSON.parse(readFileSync(join(data, OTLP_TOKEN_FILE), "utf8")) as { current: string; previous?: string };

describe("records through the service", () => {
  it("redacts spool records again with the machine's secrets before the ingest gets them, cut to the stored size", async () => {
    const dir = obsTempDir("service");
    const got: FilteredRecord[] = [];
    const t = 29_400_000 * 60_000;
    const { s, data } = await service(dir, { accept: async (r) => void got.push(r) }, () => t + 60_000 + SPOOL_GRACE_MS);
    const message = `${"x".repeat(2_040)}example-machine-secret-value and more`;
    const line = JSON.stringify({ v: 1, src: "hook", event: "Stop", at: t, f: { session_id: "sess-1" }, c: { last_assistant_message: message } });
    expect(await appendSpoolLine(data, line, t)).toBe("written");
    await s.drainSpool();
    expect(got).toHaveLength(1);
    const kept = got[0]?.src === "hook" ? (got[0].c?.last_assistant_message ?? "") : "";
    expect(kept).not.toContain("example-machine");
    expect(kept.length).toBeLessThanOrEqual(2_049);
    expect(s.status().spool?.loaded).toBe(1);
  });
});

describe("the projects without content", () => {
  it("keep every one of 100 changes made at once, in the config and in state.json", async () => {
    for (let round = 0; round < 5; round++) {
      const { s, config, data } = await service(obsTempDir("service"));
      const keys = Array.from({ length: 100 }, (_, i) => `github.com/example/p${round}-${i}`);
      await Promise.all(keys.map((k) => s.setProjectContent(k, false)));
      await Promise.all(keys.slice(0, 10).map((k) => s.setProjectContent(k, true)));
      const expected = keys.slice(10).sort();
      expect(config.get().observatory?.contentOff).toEqual(expected);
      expect((await readHookState(data)).contentOff).toEqual(expected);
      expect(readdirSync(data).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("set a broken state.json aside and rebuild it from the config, never as an empty list", async () => {
    const dir = obsTempDir("service");
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(hookStatePath(data), '{"enabled":true,"contentOff":["github.com/example/private"]');
    // Until the agent starts, a hook keeps no content at all (fail closed).
    expect(await readHookState(data)).toMatchObject({ unreadable: true });
    const config = new ConfigStore(join(dir, "config"));
    const port = await pickFreePort();
    config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_398, contentOff: ["github.com/example/private"] }));
    const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
    await s.start();
    stops.push(() => s.stop());
    expect(await readHookState(data)).toEqual({ enabled: true, contentOff: ["github.com/example/private"], unreadable: false });
    expect(readdirSync(data).some((n) => n.startsWith("state.json.corrupt-"))).toBe(true);
  });

  it("survive a wipe: the new store and state.json still keep the project's content out", async () => {
    const dir = obsTempDir("service");
    const { s, data } = await service(dir);
    await s.setProjectContent("github.com/example/private", false);
    s.accept({ v: 1, src: "hook", event: "Stop", at: 5, f: { session_id: "before" } }, "sdk").catch(() => undefined);
    await s.wipe();
    s.accept({ v: 1, src: "hook", event: "Stop", at: 6, f: { session_id: "after" } }, "sdk").catch(() => undefined);
    await s.stop();
    const check = await ObservatoryStore.open({ path: join(data, "observatory.db") });
    try {
      expect(check.contentSetting("github.com/example/private")).toMatchObject({ storeContent: false });
      expect([check.sessionTimeline("before").prompts.length, check.sessionTimeline("after").prompts.length]).toEqual([0, 1]);
    } finally {
      check.close();
    }
    expect((await readHookState(data)).contentOff).toEqual(["github.com/example/private"]);
  });
});

describe("the OTLP token", () => {
  it("is never replaced when its file cannot be read: the receiver stays off and says why", async () => {
    const port = await pickFreePort();
    // A folder in the file's place cannot be read (as a file locked by a scanner); a file without a token is broken.
    for (const kind of ["unreadable", "broken"] as const) {
      const dir = obsTempDir("service");
      const data = join(dir, "data");
      mkdirSync(data, { recursive: true });
      const file = join(data, OTLP_TOKEN_FILE);
      if (kind === "unreadable") mkdirSync(file);
      else writeFileSync(file, "not a token");
      const config = new ConfigStore(join(dir, "config"));
      config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_397 }));
      const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [1, 1] } });
      await s.start();
      stops.push(() => s.stop());
      expect(s.status().receiver.state, kind).toBe("token-unreadable");
      if (kind === "unreadable") expect(statSync(file).isDirectory()).toBe(true);
      else expect(readFileSync(file, "utf8")).toBe("not a token");
    }
  });

  it("reads an unreadable token file again on its own, and comes up once it can, with the token it holds", async () => {
    const port = await pickFreePort();
    const dir = obsTempDir("service");
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const file = join(data, OTLP_TOKEN_FILE);
    // Locked, as by a scanner at startup: a folder in its place cannot be read as a file.
    mkdirSync(file);
    const config = new ConfigStore(join(dir, "config"));
    config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_396 }));
    const s = new ObservatoryService({ config, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [], tokenRetryEveryMs: 30 } });
    await s.start();
    stops.push(() => s.stop());
    expect(s.status().receiver.state).toBe("token-unreadable");
    // Released: the file is readable again, with the token settings.json already has.
    const kept = "e".repeat(64);
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ current: kept }));
    for (let i = 0; i < 100 && s.status().receiver.state !== "listening"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.status().receiver.state).toBe("listening");
    expect(tokenFile(data)).toEqual({ current: kept });
    expect(await post(s.status().receiver.port ?? 0, kept)).toBe(200);
  });

  it("rotates for the running receiver, keeps one previous token until revoked, and counts its use", async () => {
    const { s, data } = await service(obsTempDir("service"));
    const port = s.status().receiver.port ?? 0;
    const first = tokenFile(data).current;
    expect(await post(port, first)).toBe(200);
    const rotated = await s.rotateToken();
    expect(rotated.previous).toBe(first);
    expect(await post(port, rotated.current)).toBe(200);
    expect(await post(port, first)).toBe(200);
    expect(s.status().receiver.stats.previousToken).toBe(1);
    await s.revokePreviousToken();
    expect(tokenFile(data)).toEqual({ current: rotated.current });
    expect(await post(port, first)).toBe(401);
    expect(s.secrets()).toContain(rotated.current);
  });
});

describe("the spool's live tail through the service", () => {
  it("hands a watched session's unread spool records to the listeners, redacted, without content, and stops with the service", async () => {
    const dir = obsTempDir("service-tail");
    const t = 29_400_000 * 60_000;
    const { s, data } = await service(dir, undefined, () => t + 10_000);
    const events: LiveTailEvent[] = [];
    const off = s.onLiveEvent((e) => events.push(e));
    s.watchSession("sess-1");
    const line = (session: string): string =>
      JSON.stringify({ v: 1, src: "hook", event: "Stop", at: t + 1, f: { session_id: session, prompt_id: "example-machine-secret-value" }, c: { last_assistant_message: "sample content" } });
    expect(await appendSpoolLine(data, line("sess-1"), t + 1)).toBe("written");
    expect(await appendSpoolLine(data, line("sess-other"), t + 1)).toBe("written");
    await expect.poll(() => events.length, { timeout: 3_000 }).toBe(1);
    expect(events[0]).toMatchObject({ provisional: true, sessionId: "sess-1", event: "Stop" });
    expect(JSON.stringify(events)).not.toContain("example-machine-secret-value");
    expect(JSON.stringify(events)).not.toContain("sample content");
    const started = Date.now();
    await s.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    off();
    s.unwatchSession("sess-1");
  });
});

describe("the service's lifecycle", () => {
  it("ends the CI watches around a wipe, and follows pushes again after it", async () => {
    const asked: string[][] = [];
    const runGh: GhRunner = async (args) => {
      asked.push([...args]);
      return args[0] === "run" ? "[]" : "";
    };
    const { s } = await service(obsTempDir("service"), undefined, Date.now, runGh);
    const push = { sessionId: "s1", at: Date.now(), projectKey: "https://github.com/acme/app.git", branch: "main" };
    s.ci.pushed(push);
    expect(s.ci.watching).toBe(1);
    await s.wipe();
    expect(s.ci.watching).toBe(0);
    s.ci.pushed({ ...push, at: Date.now() });
    expect(s.ci.watching).toBe(1);
    await s.stop();
    expect(s.ci.watching).toBe(0);
    expect(asked).toEqual([]);
  });

  it("starts again after a stop", async () => {
    const { s } = await service(obsTempDir("service"));
    await s.stop();
    expect(s.status()).toMatchObject({ store: "off", receiver: { state: "off" } });
    await s.start();
    expect(s.status()).toMatchObject({ store: "open", receiver: { state: "listening" } });
  });
});

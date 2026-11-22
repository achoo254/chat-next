// `tunelo observatory status|export|delete|content|rotate-token`, both ways:
// with an agent running (through the control channel's Observatory routes,
// called here without the socket) and without one (the command opens the
// files itself). Switching content off removes what is stored and what waits
// in the spool's settled files; every change goes to the consent log; no
// output ever shows a token.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type ObservatoryCliDeps, observatoryContentCommand, observatoryDeleteCommand, observatoryExportCommand, observatoryRotateCommand, observatoryStatusCommand } from "../../src/commands/observatory-actions.ts";
import { OBSERVATORY_CONTROL_ROUTES, type ObservatoryMachine } from "../../src/commands/observatory-control-routes.ts";
import type { Terminal } from "../../src/commands/mcp-local-writes.ts";
import { ConfigStore } from "../../src/config.ts";
import { observatoryOtelEnv, parseSettings } from "../../src/observatory/install/observatory-settings-markers.ts";
import { withObservatory } from "../../src/observatory/install/settings-json-observatory.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import type { FilteredHookRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { OTLP_TOKEN_FILE, loadOrCreateTokens } from "../../src/observatory/receiver/receiver-token.ts";
import { readHookState } from "../../src/observatory/spool/hook-state-file.ts";
import { appendSpoolLine } from "../../src/observatory/spool/spool-append.ts";
import { SPOOL_DIR } from "../../src/observatory/spool/spool-files.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { repoKeyOf } from "../../src/usage/repo-key.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

type Setup = { deps: ObservatoryCliDeps; out: string[]; err: string[]; data: string; config: string; claudeHome: string; project: string; folder: string };

/** A folder that is its own repository (local:<name>), as `content <folder>` takes it. */
function projectFolder(root: string): { folder: string; project: string } {
  const folder = join(root, "work", "observed-app");
  mkdirSync(join(folder, ".git"), { recursive: true });
  return { folder, project: repoKeyOf(folder) };
}

async function setup(running: boolean, brokenToken = false): Promise<Setup & { service?: ObservatoryService }> {
  const root = obsTempDir("cli");
  const config = join(root, "config");
  const data = join(root, "data");
  const claudeHome = join(root, "claude");
  mkdirSync(claudeHome, { recursive: true });
  const store = new ConfigStore(config);
  const port = await pickFreePort();
  store.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_397 }));
  const { folder, project } = projectFolder(root);
  const out: string[] = [];
  const err: string[] = [];
  const term: Terminal = { interactive: false, ask: async () => "", print: (l) => out.push(l), printError: (l) => err.push(l) };
  let service: ObservatoryService | undefined;
  let machine: ObservatoryMachine | undefined;
  if (brokenToken) {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, OTLP_TOKEN_FILE), "not a token");
  }
  if (running) {
    service = new ObservatoryService({ config: store, dataDir: data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
    await service.start();
    const s = service;
    stops.push(() => s.stop());
    machine = { observatory: service, audit: new AuditLog(join(config, "audit.jsonl")) };
  }
  const deps: ObservatoryCliDeps = {
    dir: config,
    dataDir: data,
    settings: { claudeHome, profileHomes: () => [], syncProfile: () => undefined, stateFile: join(root, "install-state.json"), print: (l) => out.push(l) },
    call: async (method, path, input) => {
      const route = OBSERVATORY_CONTROL_ROUTES[`${method} ${path}`];
      if (!route) throw new Error(`unknown command ${method} ${path}`);
      return route({ machine }, input ?? {});
    },
    running: async () => running,
    term,
    now: Date.now,
  };
  return { deps, out, err, data, config, claudeHome, project, folder, ...(service ? { service } : {}) };
}

const record = (project: string, event: string, f: Record<string, string>, c?: Record<string, string>): FilteredHookRecord => ({
  v: 1,
  src: "hook",
  event,
  at: Date.now(),
  f: { session_id: "sess-cli", cwd: "~/work/observed-app", project_key: project, ...f },
  ...(c ? { c } : {}),
});

async function readStore<T>(data: string, read: (store: ObservatoryStore) => T): Promise<T> {
  const store = await ObservatoryStore.open({ path: join(data, "observatory.db") });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

const audit = (config: string): string[] => new AuditLog(join(config, "audit.jsonl")).list(20).map((e) => `${e.action} ${e.path} ${e.detail}`.trim());

describe("with the agent running", () => {
  it("content off clears the stored content and the settled spool, and the consent log has it", async () => {
    const t = await setup(true);
    const s = t.service;
    if (!s) throw new Error("no service");
    await s.accept(record(t.project, "SessionStart", { source: "startup" }), "sdk");
    await s.accept(record(t.project, "UserPromptSubmit", { prompt_id: "p1" }, { prompt: "stored-before" }), "sdk");
    // A hook line from two minutes ago, settled, still in the spool.
    const old = Date.now() - 2 * 60_000;
    await appendSpoolLine(t.data, JSON.stringify({ ...record(t.project, "UserPromptSubmit", { session_id: "sess-spool", prompt_id: "p2" }, { prompt: "waiting-in-spool" }), at: old }), old);
    expect(await observatoryContentCommand(t.deps, t.folder, "off")).toBe(0);
    await s.stop();
    const prompts = await readStore(t.data, (store) => [...store.sessionTimeline("sess-cli").prompts, ...store.sessionTimeline("sess-spool").prompts].map((p) => p.excerpt));
    expect(prompts).toEqual([null, null]);
    expect(readdirSync(join(t.data, SPOOL_DIR)).filter((n) => n.startsWith("events-"))).toEqual([]);
    expect((await readHookState(t.data)).contentOff).toEqual([t.project]);
    expect(audit(t.config)).toEqual([`observatory_content ${t.project} off`]);
    expect(t.out.join("\n")).toContain(t.project);
  });

  it("status shows the receiver, the counts and the last event, never the token", async () => {
    const t = await setup(true);
    await t.service?.accept(record(t.project, "SessionStart", { source: "startup" }), "sdk");
    expect(await observatoryStatusCommand(t.deps, false)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/Receiver: listening on 127\.0\.0\.1:\d+/);
    expect(text).toMatch(/Ingest: records 1, stored 1/);
    expect(text).toContain("Claude Code outside tunelo: not installed");
    expect(text).not.toMatch(/Last event: never/);
    expect(text).not.toContain((await loadOrCreateTokens(t.data)).current);
    t.out.length = 0;
    expect(await observatoryStatusCommand(t.deps, true)).toBe(0);
    const json = JSON.parse(t.out.join("\n")) as { running: boolean; status: { receiver: { state: string }; ingest: { records: number }; sdkHooks: { taken: number } } };
    expect(json.running).toBe(true);
    expect(json.status.receiver.state).toBe("listening");
    expect(json.status.ingest.records).toBe(1);
  });

  it("exports, deletes (asking for --yes off a terminal), and rotates the token into an installed settings.json", async () => {
    const t = await setup(true);
    await t.service?.accept(record(t.project, "SessionStart", { source: "startup" }), "sdk");
    const file = join(t.config, "export.json");
    expect(await observatoryExportCommand(t.deps, file, false)).toBe(0);
    expect((JSON.parse(readFileSync(file, "utf8")) as { tables: { sessions: unknown[] } }).tables.sessions).toHaveLength(1);
    await expect(observatoryExportCommand(t.deps, file, false)).rejects.toThrow();
    expect(await observatoryDeleteCommand(t.deps, false)).toBe(1);
    expect(t.err.join("\n")).toContain("--yes");
    expect(await observatoryDeleteCommand(t.deps, true)).toBe(0);
    expect(audit(t.config)).toEqual(["observatory_delete"]);

    const port = new ConfigStore(t.config).get().observatory?.otlpPort ?? 0;
    const before = await loadOrCreateTokens(t.data);
    const settings = join(t.claudeHome, "settings.json");
    writeFileSync(settings, withObservatory('{ "model": "opus" }\n', ["/opt/tunelo"], observatoryOtelEnv({ port, token: before.current })));
    expect(await observatoryRotateCommand(t.deps, false)).toBe(0);
    const after = await loadOrCreateTokens(t.data);
    expect(after.previous).toBe(before.current);
    const env = parseSettings(readFileSync(settings, "utf8"))?.env as Record<string, string>;
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${after.current}`);
    expect(t.out.join("\n")).not.toContain(after.current);
  });

  it("rotate-token --replace-unreadable gets a receiver stuck on a broken token file listening", async () => {
    const t = await setup(true, true);
    expect(t.service?.status().receiver.state).toBe("token-unreadable");
    t.out.length = 0;
    expect(await observatoryStatusCommand(t.deps, false)).toBe(0);
    expect(t.out.join("\n")).toContain("rotate-token --replace-unreadable");
    expect(await observatoryRotateCommand(t.deps, true)).toBe(0);
    expect(t.service?.status().receiver.state).toBe("listening");
    expect(t.service?.otlpClient()?.token).toBe((await loadOrCreateTokens(t.data)).current);
  });

  it("refuses an export path that is not absolute and an unknown content action", async () => {
    const t = await setup(true);
    await expect(Promise.resolve(OBSERVATORY_CONTROL_ROUTES["POST /observatory/export"]?.({ machine: undefined }, { file: "x.json" }))).rejects.toThrow();
    await expect(observatoryContentCommand(t.deps, t.folder, "maybe")).rejects.toThrow(/use on or off/);
  });
});

describe("with no agent running", () => {
  it("content off writes the config and state.json, clears the store and takes in the settled spool", async () => {
    const t = await setup(false);
    // What an agent stored before it stopped.
    const first = new ObservatoryService({ config: new ConfigStore(t.config), dataDir: t.data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
    await first.start();
    await first.accept(record(t.project, "SessionStart", { source: "startup" }), "sdk");
    await first.accept(record(t.project, "UserPromptSubmit", { prompt_id: "p1" }, { prompt: "stored-before" }), "sdk");
    await first.stop();
    const old = Date.now() - 2 * 60_000;
    await appendSpoolLine(t.data, JSON.stringify({ ...record(t.project, "UserPromptSubmit", { session_id: "sess-spool", prompt_id: "p2" }, { prompt: "waiting-in-spool" }), at: old }), old);

    expect(await observatoryContentCommand(t.deps, t.folder, "off")).toBe(0);
    expect(new ConfigStore(t.config).get().observatory?.contentOff).toEqual([t.project]);
    expect((await readHookState(t.data)).contentOff).toEqual([t.project]);
    const prompts = await readStore(t.data, (store) => [...store.sessionTimeline("sess-cli").prompts, ...store.sessionTimeline("sess-spool").prompts].map((p) => p.excerpt));
    expect(prompts).toEqual([null, null]);
    expect(readdirSync(join(t.data, SPOOL_DIR)).filter((n) => n.startsWith("events-"))).toEqual([]);
    expect(audit(t.config)).toEqual([`observatory_content ${t.project} off`]);

    // On again: kept from now on.
    expect(await observatoryContentCommand(t.deps, t.folder, "on")).toBe(0);
    expect(new ConfigStore(t.config).get().observatory?.contentOff).toEqual([]);
  });

  it("exports and deletes from the files, and status says the agent is not running", async () => {
    const t = await setup(false);
    const first = new ObservatoryService({ config: new ConfigStore(t.config), dataDir: t.data, log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
    await first.start();
    await first.accept(record(t.project, "SessionStart", { source: "startup" }), "sdk");
    await first.stop();
    const file = join(t.config, "offline.json");
    expect(await observatoryExportCommand(t.deps, file, false)).toBe(0);
    expect(t.out.at(-1)).toContain("Exported");
    expect(await observatoryDeleteCommand(t.deps, true)).toBe(0);
    expect(await readStore(t.data, (store) => store.sessions().length)).toBe(0);
    expect(await observatoryStatusCommand(t.deps, false)).toBe(0);
    expect(t.out.join("\n")).toContain("tunelo is not running");
  });

  it("rotate-token --replace-unreadable replaces a token file that cannot be read", async () => {
    const t = await setup(false);
    mkdirSync(t.data, { recursive: true });
    writeFileSync(join(t.data, OTLP_TOKEN_FILE), "not a token");
    await expect(observatoryRotateCommand(t.deps, false)).rejects.toThrow();
    expect(await observatoryRotateCommand(t.deps, true)).toBe(0);
    const tokens = await loadOrCreateTokens(t.data);
    expect(tokens.current).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.previous).toBeUndefined();
    expect(existsSync(join(t.data, OTLP_TOKEN_FILE))).toBe(true);
  });
});

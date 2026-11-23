// What the sessions tunelo opens get from Observatory: the receiver's OTel
// environment only while it listens and only when the user has no telemetry
// of their own; the hook argv only when the Claude folder's settings do not
// hold Observatory's hooks already; settings holding the token only in a
// private file, reused for the same settings and deleted once unused for long.
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withObservatory } from "../../src/observatory/install/settings-json-observatory.ts";
import { CLAUDE_SETTINGS_DIR, ObservatorySessionObserver, SETTINGS_FILE_KEEP_MS } from "../../src/observatory/session-observer.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const TOKEN = "7a".repeat(32);

function observer(over: { enabled?: boolean; client?: { port: number; token: string } | undefined; env?: Record<string, string> } = {}) {
  const root = obsTempDir("observer");
  const home = join(root, "claude");
  mkdirSync(home, { recursive: true });
  const taken: [string, unknown, string | undefined][] = [];
  const o = new ObservatorySessionObserver({
    service: {
      enabled: over.enabled ?? true,
      otlpClient: () => ("client" in over ? over.client : { port: 47_312, token: TOKEN }),
      takeHookEvent: (event, payload, label) => void taken.push([event, payload, label]),
    },
    dataDir: join(root, "data"),
    selfCommand: () => ["/opt/tunelo/tunelo"],
    env: over.env ?? {},
  });
  return { o, home, root, taken };
}

describe("the OTel environment of a session", () => {
  it("points at the receiver while it listens", () => {
    const { o, home } = observer();
    expect(o.otelEnv(home)).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:47312",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${TOKEN}`,
    });
  });

  it("is absent with Observatory off, with the receiver not listening, and with the user's own telemetry", () => {
    expect(observer({ enabled: false }).o.otelEnv(observer().home)).toBeUndefined();
    const idle = observer({ client: undefined });
    expect(idle.o.otelEnv(idle.home)).toBeUndefined();
    const shell = observer({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" } });
    expect(shell.o.otelEnv(shell.home)).toBeUndefined();
    const own = observer();
    writeFileSync(join(own.home, "settings.json"), '{ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1" } }');
    expect(own.o.otelEnv(own.home)).toBeUndefined();
    const broken = observer();
    writeFileSync(join(broken.home, "settings.json"), "{ not json");
    expect(broken.o.otelEnv(broken.home)).toBeUndefined();
    // Observatory's own install is not the user's telemetry.
    const installed = observer();
    writeFileSync(join(installed.home, "settings.json"), withObservatory("{}", ["/opt/tunelo/tunelo"], { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp" }));
    expect(installed.o.otelEnv(installed.home)).toBeDefined();
  });
});

describe("the hooks of a terminal's CLI", () => {
  it("are given while the folder's settings do not hold Observatory's hooks", () => {
    const { o, home } = observer();
    expect(o.hookCommand(home)).toEqual(["/opt/tunelo/tunelo"]);
    writeFileSync(join(home, "settings.json"), withObservatory('{ "model": "opus" }', ["/opt/tunelo/tunelo"], undefined));
    expect(o.hookCommand(home)).toBeUndefined();
    expect(observer({ enabled: false }).o.hookCommand(home)).toBeUndefined();
  });

  it("hands SDK hook events on with their label", () => {
    const { o, taken } = observer();
    o.hookEvent("Stop", { session_id: "s" }, "advisor");
    expect(taken).toEqual([["Stop", { session_id: "s" }, "advisor"]]);
  });
});

describe("the private settings file", () => {
  it("holds the settings, private, reused for the same settings, and old ones are deleted", () => {
    const { o, root } = observer();
    const json = JSON.stringify({ hooks: {}, env: { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${TOKEN}` } });
    const file = o.privateSettingsFile(json);
    expect(file.startsWith(join(root, "data", CLAUDE_SETTINGS_DIR))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(json);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(o.privateSettingsFile(json)).toBe(file);
    const other = o.privateSettingsFile(JSON.stringify({ hooks: { Stop: [] } }));
    expect(other).not.toBe(file);
    const old = new Date(Date.now() - SETTINGS_FILE_KEEP_MS - 60_000);
    utimesSync(other, old, old);
    o.privateSettingsFile(json);
    expect(readdirSync(join(root, "data", CLAUDE_SETTINGS_DIR))).toEqual([file.split(/[\\/]/).at(-1)]);
  });
});

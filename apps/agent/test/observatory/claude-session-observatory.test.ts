// Observatory in the Claude sessions tunelo opens. SDK: a callback per
// observed event after tunelo's own hooks while Observatory is on, none while
// it is off; the session's start and end told from the query's messages; an
// Advisor session observed on its own hooks only, every record labelled; the
// OTel variables in the session's environment with the profile's sign-in
// rules kept; the probes get none of it. Terminal: one --settings holding the
// hooks already there plus Observatory's exec-form groups, the same argv on
// every platform, the token only in a private file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { TURN_END_SETTINGS, createClaudeProvider, probeUsage, terminalCommand } from "../../src/providers/claude/index.ts";
import { OBSERVED_SDK_EVENTS, ObservedSessionLifecycle } from "../../src/providers/claude/observatory-session-hooks.ts";
import { ConfigStore } from "../../src/config.ts";
import { ObservatoryService } from "../../src/observatory/observatory-service.ts";
import { pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { AskUser, SessionObserver, TerminalLaunch } from "../../src/providers/types.ts";
import { fakeQuery } from "../fake-sdk.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";

afterAll(removeObsTempDirs);

const OTEL = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${"9f".repeat(32)}` };
const askUser: AskUser = () => {
  throw new Error("nothing is asked in these tests");
};

type Observed = [event: string, payload: unknown, label: string | undefined];

function stubObserver(over: Partial<SessionObserver> = {}): { observer: SessionObserver; observed: Observed[]; files: string[] } {
  const observed: Observed[] = [];
  const files: string[] = [];
  const dir = obsTempDir("claude-obs");
  return {
    observed,
    files,
    observer: {
      otelEnv: () => OTEL,
      hookCommand: () => ["C:\\Program Files\\tunelo dir\\tunelo.exe"],
      privateSettingsFile: (json) => {
        const file = join(dir, `s${files.length}.json`);
        writeFileSync(file, json);
        files.push(file);
        return file;
      },
      hookEvent: (event, payload, label) => void observed.push([event, payload, label]),
      ...over,
    },
  };
}

async function startSession(observer: SessionObserver | undefined, policy: Partial<Parameters<ReturnType<typeof createClaudeProvider>["start"]>[0]["policy"]> = {}) {
  const sdk = fakeQuery();
  const provider = createClaudeProvider({ query: sdk.fn, findBinary: async () => "/bin/claude", homes: () => [], ...(observer ? { observer: () => observer } : {}) });
  const session = await provider.start({ policy: { dir: obsTempDir("claude-dir"), mcpServers: {}, projectSettings: false, isSensitive: () => false, ...policy }, askUser });
  const options = sdk.log.options[0];
  if (!options) throw new Error("no query started");
  return { session, options, provider, sdk };
}

const hookEvents = (o: Options): string[] => Object.keys(o.hooks ?? {}).sort();

/** Runs every callback registered for `event` with `input`; resolves with their outputs and the time taken. */
async function runHooks(o: Options, event: keyof NonNullable<Options["hooks"]>, input: HookInput): Promise<{ outputs: unknown[]; ms: number }> {
  const started = performance.now();
  const outputs: unknown[] = [];
  for (const matcher of o.hooks?.[event] ?? []) for (const hook of matcher.hooks) outputs.push(await hook(input, undefined, { signal: new AbortController().signal }));
  return { outputs, ms: performance.now() - started };
}

describe("an SDK session", () => {
  it("adds Observatory's callbacks after tunelo's own while on, and none while off", async () => {
    const off = await startSession(undefined);
    expect(hookEvents(off.options)).toEqual(["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"]);
    await off.session.close();
    const { observer, observed } = stubObserver();
    const on = await startSession(observer);
    expect(hookEvents(on.options)).toEqual([...OBSERVED_SDK_EVENTS].sort());
    // tunelo's own PreToolUse matchers come first, untouched.
    expect(on.options.hooks?.PreToolUse?.[0]?.matcher).toBe("^mcp__tunelo__");
    const input: HookInput = { hook_event_name: "PostToolUse", session_id: "s", transcript_path: "t", cwd: "/w", tool_name: "Read", tool_input: {}, tool_response: "ok", tool_use_id: "t1" };
    const { outputs } = await runHooks(on.options, "PostToolUse", input);
    expect(outputs.at(-1)).toEqual({});
    expect(observed.filter(([e]) => e === "PostToolUse")).toEqual([["PostToolUse", input, undefined]]);
    await on.session.close();
  });

  it("a callback returns at once while Observatory takes its time (the observer only queues)", async () => {
    const slow = stubObserver({
      hookEvent: () => {
        // What a callback must never do: here it is the observer's queue that returns at once; a slow ingest runs later.
        void new Promise((resolve) => setTimeout(resolve, 2_000));
      },
    });
    const { options, session } = await startSession(slow.observer);
    const stop: HookInput = { hook_event_name: "Stop", session_id: "s", transcript_path: "t", cwd: "/w", stop_hook_active: false };
    const { ms } = await runHooks(options, "Stop", stop);
    expect(ms).toBeLessThan(100);
    await session.close();
  });

  it("tells the session's start from its init message and its end when the query ends", async () => {
    const { observer, observed } = stubObserver();
    const { session, options } = await startSession(observer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = observed.find(([e]) => e === "SessionStart");
    expect(start?.[1]).toMatchObject({ hook_event_name: "SessionStart", session_id: "claude-session-1", cwd: options.cwd, source: "startup", model: "claude-test" });
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed.find(([e]) => e === "SessionEnd")?.[1]).toMatchObject({ session_id: "claude-session-1", reason: "other" });
  });

  it("an Advisor session is observed on its own hooks only, every record labelled", async () => {
    const { observer, observed } = stubObserver();
    const { session, options } = await startSession(observer, { advisorSession: true });
    expect(hookEvents(options)).toEqual(["PostToolUse", "PreToolUse", "UserPromptSubmit"]);
    const prompt: HookInput = { hook_event_name: "UserPromptSubmit", session_id: "a", transcript_path: "t", cwd: "/w", prompt: "hi" };
    await runHooks(options, "UserPromptSubmit", prompt);
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed.map(([e]) => e).sort()).toEqual(["SessionEnd", "SessionStart", "UserPromptSubmit"]);
    expect(observed.every(([, , label]) => label === "advisor")).toBe(true);
  });

  it("gets the OTel variables in an environment always given while on; a profile keeps its own sign-in rules", async () => {
    const { observer } = stubObserver();
    const plain = await startSession(observer);
    expect(plain.options.env).toMatchObject(OTEL);
    expect(plain.options.env?.PATH ?? plain.options.env?.Path).toBeDefined();
    await plain.session.close();
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "example-key-of-the-service";
    try {
      const profile = await startSession(observer, { account: { id: "p1", dir: "/profiles/p1/home" } });
      expect(profile.options.env).toMatchObject({ ...OTEL, CLAUDE_CONFIG_DIR: "/profiles/p1/home" });
      expect(profile.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
      await profile.session.close();
      const own = await startSession(observer);
      expect(own.options.env?.ANTHROPIC_API_KEY).toBe("example-key-of-the-service");
      await own.session.close();
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
    const noOtel = await startSession(stubObserver({ otelEnv: () => undefined }).observer);
    expect(Object.keys(noOtel.options.env ?? {}).filter((k) => k.startsWith("OTEL_"))).toEqual([]);
    await noOtel.session.close();
    const off = await startSession(undefined);
    expect(off.options.env).toBeUndefined();
    await off.session.close();
  });

  it("the commands probe gets no callback and no OTel", async () => {
    const probes: Options[] = [];
    const { observer, observed } = stubObserver();
    const query = (p: { options: Options }): never => {
      probes.push(p.options);
      throw new Error("no claude here");
    };
    const provider = createClaudeProvider({ query, findBinary: async () => "/bin/claude", homes: () => [], observer: () => observer });
    expect(await provider.listCommands?.({ dir: obsTempDir("probe"), projectSettings: false })).toEqual([]);
    const probe = probes[0];
    expect(probe).toBeDefined();
    // Hooks installed in the user's settings (Observatory's too) never run in a probe: it records no session.
    expect(probe?.settings).toEqual({ disableAllHooks: true });
    expect(await probeUsage("/bin/claude", undefined, query, 1_000)).toBeNull();
    expect(probes[1]?.settings).toEqual({ disableAllHooks: true });
    expect(probes[1]?.settingSources).toEqual([]);
    expect(probe?.hooks).toBeUndefined();
    expect(Object.keys(probe?.env ?? {}).some((k) => k.startsWith("OTEL_"))).toBe(false);
    expect(observed).toEqual([]);
  });
});

const LAUNCH: TerminalLaunch = { dir: "/w", resumeId: "123e4567-e89b-12d3-a456-426614174000" };
const ADVISOR: NonNullable<TerminalLaunch["advisor"]> = { ticket: "tk", configDir: "/cfg", noteCommand: ["/t", "advisor", "note", "x"], stopCommand: ["/t", "advisor", "stop", "x"] };

function settingsOf(args: string[]): { value: string; parsed: { hooks: Record<string, unknown[]>; env?: Record<string, string> } } {
  const at = args.indexOf("--settings");
  expect(args.filter((a) => a === "--settings")).toHaveLength(1);
  const value = args[at + 1] ?? "";
  const json = value.startsWith("{") ? value : readFileSync(value, "utf8");
  return { value, parsed: JSON.parse(json) as { hooks: Record<string, unknown[]>; env?: Record<string, string> } };
}

describe("an SDK session's start, /clear and end", () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;

  it("pairs the old id's end with the new id's start on /clear, once each, whether or not init comes every turn", () => {
    for (const initEveryTurn of [false, true]) {
      const { observer, observed } = stubObserver();
      const life = new ObservedSessionLifecycle(observer, "/w", "startup", "advisor");
      const init = { model: "claude-test", permission_mode: "default" };
      // A message before the session has an id is no session.
      life.saw("");
      life.saw(ids[0], init);
      life.saw("");
      life.saw(ids[0], initEveryTurn ? init : undefined);
      life.saw(ids[0]);
      // /clear: the query goes on under a new id.
      life.saw(ids[1], initEveryTurn ? init : undefined);
      life.saw(ids[1], initEveryTurn ? init : undefined);
      // A late message of the old session adds nothing.
      life.saw(ids[0]);
      life.ended();
      life.ended();
      const field = (payload: unknown, key: string): unknown => (typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined);
      expect(observed.map(([event, payload, label]) => [event, field(payload, "session_id"), field(payload, "source") ?? field(payload, "reason"), label])).toEqual([
        ["SessionStart", ids[0], "startup", "advisor"],
        ["SessionEnd", ids[0], "clear", "advisor"],
        ["SessionStart", ids[1], "clear", "advisor"],
        ["SessionEnd", ids[1], "other", "advisor"],
      ]);
    }
  });

  it("is joined by the ingest: the new session links to the old one", async () => {
    const dir = obsTempDir("sdk-clear");
    const config = new ConfigStore(join(dir, "config"));
    const port = await pickFreePort();
    config.update((c) => (c.observatory = { enabled: true, otlpPort: port ?? 47_396 }));
    const service = new ObservatoryService({ config, dataDir: join(dir, "data"), log: () => undefined, knownSecrets: () => [], tokenTimings: { tokenRetryMs: [] } });
    await service.start();
    try {
      const observer: SessionObserver = { otelEnv: () => undefined, hookCommand: () => undefined, privateSettingsFile: () => "", hookEvent: (e, p, l) => service.takeHookEvent(e, p, l) };
      const life = new ObservedSessionLifecycle(observer, join(dir, "work"), "startup", undefined);
      life.saw(ids[0], { model: "claude-test", permission_mode: "default" });
      life.saw(ids[1]);
      life.ended();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await service.stop();
    }
    const store = await ObservatoryStore.open({ path: join(dir, "data", "observatory.db") });
    try {
      expect(store.sessionTimeline(ids[0]).session?.endedAt).not.toBeNull();
      expect(store.sessionTimeline(ids[1]).session?.previousSessionId).toBe(ids[0]);
      expect(store.sessionTimeline(ids[1]).session?.endedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("a terminal's CLI", () => {
  it("without Observatory is exactly as before", () => {
    expect(terminalCommand("/bin/claude", LAUNCH, () => "x").args).toEqual(["--resume", LAUNCH.resumeId, "--settings", TURN_END_SETTINGS]);
  });

  it("takes Observatory's groups in the one --settings, after the turn-end hook, in exec form on every platform", () => {
    const argv = ["C:\\Program Files (x86)\\tunelo dir\\tunelo.exe"];
    const outs = (["win32", "linux", "darwin"] as const).map((platform) =>
      terminalCommand("/bin/claude", LAUNCH, () => "x", platform, { hookCommand: argv, otelEnv: undefined, settingsFile: () => "unused" }),
    );
    const settings = outs.map((o) => settingsOf(o.args).parsed);
    expect(settings[0]).toEqual(settings[1]);
    expect(settings[1]).toEqual(settings[2]);
    const s = settings[0];
    expect(s?.hooks.Stop?.[0]).toEqual(JSON.parse(TURN_END_SETTINGS).hooks.Stop[0]);
    expect(s?.hooks.Stop?.[1]).toEqual({ hooks: [{ type: "command", command: argv[0], args: ["observatory", "hook", "Stop"], async: true }] });
    expect(s?.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: argv[0], args: ["observatory", "hook", "SessionStart"], async: true }] }]);
    expect(s?.env).toBeUndefined();
  });

  it("with Advisor keeps Advisor's hooks first, one --settings, then --mcp-config", () => {
    const out = terminalCommand("/bin/claude", { ...LAUNCH, advisor: ADVISOR }, () => "x", "linux", { hookCommand: ["/opt/tunelo"], otelEnv: undefined, settingsFile: () => "unused" });
    const plain = terminalCommand("/bin/claude", { ...LAUNCH, advisor: ADVISOR }, () => "x", "linux");
    const { parsed } = settingsOf(out.args);
    const before = settingsOf(plain.args).parsed;
    expect(parsed.hooks.Stop?.slice(0, 2)).toEqual(before.hooks.Stop);
    expect(parsed.hooks.UserPromptSubmit?.[0]).toEqual(before.hooks.UserPromptSubmit?.[0]);
    expect(parsed.hooks.Stop).toHaveLength(3);
    expect(out.args.slice(-2, -1)).toEqual(["--mcp-config"]);
    expect(out.args.at(-1)).toBe(plain.args.at(-1));
  });

  it("puts the OTel environment in a private file named by --settings: the token is never an argument", () => {
    const { observer, files } = stubObserver();
    const out = terminalCommand("/bin/claude", LAUNCH, () => "x", "win32", { hookCommand: ["/opt/tunelo"], otelEnv: OTEL, settingsFile: (json) => observer.privateSettingsFile(json) });
    const { value, parsed } = settingsOf(out.args);
    expect(value).toBe(files[0]);
    expect(parsed.env).toEqual(OTEL);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(out.args.join(" ")).not.toContain("9f9f");
    expect(out.env).toEqual({});
    // A file that cannot be written: the CLI starts without telemetry, still with the hooks.
    const failed = terminalCommand("/bin/claude", LAUNCH, () => "x", "win32", {
      hookCommand: ["/opt/tunelo"],
      otelEnv: OTEL,
      settingsFile: () => {
        throw new Error("disk full");
      },
    });
    const fallback = settingsOf(failed.args);
    expect(fallback.parsed.env).toBeUndefined();
    expect(fallback.parsed.hooks.SessionStart).toHaveLength(1);
  });

  it("through the provider: hooks only for a claude that runs exec-form hooks, the profile's folder asked", async () => {
    const asked: string[] = [];
    const { observer } = stubObserver({
      hookCommand: (home) => {
        asked.push(home);
        return ["/opt/tunelo"];
      },
      otelEnv: () => undefined,
    });
    const provider = createClaudeProvider({ findBinary: async () => process.execPath, homes: () => [], observer: () => observer });
    // `node --version` prints v24…: not a claude version, so no exec-form hooks.
    const out = await provider.terminal?.command({ ...LAUNCH, account: { id: "p1", dir: "/profiles/p1/home" } });
    expect(out && settingsOf(out.args).parsed.hooks.SessionStart).toBeUndefined();
    expect(asked).toEqual([]);
    expect(out?.env).toEqual({ CLAUDE_CONFIG_DIR: "/profiles/p1/home" });
  });
});

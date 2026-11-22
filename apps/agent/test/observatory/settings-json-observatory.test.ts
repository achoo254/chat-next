// Observatory's entries in a Claude Code settings.json as text edits: added
// once however often install runs, beside the user's own hooks, statusLine
// and env; taken out again leaving every other byte as it was, in the file's
// own indentation and line endings; the user's own OpenTelemetry keys told
// apart from Observatory's.
import { describe, expect, it } from "vitest";
import { OBSERVED_HOOK_EVENTS, hasObservatoryHooks, isObservatoryHookGroup, observatoryEnvKeys, observatoryHookCounts, observatoryOtelEnv, parseSettings, userOtelKeys } from "../../src/observatory/install/observatory-settings-markers.ts";
import { addObservatory, duplicateKeys, stillOnlyObservatory, withObservatory, withRefreshedObservatoryEnv, withoutObservatory } from "../../src/observatory/install/settings-json-observatory.ts";

const ARGV = ["C:\\Program Files (x86)\\tunelo dir\\tunelo.exe"];
const TOKEN = "ab".repeat(32);
const ENV = observatoryOtelEnv({ port: 47310, token: TOKEN });

/** A settings.json as a user has it: their own hooks (a Stop hook too), a status line, env, permissions. */
const USER_SETTINGS = `{
  "model": "opus",
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh"
  },
  "env": {
    "MY_VAR": "1"
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "notify-send done"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "my-guard"
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": ["Read"]
  }
}
`;

function parsed(text: string): Record<string, unknown> {
  const s = parseSettings(text);
  if (!s) throw new Error("not a JSON object");
  return s;
}

describe("adding Observatory to settings.json", () => {
  it("adds one async exec-form group per event after the user's own, and the marked env, leaving the rest as it was", () => {
    const out = withObservatory(USER_SETTINGS, ARGV, ENV);
    const s = parsed(out);
    const counts = observatoryHookCounts(s);
    for (const event of OBSERVED_HOOK_EVENTS) expect(counts[event]).toBe(1);
    const hooks = s.hooks as Record<string, unknown[]>;
    // The user's Stop and PreToolUse hooks stay first, Observatory's come after.
    expect(hooks.Stop?.[0]).toEqual({ hooks: [{ type: "command", command: "notify-send done" }] });
    expect(hooks.Stop?.[1]).toEqual({ hooks: [{ type: "command", command: ARGV[0], args: ["observatory", "hook", "Stop"], async: true }] });
    expect((hooks.PreToolUse?.[0] as { matcher?: string }).matcher).toBe("Bash");
    expect(s.statusLine).toEqual({ type: "command", command: "~/.claude/statusline.sh" });
    expect(s.permissions).toEqual({ allow: ["Read"] });
    expect(s.env).toEqual({ MY_VAR: "1", ...ENV, TUNELO_OBSERVATORY: "otel" });
    expect(observatoryEnvKeys(s.env).sort()).toEqual(Object.keys(ENV).sort());
    expect(userOtelKeys(s)).toEqual([]);
  });

  it("changes nothing the second time, and replaces an earlier install's group instead of adding one", () => {
    const once = withObservatory(USER_SETTINGS, ARGV, ENV);
    expect(withObservatory(once, ARGV, ENV)).toBe(once);
    const moved = withObservatory(once, ["/opt/tunelo/tunelo"], ENV);
    const counts = observatoryHookCounts(parsed(moved));
    for (const event of OBSERVED_HOOK_EVENTS) expect(counts[event]).toBe(1);
    expect(moved).toContain("/opt/tunelo/tunelo");
    expect(moved).not.toContain("tunelo dir");
  });

  it("takes out exactly what it added, its own containers only: the file's bytes come back", () => {
    for (const original of [
      USER_SETTINGS,
      USER_SETTINGS.replace(/\n/g, "\r\n"),
      USER_SETTINGS.replace(/ {2}/g, "\t"),
      `\uFEFF${USER_SETTINGS}`,
      '{"model":"opus"}',
      "{}",
      "{}\n",
      "{ }\n",
      "{\n}\n",
      '{"hooks": {}, "model": "opus"}',
      '{"env": {}}',
      '{"model":"opus","hooks":{"Stop":[]}}',
      '{\n  "hooks": {\n    "Stop": []\n  },\n  "env": {}\n}',
    ]) {
      const record = addObservatory(original, ARGV, ENV);
      const installed = record.text;
      expect(installed).not.toBe(original);
      expect(hasObservatoryHooks(parsed(installed))).toBe(true);
      expect(withoutObservatory(installed, record)).toBe(original);
    }
  });

  it("records the containers it made, and without a record keeps every container, even emptied", () => {
    const { text, created } = addObservatory('{"hooks": {"Stop": []}, "env": {}}', ARGV, ENV);
    expect(created).toContainEqual(["hooks", "SessionStart"]);
    expect(created).not.toContainEqual(["env"]);
    expect(created).not.toContainEqual(["hooks"]);
    expect(created).not.toContainEqual(["hooks", "Stop"]);
    // No record: a container it cannot prove it made may be the user's, so none goes.
    const kept = parsed(withoutObservatory(text));
    expect(hasObservatoryHooks(kept)).toBe(false);
    expect(kept.env).toEqual({});
    expect((kept.hooks as Record<string, unknown[]>).Stop).toEqual([]);
    expect((kept.hooks as Record<string, unknown[]>).SessionStart).toEqual([]);
  });

  it("tells a container that still holds Observatory's entries only from one the user changed", () => {
    const installed = withObservatory('{"model": "opus"}', ARGV, ENV);
    expect(stillOnlyObservatory(installed, ["hooks"])).toBe(true);
    expect(stillOnlyObservatory(installed, ["hooks", "Stop"])).toBe(true);
    expect(stillOnlyObservatory(installed, ["env"])).toBe(true);
    expect(stillOnlyObservatory('{"hooks": {}, "env": {}}', ["hooks"])).toBe(false);
    expect(stillOnlyObservatory('{"hooks": {}, "env": {}}', ["env"])).toBe(false);
    expect(stillOnlyObservatory(withObservatory('{"env": {"MINE": "1"}}', ARGV, ENV), ["env"])).toBe(false);
    expect(stillOnlyObservatory("{}", ["hooks"])).toBe(false);
  });

  it("finds keys named twice in the root, `hooks` and `env`", () => {
    expect(duplicateKeys('{"hooks": {}, "model": "a", "hooks": {}}')).toEqual(["hooks"]);
    expect(duplicateKeys('{"env": {"A": "1", "A": "2"}, "hooks": {"Stop": [], "Stop": []}}')).toEqual(["hooks.Stop", "env.A"]);
    expect(duplicateKeys(USER_SETTINGS)).toEqual([]);
    expect(duplicateKeys("")).toEqual([]);
  });

  it("writes in the file's own line endings and indentation", () => {
    const crlf = withObservatory(USER_SETTINGS.replace(/\n/g, "\r\n"), ARGV, ENV);
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    const tabs = withObservatory(USER_SETTINGS.replace(/ {2}/g, "\t"), ARGV, ENV);
    expect(tabs).toMatch(/\n\t\t"SessionStart": \[/);
    expect(tabs).not.toMatch(/\n {2}"/);
  });

  it("starts an empty or missing file as an object, and leaves a file without Observatory as it is", () => {
    const fresh = withObservatory("", ARGV, undefined);
    expect(observatoryHookCounts(parsed(fresh)).SessionStart).toBe(1);
    expect(parsed(fresh).env).toBeUndefined();
    expect(withoutObservatory(USER_SETTINGS)).toBe(USER_SETTINGS);
  });

  it("refuses a file that is not a JSON object instead of guessing", () => {
    expect(() => withObservatory("{ not json", ARGV, ENV)).toThrow();
    expect(() => withObservatory("[1, 2]", ARGV, ENV)).toThrow();
    expect(() => withObservatory('{"hooks": []}', ARGV, ENV)).toThrow();
  });
});

describe("the user's own OpenTelemetry", () => {
  it("counts every OTel key the user set, and an Observatory key the user changed", () => {
    expect(userOtelKeys(parsed('{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://collector.example"}}'))).toEqual(["OTEL_EXPORTER_OTLP_ENDPOINT"]);
    expect(userOtelKeys(parsed('{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1"}}'))).toEqual(["CLAUDE_CODE_ENABLE_TELEMETRY"]);
    // Without the marker the keys are the user's even when they look like Observatory's.
    expect(userOtelKeys(parsed(JSON.stringify({ env: ENV })))).toHaveLength(5);
    const changed = parsed(withObservatory("{}", ARGV, ENV));
    (changed.env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example";
    expect(userOtelKeys(changed)).toEqual(["OTEL_EXPORTER_OTLP_ENDPOINT"]);
    // Taking Observatory out keeps the key the user changed.
    const text = JSON.stringify(changed, null, 2);
    expect((parsed(withoutObservatory(text)).env as Record<string, string>).OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://collector.example");
  });

  it("sends logs only, by IP, as JSON, with no metrics and no content flags", () => {
    expect(ENV).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:47310",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${TOKEN}`,
    });
  });

  it("takes a new token into an installed file only", () => {
    const record = addObservatory(USER_SETTINGS, ARGV, ENV);
    const next = observatoryOtelEnv({ port: 47310, token: "cd".repeat(32) });
    const refreshed = withRefreshedObservatoryEnv(record.text, next);
    expect((parsed(refreshed).env as Record<string, string>).OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${"cd".repeat(32)}`);
    expect(withoutObservatory(refreshed, record)).toBe(USER_SETTINGS);
    expect(withRefreshedObservatoryEnv(USER_SETTINGS, next)).toBe(USER_SETTINGS);
  });
});

describe("the marker", () => {
  it("is a group whose every hook runs `… observatory hook <event>`", () => {
    expect(isObservatoryHookGroup({ hooks: [{ type: "command", command: "x", args: ["observatory", "hook", "Stop"] }] })).toBe(true);
    expect(isObservatoryHookGroup({ hooks: [{ type: "command", command: "bun", args: ["/src/cli.ts", "observatory", "hook", "Stop"] }] })).toBe(true);
    expect(isObservatoryHookGroup({ hooks: [{ type: "command", command: "x", args: ["observatory", "hook", "Stop"] }, { type: "command", command: "mine" }] })).toBe(false);
    expect(isObservatoryHookGroup({ hooks: [{ type: "command", command: "tunelo observatory hook Stop" }] })).toBe(false);
    expect(isObservatoryHookGroup({ hooks: [] })).toBe(false);
  });
});

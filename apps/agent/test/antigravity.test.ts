// Antigravity's adapter: the ACP client, permission modes against agy's own
// setting, "allow for the session" kept by tunelo, history from agy's
// transcripts, the commit message writer and plan usage, on fixtures
// recorded from agy 1.5.8.
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Decision, ErrorCode, Role, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AcpClient, AcpClosed, type AcpProcess } from "../src/providers/acp/acp-client.ts";
import { AgyAcp } from "../src/providers/antigravity/acp-process.ts";
import { agyEnv, parseVersion, supported, toolPermission } from "../src/providers/antigravity/agy.ts";
import { AgyHistory, entriesOf, userText } from "../src/providers/antigravity/history.ts";
import { FULL_ACCESS, createAntigravityProvider, modeRefusal } from "../src/providers/antigravity/index.ts";
import { parseUsage } from "../src/providers/antigravity/quota.ts";
import { WRITER_SETTINGS, writerAnswer, writerArgs } from "../src/providers/antigravity/writer.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { fakeAgy } from "./support/fake-agy.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "acp", "antigravity", name), "utf8");
const consent = { sensitive: false, projectSettings: false };

/** A process whose replies the test writes by hand. */
function scripted() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const written: unknown[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (c: string) => {
    for (const line of c.split("\n").filter(Boolean)) written.push(JSON.parse(line));
  });
  const proc = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => (events.emit("exit", 0, null), true),
    once: (e: string, fn: (...a: unknown[]) => void) => (events.once(e, fn), proc),
  };
  return { proc: proc as unknown as AcpProcess, stdout, written, exit: () => events.emit("exit", 1, null) };
}

function agyProvider(permission = "request-review") {
  const agy = fakeAgy();
  const provider = createAntigravityProvider({
    findBinary: async () => "agy",
    acp: new AgyAcp({ findBinary: async () => "agy", log: () => undefined, spawnProcess: agy.spawnProcess }),
    toolPermission: () => permission,
  });
  provider.detect = async () => ({ installed: true, version: "1.5.8", loginState: "ok" });
  return { provider, agy };
}

describe("the ACP client", () => {
  it("answers the AI's requests by their own id, refuses unknown ones and skips what is not JSON", async () => {
    const s = scripted();
    const logs: string[] = [];
    const client = new AcpClient({ launch: { file: "agy", args: ["acp"], env: {}, cwd: "/" }, log: (l) => logs.push(l), spawnProcess: () => s.proc });
    client.onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "deny" } }));
    s.stdout.write("not json\n");
    s.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "7", method: "session/request_permission", params: {} })}\n`);
    s.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "8", method: "fs/read_text_file", params: { path: "/etc/passwd" } })}\n`);
    await new Promise((r) => setTimeout(r, 10));
    expect(s.written).toContainEqual({ jsonrpc: "2.0", id: "7", result: { outcome: { outcome: "selected", optionId: "deny" } } });
    expect(s.written).toContainEqual(expect.objectContaining({ id: "8", error: expect.objectContaining({ code: -32601 }) }));
    expect(logs.some((l) => l.includes("not JSON"))).toBe(true);
  });

  it("fails what waits when the process ends", async () => {
    const s = scripted();
    const client = new AcpClient({ launch: { file: "agy", args: ["acp"], env: {}, cwd: "/" }, log: () => undefined, spawnProcess: () => s.proc });
    const waiting = client.request("session/new", {});
    s.exit();
    await expect(waiting).rejects.toBeInstanceOf(AcpClosed);
    await expect(client.request("session/new", {})).rejects.toBeInstanceOf(AcpClosed);
  });
});

describe("agy's own settings", () => {
  it("starts agy without a Gemini or Google key the service inherited", () => {
    const env = agyEnv({ TUNELO_AGY: "1" }, { PATH: "/bin", GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_APPLICATION_CREDENTIALS: "/c" });
    expect(env).toEqual({ PATH: "/bin", TUNELO_AGY: "1" });
  });

  it("reads toolPermission, agy's default when unset, and never writes it", () => {
    const home = tempDir("agy-home-");
    expect(toolPermission(home)).toBe("request-review");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ toolPermission: "always-proceed" }));
    expect(toolPermission(home)).toBe("always-proceed");
    writeFileSync(join(home, "settings.json"), "{broken");
    expect(toolPermission(home)).toBe("request-review");
  });

  it("knows which agy it speaks", () => {
    expect(parseVersion("agy 1.5.8 (abc)")).toBe("1.5.8");
    expect(supported("1.5.2")).toBe(true);
    expect(supported("1.10.0")).toBe(true);
    expect(supported("1.5.1")).toBe(false);
  });

  it("full access only where agy itself runs every tool without asking", () => {
    expect(modeRefusal(true, "default")).toMatch(/always-proceed/);
    expect(modeRefusal(true, FULL_ACCESS)).toBeUndefined();
    expect(modeRefusal(true, undefined)).toBeUndefined();
    expect(modeRefusal(false, FULL_ACCESS)).toMatch(/always-proceed/);
    expect(modeRefusal(false, "plan")).toBeUndefined();
  });
});

describe("Antigravity sessions", () => {
  it("under always-proceed runs in full access, which a device may keep but not leave", async () => {
    const { provider } = agyProvider("always-proceed");
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "hello", consent, device: "phone" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state !== TurnState.RUNNING));
    expect(core.info(t.id).permissionMode).toBe(FULL_ACCESS);
    expect(core.info(t.id).permissionModes).toContain(FULL_ACCESS);
    expect(core.bypassed(t.id)).toBe(true);
    await expect(core.setPermissionMode(t.id, "default", "phone")).rejects.toThrow(/always-proceed/);
    await core.stop();
  });

  it("elsewhere offers agy's own modes and never full access", async () => {
    const { provider, agy } = agyProvider();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "hello", consent, device: "phone" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state !== TurnState.RUNNING));
    expect(core.info(t.id).permissionModes).toEqual(["default", "accept-edits", "plan"]);
    await expect(core.setPermissionMode(t.id, FULL_ACCESS, "phone")).rejects.toMatchObject({ code: ErrorCode.INVALID });
    await core.setPermissionMode(t.id, "plan", "phone");
    expect(agy.log.requests.some((r) => r.method === "session/set_mode" && r.params.modeId === "plan")).toBe(true);
    // agy's models reach devices once a session told them.
    expect(provider.capabilities.models.map((m) => m.id)).toEqual(["gemini-test", "small"]);
    expect(agy.log.launches[0]?.args).toEqual(["acp"]);
    expect(agy.log.launches[0]?.env.TUNELO_AGY).toBe("1");
    await core.stop();
  });

  it("keeps 'allow for the session' itself: the same command runs, another one asks, agy never hears 'always'", async () => {
    const { provider, agy } = agyProvider();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "ask npm test", consent, device: "phone" });
    const pending = await until(core, t.id, (i) => byCase(i, "approval").length > 0);
    const card = byCase(pending, "approval")[0];
    if (!card) throw new Error("no approval");
    core.respond(t.id, card.id, card.revision, { decision: Decision.ALLOW_SESSION }, "phone");
    await until(core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length >= 1);
    await core.send(t.id, "ask npm test", "");
    await until(core, t.id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length >= 2);
    await core.send(t.id, "ask rm -rf build", "");
    const again = await until(core, t.id, (i) => byCase(i, "approval").length > 1);
    expect(byCase(again, "approval")).toHaveLength(2);
    expect(agy.log.answers).toEqual(["allow", "allow"]);
    await core.stop();
  });

  it("shows thinking and the reply as their own texts", async () => {
    const { provider } = agyProvider();
    const { core, work } = makeCore([provider]);
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "think", consent, device: "phone" });
    const items = await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state !== TurnState.RUNNING));
    expect(byCase(items, "text").map((x) => [x.body.value.role, x.body.value.text])).toEqual([
      [Role.USER, "think"],
      [Role.THINKING, "thinking"],
      [Role.ASSISTANT, "echo: think"],
    ]);
    await core.stop();
  });
});

describe("agy's history", () => {
  it("reads the user's words, replies and tool calls of a transcript", () => {
    expect(userText("<USER_REQUEST>\nReply pong\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>")).toBe("Reply pong");
    const lines = [
      { step_index: 0, type: "USER_INPUT", created_at: "2026-11-13T09:00:00Z", content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-13T09:00:01Z", thinking: "hmm", content: "hello", tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] },
      { step_index: 2, type: "SOMETHING_NEW", content: "x" },
    ];
    const entries = entriesOf("s1", `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    expect(entries.map((e) => e.type)).toEqual(["user", "text", "text", "tool-start", "tool-end"]);
    expect(entries[0]).toMatchObject({ type: "user", id: "s1:0", text: "hi" });
    expect(entries[3]).toMatchObject({ type: "tool-start", summary: "ls" });
  });

  it("lists sessions of a folder from agy's own list, and reads whole lines only", async () => {
    const home = tempDir("agy-history-");
    const logs = join(home, "brain", "s1", ".system_generated", "logs");
    mkdirSync(logs, { recursive: true });
    const line = JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" });
    writeFileSync(join(logs, "transcript.jsonl"), `${line}\n{"step_index":1,"type":"PLANNER_RES`);
    const h = new AgyHistory({
      home: () => home,
      listSessions: async () => [
        { sessionId: "s1", cwd: "/work/app", title: "Hi there", updatedAt: 1 },
        { sessionId: "s2", cwd: "/other", title: "Else", updatedAt: 2 },
        { sessionId: "../x", cwd: "/work/app", title: "odd", updatedAt: 3 },
      ],
    });
    await h.prime();
    const page = h.list({ dir: "/work", query: "", offset: 0, limit: 10 });
    expect(page.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    const read = h.read("s1", 0);
    expect(read?.entries).toHaveLength(1);
    expect(read?.end).toBe(Buffer.byteLength(line) + 1);
    expect(h.read("../x", 0)).toBeUndefined();
  });
});

describe("commit message and usage", () => {
  it("runs agy with every tool denied and reads only its result", () => {
    expect(writerArgs()).toContain("--sandbox");
    expect(WRITER_SETTINGS.permissions.deny).toEqual(expect.arrayContaining(["read_file(*)", "write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)"]));
    // Recorded: asked to read a file outside the folder, agy could not.
    expect(writerAnswer(fixture("writer-deny-all.ndjson"))).toMatch(/^CANNOT/);
    expect(() => writerAnswer('{"event":"result","result":{"status":"ERROR","error":"boom"}}')).toThrow(/boom/);
  });

  it("shows the tighter group of each usage window", () => {
    const usage = parseUsage(fixture("usage-command.json"));
    expect(usage?.fiveHour?.utilization).toBe(5);
    expect(usage?.sevenDay?.utilization).toBe(2);
    expect(usage?.sevenDay?.resetsAt).toBeGreaterThan(0);
    expect(parseUsage("{}")).toBeUndefined();
  });
});

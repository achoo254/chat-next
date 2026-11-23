// Observatory over the end-to-end link of a running machine, with devices of
// the account: the recent sessions listed; a CLI session (no tunelo thread)
// and an SDK session watched by their Claude Code session id; two devices
// watching one session get the same events, seq one apart from their
// snapshot; watching again gives a fresh snapshot at the current seq; older
// events page back from the snapshot; the caps are refused with their
// reason. With content storage on (the default), content and account
// identifiers fed in never appear in any frame a device gets, while the
// store keeps the content.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MessageInitShape, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ErrorReason, type Frame, FrameSchema, ObservatorySessionSource } from "@achoo254/chat-proto/remote/remote";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { Machine } from "../../src/machine.ts";
import { WATCHES_PER_CONNECTION } from "../../src/observatory/hub/observatory-hub.ts";
import { filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import { fakeProvider } from "../fake-provider.ts";
import { type Device, connectDevice, waitFor } from "../support/machine-device.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";
import { FAKE_CWD, FAKE_HOME, FAKE_IDENTIFIERS, HOOK_PAYLOADS, isFakeSensitive } from "./observatory-payloads.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const MARK = "ZZCONTENT-8b2f-private";
const CLI = "cli-session-0001";
/** Names of account identifiers as Claude Code sends them; none may be a key or a value on the wire. */
const IDENTITY_KEYS = ["user.email", "user.id", "user.account_uuid", "organization.id", "user_email", "account_uuid"];

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

/** Sends a request and waits for the frame answering it. */
async function ask(device: Device, id: string, body: Body): Promise<Frame> {
  device.request(id, body);
  await waitFor(() => device.frames.some((f) => f.id === id));
  const answer = device.frames.find((f) => f.id === id);
  if (!answer) throw new Error(`no answer to ${id}`);
  return answer;
}

const snapshotOf = (f: Frame) => {
  if (f.body.case !== "observatorySnapshot") throw new Error(`expected a snapshot, got ${f.body.case}: ${f.body.case === "error" ? f.body.value.message : ""}`);
  return f.body.value;
};

const eventsFor = (device: Device, sessionId: string) =>
  device.frames.flatMap((f) => (f.body.case === "observatoryEvents" && f.body.value.sessionId === sessionId ? f.body.value.events : []));

/** A CLI session's hook records as the spool hands them over: filtered by the hook, content kept. */
function cliRecords(at: number, n: number) {
  const ctx = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true };
  const base = { session_id: CLI, transcript_path: join(FAKE_HOME, ".claude", "projects", "x.jsonl"), cwd: FAKE_CWD, permission_mode: "default", user_email: "user@example.invalid" };
  const records = [
    filterHookEvent("SessionStart", { ...base, hook_event_name: "SessionStart", source: "startup", model: "claude-opus-4-5" }, ctx, at),
    filterHookEvent("UserPromptSubmit", { ...base, hook_event_name: "UserPromptSubmit", prompt_id: `cli-prompt-${n}`, prompt: `please ${MARK} now` }, ctx, at + 1),
    filterHookEvent(
      "PostToolUse",
      { ...base, hook_event_name: "PostToolUse", prompt_id: `cli-prompt-${n}`, tool_name: "Bash", tool_use_id: `cli-tool-${n}`, duration_ms: 40, tool_input: { command: `echo ${MARK}` }, tool_response: { stdout: MARK, stderr: "" } },
      ctx,
      // A call is stored at its start (this time less its duration): after the prompt.
      at + 100,
    ),
  ];
  return records.flatMap((r) => (r ? [r] : []));
}

/** A recorded payload with its paths under this machine's home folder, the one the agent's own filter turns into `~`. */
function onThisHome(payload: Record<string, unknown>): Record<string, unknown> {
  const inJson = (p: string): string => JSON.stringify(p).slice(1, -1);
  const parsed: unknown = JSON.parse(JSON.stringify(payload).replaceAll(inJson(FAKE_HOME), inJson(homedir())));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not a payload");
  return parsed as Record<string, unknown>;
}

async function startMachine(): Promise<{ machine: Machine; port: number; dir: string }> {
  const dir = obsTempDir("link");
  const config = new ConfigStore(join(dir, "config"));
  const machine = new Machine({ config, providers: [fakeProvider()], log: () => undefined, observatory: { dataDir: join(dir, "data") } });
  const port = await machine.start(0);
  stops.push(() => machine.stop());
  return { machine, port, dir };
}

describe("Observatory over the link", () => {
  it("lists sessions and streams a CLI session to two devices by session id, without content or account identifiers", async () => {
    const { machine, port, dir } = await startMachine();
    const a = await connectDevice(machine, port, "phone");
    const b = await connectDevice(machine, port, "laptop");
    stops.push(async () => {
      a.close();
      b.close();
    });

    // A session the agent runs through the SDK (raw hook payloads, filtered by the agent) and a CLI one from the spool.
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
      const payload = onThisHome(HOOK_PAYLOADS[event] ?? {});
      machine.observatory.takeHookEvent(event, event === "UserPromptSubmit" ? { ...payload, prompt: `sdk ${MARK}` } : payload);
    }
    const t = Date.now() - 60_000;
    for (const r of cliRecords(t, 1)) await machine.observatory.accept(r, "spool");

    // Both sessions stored, the newest first.
    let list = await ask(a, "l0", { case: "observatorySessionList", value: {} });
    for (let i = 1; list.body.case === "observatorySessionListResult" && list.body.value.sessions.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      list = await ask(a, `l${i}`, { case: "observatorySessionList", value: {} });
    }
    if (list.body.case !== "observatorySessionListResult") throw new Error(`no list: ${list.body.case}`);
    const sessions = list.body.value.sessions;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([CLI, "sess-0001"].sort());
    expect(sessions.map((s) => Number(s.startedAt))).toEqual([...sessions.map((s) => Number(s.startedAt))].sort((x, y) => y - x));
    expect(sessions.find((s) => s.sessionId === CLI)?.source).toBe(ObservatorySessionSource.CLI);
    expect(sessions.find((s) => s.sessionId === "sess-0001")?.source).toBe(ObservatorySessionSource.SDK);
    expect(sessions.find((s) => s.sessionId === CLI)?.cwd).toBe("~/work/example-app");

    // The CLI session has no thread: it is watched by its session id.
    const snapA = snapshotOf(await ask(a, "wa", { case: "observatoryWatch", value: { sessionId: CLI, on: true } }));
    const snapB = snapshotOf(await ask(b, "wb", { case: "observatoryWatch", value: { sessionId: CLI, on: true } }));
    expect(snapA.events.map((e) => e.kind.case)).toEqual(["prompt", "toolCall"]);
    expect(snapA.session?.info?.sessionId).toBe(CLI);
    expect(snapA.session?.totals).toMatchObject({ prompts: 1, toolCalls: 1 });
    expect(snapB.seq).toBe(snapA.seq);
    expect(snapB.epoch).toBe(snapA.epoch);

    // More of the session: both devices get the same events, seq one apart from the snapshot.
    for (const r of cliRecords(t + 1_000, 2)) await machine.observatory.accept(r, "spool");
    await waitFor(() => eventsFor(a, CLI).some((e) => e.kind.case === "session") && eventsFor(b, CLI).some((e) => e.kind.case === "session"));
    const got = eventsFor(a, CLI);
    expect(got.map((e) => Number(e.seq))).toEqual(got.map((_, i) => Number(snapA.seq) + i + 1));
    expect(got.map((e) => e.id)).toEqual(expect.arrayContaining(["prompt:cli-prompt-2", "tool:cli-tool-2"]));
    expect(eventsFor(b, CLI)).toEqual(got);
    const tool = got.find((e) => e.kind.case === "toolCall")?.kind;
    expect(tool?.case === "toolCall" ? [tool.value.toolName, tool.value.target, tool.value.success, tool.value.durationMs] : undefined).toEqual(["Bash", "echo", true, 40]);

    // Watching again: a fresh snapshot at the current seq, then older events page back from it.
    const again = snapshotOf(await ask(a, "wa2", { case: "observatoryWatch", value: { sessionId: CLI, on: true, limit: 1 } }));
    expect(again.seq).toBe(got.at(-1)?.seq);
    expect(again.events).toHaveLength(1);
    const older = await ask(a, "e1", { case: "observatoryEarlier", value: { sessionId: CLI, earlier: again.earlier, limit: 10 } });
    if (older.body.case !== "observatoryEarlierResult") throw new Error(`no page: ${older.body.case}`);
    expect(older.body.value.events.map((e) => e.id)).toEqual(["prompt:cli-prompt-1", "tool:cli-tool-1", "prompt:cli-prompt-2"]);
    expect(older.body.value.earlier).toBe("");

    // The SDK session too, by its session id.
    const sdk = snapshotOf(await ask(b, "ws", { case: "observatoryWatch", value: { sessionId: "sess-0001", on: true } }));
    expect(sdk.session?.totals?.prompts).toBe(1);

    // Stopping a watch: acknowledged, and nothing more of that session reaches the device.
    const off = await ask(b, "wb-off", { case: "observatoryWatch", value: { sessionId: CLI, on: false } });
    expect(off.body.case).toBe("ack");
    const heard = eventsFor(b, CLI).length;
    for (const r of cliRecords(t + 2_000, 3)) await machine.observatory.accept(r, "spool");
    await waitFor(() => eventsFor(a, CLI).some((e) => e.id === "tool:cli-tool-3"));
    expect(eventsFor(b, CLI)).toHaveLength(heard);

    // The store keeps the content; no frame either device got carries it, nor any account identifier.
    const exported = join(dir, "export.jsonl");
    await machine.observatory.exportToFile(exported, true);
    expect(readFileSync(exported, "utf8")).toContain(MARK);
    const wire = [...a.frames, ...b.frames];
    expect(wire.some((f) => f.body.case === "observatoryEvents")).toBe(true);
    for (const f of wire) {
      const text = toJsonString(FrameSchema, f);
      const bytes = Buffer.from(toBinary(FrameSchema, f)).toString("latin1");
      for (const needle of [MARK, ...FAKE_IDENTIFIERS, ...IDENTITY_KEYS]) {
        expect(text, needle).not.toContain(needle);
        expect(bytes, needle).not.toContain(needle);
      }
    }
  });

  it("refuses a watch past the cap of one connection with its reason", async () => {
    const { machine, port } = await startMachine();
    const a = await connectDevice(machine, port, "phone");
    stops.push(async () => a.close());
    for (let i = 0; i < WATCHES_PER_CONNECTION; i++) snapshotOf(await ask(a, `w${i}`, { case: "observatoryWatch", value: { sessionId: `s-${i}`, on: true } }));
    const refused = await ask(a, "w-extra", { case: "observatoryWatch", value: { sessionId: "s-extra", on: true } });
    expect(refused.body.case === "error" ? refused.body.value.reason : undefined).toBe(ErrorReason.OBSERVATORY_WATCH_LIMIT);
    const bad = await ask(a, "e-bad", { case: "observatoryEarlier", value: { sessionId: "s-0", earlier: "nope" } });
    expect(bad.body.case === "error" ? bad.body.value.reason : undefined).toBe(ErrorReason.OBSERVATORY_INVALID);
  });

  it("answers that Observatory is off when the machine has it switched off", async () => {
    const dir = obsTempDir("link-off");
    const config = new ConfigStore(join(dir, "config"));
    config.update((c) => (c.observatory = { enabled: false }));
    const machine = new Machine({ config, providers: [fakeProvider()], log: () => undefined, observatory: { dataDir: join(dir, "data") } });
    const port = await machine.start(0);
    stops.push(() => machine.stop());
    const a = await connectDevice(machine, port, "phone");
    stops.push(async () => a.close());
    const answer = await ask(a, "l", { case: "observatorySessionList", value: {} });
    expect(answer.body.case === "error" ? answer.body.value.reason : undefined).toBe(ErrorReason.OBSERVATORY_OFF);
  });
});

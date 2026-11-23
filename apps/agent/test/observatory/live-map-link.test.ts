// The Live Map over the end-to-end link of a running machine, with a device
// of the account: a Claude Code thread lists its session and another AI's
// thread none; a CLI session's snapshot carries its live state; a hook record
// still in the spool reaches the device as a provisional event, then as the
// stored one under the same id; a station's numbers; an event's content by
// its id while the project keeps content, and none once it is switched off
// mid-session (the stored content cleared). Apart from that one answer, no
// frame the device got carries content or an account identifier.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MessageInitShape, toBinary, toJsonString } from "@bufbuild/protobuf";
import { type Frame, FrameSchema, ObservatoryContentState, ObservatoryCoreState } from "@achoo254/chat-proto/remote/remote";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config.ts";
import { Machine } from "../../src/machine.ts";
import { filterHookEvent } from "../../src/observatory/privacy/filter-hook-event.ts";
import type { FilteredRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { SPOOL_DIR, minuteOf, spoolFileName } from "../../src/observatory/spool/spool-files.ts";
import { fakeProvider } from "../fake-provider.ts";
import { type Device, connectDevice, waitFor } from "../support/machine-device.ts";
import { obsTempDir, removeObsTempDirs } from "./obs-temp-dirs.ts";
import { FAKE_CWD, FAKE_HOME, FAKE_IDENTIFIERS, isFakeSensitive } from "./observatory-payloads.ts";

afterAll(removeObsTempDirs);

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const MARK = "ZZCONTENT-7a3e-private";
const CLI = "cli-session-live-map";
const IDENTITY_KEYS = ["user.email", "user.id", "user.account_uuid", "organization.id", "user_email", "account_uuid"];

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

async function ask(device: Device, id: string, body: Body): Promise<Frame> {
  device.request(id, body);
  await waitFor(() => device.frames.some((f) => f.id === id));
  const answer = device.frames.find((f) => f.id === id);
  if (!answer) throw new Error(`no answer to ${id}`);
  return answer;
}

const ctx = { home: FAKE_HOME, isSensitive: isFakeSensitive, contentAllowed: true };
const base = (sessionId: string) => ({ session_id: sessionId, transcript_path: join(FAKE_HOME, ".claude", "projects", "x.jsonl"), cwd: FAKE_CWD, permission_mode: "default", user_email: "user@example.invalid" });

function hook(event: string, payload: Record<string, unknown>, at: number, sessionId = CLI): FilteredRecord {
  const r = filterHookEvent(event, { ...base(sessionId), hook_event_name: event, ...payload }, ctx, at);
  if (!r) throw new Error(`${event} filtered out`);
  return r;
}

function turn(at: number, n: number): FilteredRecord[] {
  return [
    hook("UserPromptSubmit", { prompt_id: `p${n}`, prompt: `please ${MARK} now` }, at),
    hook("PostToolUse", { prompt_id: `p${n}`, tool_name: "Bash", tool_use_id: `t${n}`, duration_ms: 40, tool_input: { command: `echo ${MARK}` }, tool_response: { stdout: MARK, stderr: "" } }, at + 100),
  ];
}

describe("the Live Map over the link", () => {
  it("lists a thread's sessions, streams provisional then stored events, answers a station and content by id only while the project keeps it", async () => {
    const dir = obsTempDir("live-map-link");
    const dataDir = join(dir, "data");
    const config = new ConfigStore(join(dir, "config"));
    const machine = new Machine({ config, providers: [fakeProvider("claude"), fakeProvider()], log: () => undefined, observatory: { dataDir } });
    const port = await machine.start(0);
    stops.push(() => machine.stop());
    const a = await connectDevice(machine, port, "phone");
    stops.push(async () => a.close());

    // A Claude Code thread and another AI's, each with a session; their sessions stored.
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    const threadOf = async (id: string, provider: string): Promise<string> => {
      const created = await ask(a, id, { case: "threadCreate", value: { provider, dir: work, text: "hi" } });
      if (created.body.case !== "threadCreated") throw new Error(`no thread: ${created.body.case === "error" ? created.body.value.message : created.body.case}`);
      return created.body.value.thread?.id ?? "";
    };
    const claudeThread = await threadOf("c1", "claude");
    const fakeThread = await threadOf("c2", "fake");
    await waitFor(() => machine.core.sessionIdOf(claudeThread) !== "" && machine.core.sessionIdOf(fakeThread) !== "");
    const t = Date.now() - 60_000;
    for (const sessionId of ["claude-session-1", "fake-session-1"]) await machine.observatory.accept(hook("SessionStart", { source: "startup", model: "claude-sonnet-5-5" }, t, sessionId), "spool");
    for (const r of [hook("SessionStart", { source: "startup", model: "claude-sonnet-5-5" }, t), ...turn(t + 10, 1)]) await machine.observatory.accept(r, "spool");

    const listOf = async (id: string, threadId: string): Promise<string[]> => {
      const f = await ask(a, id, { case: "observatorySessionList", value: { threadId } });
      if (f.body.case !== "observatorySessionListResult") throw new Error(`no list: ${f.body.case}`);
      return f.body.value.sessions.map((s) => s.sessionId);
    };
    await waitFor(() => machine.observatory.status().pendingWrites === 0);
    let claudeSessions: string[] = [];
    for (let i = 0; claudeSessions.length === 0 && i < 50; i++) {
      claudeSessions = await listOf(`lc${i}`, claudeThread);
      if (claudeSessions.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(claudeSessions).toEqual(["claude-session-1"]);
    expect(await listOf("lf", fakeThread)).toEqual([]);
    expect(await listOf("lu", "no-such-thread")).toEqual([]);

    // The CLI session: its snapshot carries the live state.
    const snap = await ask(a, "w", { case: "observatoryWatch", value: { sessionId: CLI, on: true } });
    if (snap.body.case !== "observatorySnapshot") throw new Error(`no snapshot: ${snap.body.case}`);
    expect(snap.body.value.events.map((e) => e.id)).toEqual(["prompt:p1", "tool:t1"]);
    expect(snap.body.value.session?.live?.core).toBe(ObservatoryCoreState.THINKING);
    // The fake working folder does not exist, so the session has no project: content whose project
    // cannot be told is blocked as soon as any project keeps none (write-ops.ts), and cleared with it.
    const projectKey = snap.body.value.session?.info?.projectKey || "local:example-app";

    // Content by id, while the project keeps it: the one answer allowed to carry it.
    const stored = await ask(a, "content-on", { case: "observatoryContent", value: { sessionId: CLI, eventId: "prompt:p1" } });
    expect(stored.body.case === "observatoryContentResult" ? [stored.body.value.state, stored.body.value.text] : undefined).toEqual([ObservatoryContentState.STORED, expect.stringContaining(MARK)]);

    // A tool call still in the spool: provisional first, then stored under the same id.
    const pre = hook("PreToolUse", { prompt_id: "p1", tool_name: "Read", tool_use_id: "t-live", tool_input: { file_path: join(FAKE_CWD, "src", "app.ts") } }, Date.now());
    const spool = join(dataDir, SPOOL_DIR);
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, spoolFileName("events", minuteOf(Date.now()))), `${JSON.stringify(pre)}\n`);
    const live = () => a.frames.flatMap((f) => (f.body.case === "observatoryEvents" ? f.body.value.events.filter((e) => e.id === "tool:t-live") : []));
    await waitFor(() => live().length > 0);
    expect(live()[0]?.provisional).toBe(true);
    await machine.observatory.accept(pre, "spool");
    await waitFor(() => live().some((e) => !e.provisional));
    const kinds = live().map((e) => (e.kind.case === "toolCall" ? [e.provisional, e.kind.value.station] : undefined));
    expect(kinds.at(0)).toEqual([true, "FILES"]);
    expect(kinds.at(-1)).toEqual([false, "FILES"]);

    // A station's numbers.
    const station = await ask(a, "st", { case: "observatoryStation", value: { sessionId: CLI, station: "SANDBOX" } });
    if (station.body.case !== "observatoryStationResult") throw new Error(`no station: ${station.body.case}`);
    expect(station.body.value.numbers).toMatchObject({ calls: 1, ended: 1, failures: 0, p50Ms: 40 });
    expect(station.body.value.recent.map((e) => e.id)).toEqual(["tool:t1"]);

    // Content switched off mid-session: what was stored is cleared, what comes after is not kept, and none goes out.
    await machine.observatory.setProjectContent(projectKey, false);
    for (const r of turn(t + 2_000, 2)) await machine.observatory.accept(r, "spool");
    await waitFor(() => a.frames.some((f) => f.body.case === "observatoryEvents" && f.body.value.events.some((e) => e.id === "tool:t2")));
    for (const [i, id] of ["prompt:p1", "tool:t1", "prompt:p2", "tool:t2"].entries()) {
      const f = await ask(a, `content-off-${i}`, { case: "observatoryContent", value: { sessionId: CLI, eventId: id } });
      expect(f.body.case === "observatoryContentResult" ? [f.body.value.state, f.body.value.text] : undefined, id).toEqual([ObservatoryContentState.OFF, ""]);
    }
    await ask(a, "st2", { case: "observatoryStation", value: { sessionId: CLI, station: "SANDBOX" } });
    await ask(a, "w2", { case: "observatoryWatch", value: { sessionId: CLI, on: true } });

    const wire = a.frames.filter((f) => f.id !== "content-on");
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
});

// The office over the end-to-end link: watching a thread gives a snapshot,
// then events with consecutive seq; watching again gives a fresh snapshot at
// the current seq; a connection that does not watch hears nothing; stopping
// the watch drops the office. And no office frame ever carries a tool's
// input or output, a command, a todo's text or the AI's words.
import { join } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import {
  Decision,
  type Frame,
  OfficeActorState,
  OfficeApprovalState,
  type OfficeEvent,
  OfficeEventsSchema,
  OfficeRole,
  OfficeRoom,
  OfficeSnapshotSchema,
  PromptState,
  TurnState,
} from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { officeHubFor } from "../src/office/office-hub.ts";
import type { AgentProvider, AskUser, ProviderEvent, ProviderSession, SessionHistory } from "../src/providers/types.ts";
import { Channel } from "../src/util/channel.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";

const MARK = "ZZMARKER-91c4-private";
const consent = { sensitive: false, projectSettings: false };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The record of a session kept by the AI: none here, but it reports staff (as Claude does). */
const history: SessionHistory = {
  list: () => ({ sessions: [], total: 0, dirs: [] }),
  find: () => undefined,
  end: () => undefined,
  read: () => undefined,
  subagentActivity: async () => ({ subagents: [], usage: [] }),
};

/** One scripted turn touching every kind of signal, with MARK in every input, output and text. */
async function script(events: Channel<ProviderEvent>, askUser: AskUser): Promise<void> {
  const push = (e: ProviderEvent) => events.push(e);
  push({ type: "tool-start", toolId: "q1", kind: "shell", name: "Bash", summary: `pnpm test ${MARK}`, input: JSON.stringify({ command: `pnpm test ${MARK}` }) });
  push({ type: "tool-end", toolId: "q1", ok: true, output: `${MARK} 12 passed` });
  push({ type: "tool-start", toolId: "r1", kind: "read", name: "Read", summary: `src/${MARK}/notes.md`, input: JSON.stringify({ file_path: `/w/src/${MARK}/notes.md` }) });
  push({ type: "tool-end", toolId: "r1", ok: true, output: `${MARK} file body` });
  push({ type: "todo", entries: [{ text: `${MARK} first`, state: "done" }, { text: `${MARK} second`, state: "in-progress" }, { text: `${MARK} third`, state: "pending" }] });
  push({ type: "subagent", toolId: "a1", description: "Review the diff", done: false, agentType: "code-reviewer" });
  push({ type: "subagent-tool", parentToolId: "a1", toolId: "s1", name: "Bash", kind: "shell", done: false, command: `git status ${MARK}` });
  await wait(20);
  push({ type: "subagent-tool", parentToolId: "a1", toolId: "s1", name: "", kind: "other", done: true, ok: true });
  push({ type: "subagent", toolId: "a1", description: "", done: true });
  push({ type: "tool-start", toolId: "m1", kind: "shell", name: "Bash", summary: `npm run dev ${MARK}`, input: JSON.stringify({ command: `npm run dev ${MARK}`, run_in_background: true }) });
  push({ type: "tool-end", toolId: "m1", ok: true, output: `${MARK} started in the background` });
  await wait(20);
  push({ type: "background-task", toolId: "m1", ok: true });
  await askUser(
    { kind: "approval", toolId: "ap1", toolKind: "shell", name: "Bash", summary: `rm -rf ${MARK}`, input: JSON.stringify({ command: `rm -rf ${MARK}` }), sensitive: false },
    new AbortController().signal,
  );
  push({ type: "text", blockId: "b1", role: "assistant", text: `${MARK} all done` });
  push({
    type: "turn-end",
    state: "completed",
    durationMs: 50,
    stats: { model: "m", inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, numTurns: 1, apiMsTotal: 40, costUsdTotal: 0.5 },
  });
}

function officeProvider(): AgentProvider {
  return {
    id: "office-ai",
    name: "Office AI",
    capabilities: {
      interrupt: true,
      resume: true,
      sessionAllow: true,
      questions: true,
      todo: true,
      contextUsage: false,
      compaction: false,
      diff: false,
      images: false,
      models: [{ id: "small", name: "Small" }],
      effortLevels: [],
      permissionModes: ["default"],
    },
    history,
    async detect() {
      return { installed: true, version: "1.0.0", loginState: "ok" };
    },
    async start({ askUser }): Promise<ProviderSession> {
      const events = new Channel<ProviderEvent>();
      events.push({ type: "session", sessionId: "office-session-1" });
      let chain = Promise.resolve();
      return {
        events,
        async send() {
          chain = chain.then(() => script(events, askUser));
        },
        async interrupt() {},
        async setModel() {},
        async setEffort() {},
        async setPermissionMode() {},
        async close() {
          await chain;
          events.close();
        },
      };
    },
  };
}

const officeFrames = (frames: Frame[]) => frames.filter((f) => f.body.case === "officeSnapshot" || f.body.case === "officeEvents");
const eventsOf = (frames: Frame[]): OfficeEvent[] => frames.flatMap((f) => (f.body.case === "officeEvents" ? f.body.value.events : []));

describe("the office over the link", () => {
  it("snapshot, then consecutive events to the watcher only; a fresh snapshot on asking again; nothing private on the wire", async () => {
    const provider = officeProvider();
    const { core, work, audit } = makeCore([provider]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const watcher = await pairedDevice({ core, config, audit, providers: [provider] });
    const other = await pairedDevice({ core, config, audit, providers: [provider] });

    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    const first = await watcher.request("w1", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    if (first.body.case !== "officeSnapshot") throw new Error(`expected a snapshot, got ${first.body.case}`);
    const snap = first.body.value;
    expect(snap.threadId).toBe(thread.id);
    expect(snap.epoch).toBe(core.epoch);
    expect(snap.state?.reportsStaff).toBe(true);
    expect(snap.state?.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR]);

    await core.send(thread.id, `please ${MARK}`, "c1");
    const items = await until(core, thread.id, (all) => byCase(all, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const ask = byCase(items, "approval")[0];
    if (!ask) throw new Error("no approval");
    core.respond(thread.id, ask.id, ask.revision, { decision: Decision.DENY }, "test");
    await until(core, thread.id, (all) => byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    await wait(600);

    const events = eventsOf(watcher.received);
    // Consecutive, right after the snapshot.
    expect(events.map((e) => Number(e.seq))).toEqual(events.map((_, i) => Number(snap.seq) + i + 1));
    expect(events.some((e) => e.kind.case === "turnStart")).toBe(true);
    const enters = events.flatMap((e) => (e.kind.case === "actorEnter" ? [e.kind.value] : []));
    expect(enters.map((a) => [a.role, a.agentType])).toEqual([
      [OfficeRole.EMPLOYEE, "code-reviewer"],
      [OfficeRole.MACHINE, "Bash"],
    ]);
    const starts = events.flatMap((e) => (e.kind.case === "activityStart" ? [[e.kind.value.actorId, e.kind.value.activity?.tool, e.kind.value.activity?.room, e.kind.value.activity?.subject]] : []));
    expect(starts).toContainEqual(["director", "Bash", OfficeRoom.QA, "pnpm"]);
    expect(starts).toContainEqual(["director", "Read", OfficeRoom.LIBRARY, "notes.md"]);
    expect(starts).toContainEqual(["a1", "Bash", OfficeRoom.POST, ""]);
    expect(events.some((e) => e.kind.case === "actorLeave" && e.kind.value.actorId === "m1")).toBe(true);
    const approvals = events.flatMap((e) => (e.kind.case === "approval" ? [[e.kind.value.actorId, e.kind.value.state]] : []));
    expect(approvals).toEqual([
      ["director", OfficeApprovalState.WAITING],
      ["director", OfficeApprovalState.DENIED],
    ]);
    const lastSession = events.flatMap((e) => (e.kind.case === "session" ? [e.kind.value] : [])).at(-1);
    expect(lastSession).toMatchObject({ busy: false, tasksDone: 2, todo: { pending: 1, inProgress: 1, done: 1 }, checks: { passed: 1, failed: 0, lastOk: true } });
    expect(lastSession?.usage).toMatchObject({ inputTokens: 10n, outputTokens: 20n, costUsdEstimate: 0.5, hasCost: true, available: true });

    // The other connection watches nothing: it hears no office.
    expect(officeFrames(other.received)).toEqual([]);

    // Asking again: a fresh snapshot at the seq reached, the employee done, the machine gone.
    const again = await watcher.request("w2", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    if (again.body.case !== "officeSnapshot") throw new Error("expected a snapshot");
    expect(Number(again.body.value.seq)).toBe(Number(events.at(-1)?.seq));
    const staff = again.body.value.state?.actors ?? [];
    expect(staff.map((a) => [a.id, a.state])).toEqual([
      ["director", OfficeActorState.IDLE],
      ["a1", OfficeActorState.DONE],
    ]);

    // Nothing private in any office frame, encoded as it goes out.
    const frames = officeFrames(watcher.received);
    expect(frames.length).toBeGreaterThan(2);
    for (const f of frames) {
      const bytes =
        f.body.case === "officeSnapshot" ? toBinary(OfficeSnapshotSchema, f.body.value) : f.body.case === "officeEvents" ? toBinary(OfficeEventsSchema, f.body.value) : new Uint8Array();
      const text = Buffer.from(bytes).toString("utf8");
      expect(text).not.toContain(MARK);
      expect(text).not.toContain("rm -rf");
      expect(text).not.toContain("npm run dev");
    }

    // Stopping the watch: an ack, and the office is gone.
    const off = await watcher.request("w3", { case: "officeWatch", value: { threadId: thread.id, on: false } });
    expect(off.body.case).toBe("ack");
    expect(officeHubFor(core, [provider]).watched).toEqual([]);

    // Watched again later: the office is built from the journal; the reviewer kept its kind, the machine stays gone.
    const rebuilt = await watcher.request("w4", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    if (rebuilt.body.case !== "officeSnapshot") throw new Error("expected a snapshot");
    const state = rebuilt.body.value.state;
    expect(state?.actors.map((a) => [a.id, a.role, a.agentType, a.state])).toEqual([
      ["director", OfficeRole.DIRECTOR, "", OfficeActorState.IDLE],
      ["a1", OfficeRole.EMPLOYEE, "code-reviewer", OfficeActorState.DONE],
    ]);
    expect(state?.session).toMatchObject({ busy: false, tasksDone: 2, todo: { pending: 1, inProgress: 1, done: 1 }, checks: { passed: 1, failed: 0 } });
    expect(state?.session?.usage).toMatchObject({ inputTokens: 10n, outputTokens: 20n, hasCost: true, available: true });
    expect(Buffer.from(toBinary(OfficeSnapshotSchema, rebuilt.body.value)).toString("utf8")).not.toContain(MARK);

    watcher.close();
    other.close();
    await core.stop();
  });

  it("an AI that does not report its staff shows the director alone", async () => {
    const { history: _history, ...rest } = officeProvider();
    const provider: AgentProvider = { ...rest, id: "no-staff-ai" };
    const { core, work, audit } = makeCore([provider]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, providers: [provider] });
    const thread = await core.create({ provider: "no-staff-ai", model: "", dir: work, text: "", consent, device: "test" });
    await device.request("w", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    await core.send(thread.id, "go", "c1");
    const items = await until(core, thread.id, (all) => byCase(all, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const ask = byCase(items, "approval")[0];
    if (!ask) throw new Error("no approval");
    core.respond(thread.id, ask.id, ask.revision, { decision: Decision.ALLOW }, "test");
    await until(core, thread.id, (all) => byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    const snap = await device.request("w2", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    if (snap.body.case !== "officeSnapshot") throw new Error("expected a snapshot");
    expect(snap.body.value.state?.reportsStaff).toBe(false);
    expect(snap.body.value.state?.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR]);
    device.close();
    await core.stop();
  });

  it("brings in what the subagents' records tell while the machine does not run the turn", async () => {
    const base = officeProvider();
    const at = Date.now() + 60_000;
    const records: SessionHistory = {
      ...history,
      subagentActivity: async () => ({
        subagents: [
          {
            toolUseId: "e1",
            agentType: "tester",
            description: "Run the suite",
            spawnDepth: 1,
            parentToolUseId: "",
            workflowId: "",
            background: true,
            finished: false,
            updatedAt: at,
            tools: [{ toolId: "e1-t", name: "Bash", kind: "shell", at, done: true, ok: false, command: `pnpm test ${MARK}` }],
          },
        ],
        usage: [{ key: "elsewhere-call", at, inputTokens: 7, outputTokens: 9 }],
      }),
    };
    const provider: AgentProvider = { ...base, history: records };
    const { core, work, audit } = makeCore([provider]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, providers: [provider] });
    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    await device.request("w", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    // A turn on the machine names the AI's session; after it, the records are read every POLL_MS.
    await core.send(thread.id, "go", "c1");
    const items = await until(core, thread.id, (all) => byCase(all, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const ask = byCase(items, "approval")[0];
    if (!ask) throw new Error("no approval");
    core.respond(thread.id, ask.id, ask.revision, { decision: Decision.ALLOW }, "test");
    await until(core, thread.id, (all) => byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    await wait(2_200);
    const snap = await device.request("w2", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    if (snap.body.case !== "officeSnapshot") throw new Error("expected a snapshot");
    const tester = snap.body.value.state?.actors.find((a) => a.id === "e1");
    expect(tester).toMatchObject({ role: OfficeRole.EMPLOYEE, agentType: "tester", state: OfficeActorState.WORKING });
    expect(snap.body.value.state?.session?.checks).toMatchObject({ passed: 1, failed: 1, lastOk: false });
    // The machine's turn (10 in, 20 out) plus the call read from the records.
    expect(snap.body.value.state?.session?.usage).toMatchObject({ inputTokens: 17n, outputTokens: 29n, hasCost: true, available: true });
    const all = officeFrames(device.received).map((f) => (f.body.case === "officeEvents" ? Buffer.from(toBinary(OfficeEventsSchema, f.body.value)) : Buffer.alloc(0)));
    for (const b of all) expect(b.toString("utf8")).not.toContain(MARK);
    device.close();
    await core.stop();
  });

  it("refuses an unknown thread, and a closed connection stops its watches", async () => {
    const provider = officeProvider();
    const { core, work, audit } = makeCore([provider]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, providers: [provider] });
    const bad = await device.request("x", { case: "officeWatch", value: { threadId: "nope", on: true } });
    expect(bad.body.case).toBe("error");

    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    await device.request("w", { case: "officeWatch", value: { threadId: thread.id, on: true } });
    expect(officeHubFor(core, [provider]).watched).toEqual([thread.id]);
    device.close();
    expect(officeHubFor(core, [provider]).watched).toEqual([]);
    await core.stop();
  });
});

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
  ErrorReason,
  PromptState,
  TurnState,
} from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { OFFICES_PER_MACHINE, OfficeHub, type OfficeSink, WATCHES_PER_CONNECTION, officeHubFor } from "../src/office/office-hub.ts";
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

/** Director's calls (names the core does not take for secrets) with MARK in front of the command (or in the MCP server's name), and the subject each must show. */
const SECRET_FRONTS: [string, string, string, string][] = [
  ["h1", "Bash", `APP_MODE="live ${MARK}" node x.js`, "node"],
  ["h2", "Bash", `PGPASSWORD='hunter2 ${MARK}' psql`, "psql"],
  ["h3", "Bash", `$env:APP_MODE="${MARK}"; gh pr list`, "gh"],
  ["h4", "Bash", `$env:APP_MODE = "${MARK} x"; gh pr list`, "gh"],
  ["h5", "Bash", `cd ${MARK} && git status`, "git"],
  ["h6", "Bash", `cd "/w/${MARK} dir" && MODE=${MARK} make`, "make"],
  ["h7", "Bash", `set MODE=${MARK} && git push`, "git"],
  ["h8", "Bash", `"${MARK}" --version`, ""],
  ["h9", `mcp__${MARK}__create_issue`, "", "create_issue"],
  // Substitutions, backticks, an escaped quote and a no-break space in the value.
  ["h10", "Bash", `MODE=$(echo ${MARK} | base64) gh pr list`, "gh"],
  ["h11", "Bash", `MODE=\`echo ${MARK} | base64\` gh pr list`, "gh"],
  ["h12", "Bash", `X=$(printf ${MARK} ) node x.js`, "node"],
  ["h13", "Bash", `X="$(echo "a ${MARK} c")" node`, "node"],
  ["h14", "Bash", `X="a\\" ${MARK} q" node`, "node"],
  ["h15", "Bash", `A=x\u00a0${MARK} node`, "node"],
];

/** One scripted turn touching every kind of signal, with MARK in every input, output and text. */
async function script(events: Channel<ProviderEvent>, askUser: AskUser): Promise<void> {
  const push = (e: ProviderEvent) => events.push(e);
  push({ type: "tool-start", toolId: "q1", kind: "shell", name: "Bash", summary: `pnpm test ${MARK}`, input: JSON.stringify({ command: `pnpm test ${MARK}` }) });
  push({ type: "tool-end", toolId: "q1", ok: true, output: `${MARK} 12 passed` });
  push({ type: "tool-start", toolId: "r1", kind: "read", name: "Read", summary: `src/${MARK}/notes.md`, input: JSON.stringify({ file_path: `/w/src/${MARK}/notes.md` }) });
  push({ type: "tool-end", toolId: "r1", ok: true, output: `${MARK} file body` });
  // MARK where the command's first word is looked for: assignments, quoted values, PowerShell's $env:, a `cd` in front, an MCP server's name.
  for (const [id, name, command] of SECRET_FRONTS) {
    // The input is left out: the core reads it for sensitive paths, which would blank the subject before it is ever looked for.
    push({ type: "tool-start", toolId: id, kind: name === "Bash" ? "shell" : "mcp", name, summary: command, input: "{}" });
    push({ type: "tool-end", toolId: id, ok: true, output: "" });
  }
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
    const shown = SECRET_FRONTS.map(([id]) => {
      const start = events.flatMap((e) => (e.kind.case === "activityStart" && e.kind.value.activity?.id === id ? [e.kind.value.activity] : []))[0];
      return [id, start?.tool, start?.subject];
    });
    expect(shown).toEqual(SECRET_FRONTS.map(([id, name, , subject]) => [id, name === "Bash" ? "Bash" : "mcp", subject]));
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
      // Case-blind: a subject is written in lower case.
      expect(text.toLowerCase()).not.toContain(MARK.toLowerCase());
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
    expect(Buffer.from(toBinary(OfficeSnapshotSchema, rebuilt.body.value)).toString("utf8").toLowerCase()).not.toContain(MARK.toLowerCase());

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

  it("after a restart (nothing said the AI's session since) an office still reads the subagents' records, by the thread's session", async () => {
    const asked: string[] = [];
    const base = officeProvider();
    const provider: AgentProvider = {
      ...base,
      history: {
        ...history,
        subagentActivity: async (sessionId) => {
          asked.push(sessionId);
          return { subagents: [], usage: [] };
        },
      },
    };
    const { core, work } = makeCore([provider]);
    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    await core.send(thread.id, "go", "c1");
    const items = await until(core, thread.id, (all) => byCase(all, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const ask = byCase(items, "approval")[0];
    if (!ask) throw new Error("no approval");
    core.respond(thread.id, ask.id, ask.revision, { decision: Decision.ALLOW }, "test");
    await until(core, thread.id, (all) => byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    // A hub of its own: its memory heard nothing, as after the agent restarted.
    const hub = new OfficeHub(core, { providers: [provider], pollMs: 10 });
    const release = hub.attach();
    hub.watch(thread.id, () => undefined);
    await wait(200);
    expect(asked).toContain("office-session-1");
    release();
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
    for (const b of all) expect(b.toString("utf8").toLowerCase()).not.toContain(MARK.toLowerCase());
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

  it("refuses an office past the limits, per connection and for the machine; watching again is never refused", async () => {
    const provider = officeProvider();
    const { core, work } = makeCore([provider]);
    const hub = new OfficeHub(core, { providers: [provider] });
    const threads: string[] = [];
    for (let i = 0; i < OFFICES_PER_MACHINE + 1; i++) threads.push((await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" })).id);
    const thread = (i: number): string => threads[i] ?? "";
    const sinks: OfficeSink[] = Array.from({ length: OFFICES_PER_MACHINE / WATCHES_PER_CONNECTION + 1 }, () => () => undefined);
    const [one, two, last] = [sinks[0], sinks[1], sinks.at(-1)];
    if (!one || !two || !last) throw new Error("no sinks");
    for (let i = 0; i < WATCHES_PER_CONNECTION; i++) hub.watch(thread(i), one);
    expect(() => hub.watch(thread(WATCHES_PER_CONNECTION), one)).toThrow(expect.objectContaining({ reason: ErrorReason.OFFICE_WATCH_LIMIT }));
    // Asking again for an office it watches (a fresh snapshot), and another connection watching the same office: fine.
    expect(hub.watch(thread(0), one).threadId).toBe(thread(0));
    expect(hub.watch(thread(0), two).threadId).toBe(thread(0));
    // Fill the machine; then one more office is refused even on a connection with room.
    let next = WATCHES_PER_CONNECTION;
    for (const sink of sinks.slice(1, -1)) {
      for (let i = sink === two ? 1 : 0; i < WATCHES_PER_CONNECTION; i++) hub.watch(thread(next++), sink);
    }
    hub.watch(thread(next), last);
    expect(hub.watched).toHaveLength(OFFICES_PER_MACHINE);
    expect(() => hub.watch(thread(OFFICES_PER_MACHINE), last)).toThrow(expect.objectContaining({ reason: ErrorReason.OFFICE_WATCH_LIMIT }));
    // An office already kept may still be watched by it.
    expect(hub.watch(thread(0), last).threadId).toBe(thread(0));
    // A connection closing makes room.
    hub.forget(one);
    hub.forget(two);
    expect(hub.watch(thread(OFFICES_PER_MACHINE), last).threadId).toBe(thread(OFFICES_PER_MACHINE));
    await core.stop();
  });

  it("the link answers an office past the limit with OFFICE_WATCH_LIMIT", async () => {
    const provider = officeProvider();
    const { core, work, audit } = makeCore([provider]);
    const config = new ConfigStore(join(tempDir(), "cfg"));
    const device = await pairedDevice({ core, config, audit, providers: [provider] });
    for (let i = 0; i <= WATCHES_PER_CONNECTION; i++) {
      const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
      const answer = await device.request(`w${i}`, { case: "officeWatch", value: { threadId: thread.id, on: true } });
      if (i < WATCHES_PER_CONNECTION) expect(answer.body.case).toBe("officeSnapshot");
      else expect(answer.body).toMatchObject({ case: "error", value: { reason: ErrorReason.OFFICE_WATCH_LIMIT } });
    }
    device.close();
    await core.stop();
  });

  it("drops the office of a deleted thread", async () => {
    const provider = officeProvider();
    const { core, work } = makeCore([provider]);
    const hub = new OfficeHub(core, { providers: [provider] });
    const release = hub.attach();
    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    hub.watch(thread.id, () => undefined);
    expect(hub.watched).toEqual([thread.id]);
    await core.deleteThread({ threadId: thread.id, stopRunning: false, openAnyway: false, device: "test" });
    expect(hub.watched).toEqual([]);
    release();
    await core.stop();
  });

  it("a poll whose thread list fails logs it and keeps the offices", async () => {
    const provider = officeProvider();
    const { core, work } = makeCore([provider]);
    const lines: string[] = [];
    const hub = new OfficeHub(core, { providers: [provider], pollMs: 10, log: (l) => lines.push(l) });
    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    const sink: OfficeSink = () => undefined;
    hub.watch(thread.id, sink);
    const list = core.list.bind(core);
    core.list = () => {
      throw new TypeError(`broken ${MARK}`);
    };
    await wait(60);
    core.list = list;
    expect(lines).toEqual(["office: list threads failed: TypeError"]);
    expect(hub.watched).toEqual([thread.id]);
    hub.unwatch(thread.id, sink);
    await core.stop();
  });

  it("logs what goes wrong in the office, by place and kind only, and keeps the core going", async () => {
    const provider = officeProvider();
    const { core, work } = makeCore([provider]);
    const lines: string[] = [];
    const hub = new OfficeHub(core, { providers: [provider], flushMs: 5, log: (l) => lines.push(l) });
    const release = hub.attach();
    const thread = await core.create({ provider: "office-ai", model: "", dir: work, text: "", consent, device: "test" });
    hub.watch(thread.id, () => {
      throw new Error(`device gone ${MARK}`);
    });
    await core.send(thread.id, "go", "c1");
    const items = await until(core, thread.id, (all) => byCase(all, "approval").some((a) => a.body.value.state === PromptState.PENDING));
    const ask = byCase(items, "approval")[0];
    if (!ask) throw new Error("no approval");
    core.respond(thread.id, ask.id, ask.revision, { decision: Decision.ALLOW }, "test");
    await until(core, thread.id, (all) => byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    await wait(50);
    // One line for many failed sends (at most one a minute), without the error's message.
    expect(lines).toEqual(["office: send events failed: Error"]);
    release();
    await core.stop();
  });
});

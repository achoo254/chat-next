// The office of one session (docs/office-wire.md): consecutive seq, rooms,
// subjects, staff coming and going, prompts on the right person, counts only,
// and a snapshot plus the events after it giving the tracker's own state.
import { clone, create, toBinary } from "@bufbuild/protobuf";
import {
  OfficeActorSchema,
  OfficeActorState,
  OfficeAnimGroup,
  OfficeApprovalState,
  type OfficeEvent,
  OfficeEventSchema,
  OfficeRole,
  OfficeResidentSchema,
  OfficeRoom,
  OfficeServiceKind,
  OfficeServiceSchema,
  type OfficeState,
  OfficeStateSchema,
} from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { MAX_RESIDENTS } from "../src/office/office-residents.ts";
import { BACKGROUND_SILENT_MS, LEAVE_AFTER_IDLE_MS, MAX_ACTORS, OfficeTracker, type ToolStart } from "../src/office/office-tracker.ts";

const busy = { busy: true, waitingForUser: false, backgroundTasks: 0 };
const idle = { busy: false, waitingForUser: false, backgroundTasks: 0 };
const shell = (toolId: string, command: string, extra: Partial<ToolStart> = {}): ToolStart => ({
  toolId,
  name: "Bash",
  kind: "shell",
  summary: command,
  sensitive: false,
  background: false,
  ...extra,
});

/** What a device does with an event (docs/office-wire.md, part 3). */
function apply(state: OfficeState, ev: OfficeEvent, before: Map<string, OfficeActorState>): void {
  const k = ev.kind;
  const actor = (id: string) => state.actors.find((a) => a.id === id);
  switch (k.case) {
    case "actorEnter":
      state.actors.push(clone(OfficeActorSchema, k.value));
      return;
    case "actorUpdate": {
      const i = state.actors.findIndex((a) => a.id === k.value.id);
      if (i >= 0) state.actors[i] = clone(OfficeActorSchema, k.value);
      return;
    }
    case "actorLeave": {
      // An employee leaving stays known as a resident (the snapshot's list: the last MAX_RESIDENTS, by entry).
      const gone = actor(k.value.actorId);
      state.actors = state.actors.filter((a) => a.id !== k.value.actorId);
      if (gone?.role !== OfficeRole.EMPLOYEE) return;
      const { id, agentType, parentId, spawnDepth, enteredAt, doneAt } = gone;
      const kept = [...state.residents.filter((r) => r.id !== id), create(OfficeResidentSchema, { id, agentType, parentId, spawnDepth, enteredAt, doneAt, leftAt: ev.at })];
      state.residents = kept.slice(-MAX_RESIDENTS).sort((a, b) => Number(a.enteredAt - b.enteredAt) || (a.id < b.id ? -1 : 1));
      return;
    }
    case "activityStart": {
      const a = actor(k.value.actorId);
      if (a && k.value.activity) a.activity = k.value.activity;
      return;
    }
    case "activityEnd": {
      const a = actor(k.value.actorId);
      if (a?.activity?.id === k.value.activityId) a.activity = undefined;
      return;
    }
    case "approval": {
      const a = actor(k.value.actorId);
      if (!a) return;
      if (k.value.state === OfficeApprovalState.WAITING) {
        if (a.state !== OfficeActorState.AWAITING_APPROVAL) before.set(a.id, a.state);
        a.state = OfficeActorState.AWAITING_APPROVAL;
      } else a.state = before.get(a.id) ?? a.state;
      return;
    }
    case "session":
      state.session = k.value;
      return;
    default:
      return;
  }
}

/** Plays `events` over `from` and checks the result against the tracker's own snapshot. */
function expectReplay(t: OfficeTracker, from: OfficeState, events: OfficeEvent[]): void {
  const state = clone(OfficeStateSchema, from);
  const before = new Map<string, OfficeActorState>();
  for (const ev of events) apply(state, ev, before);
  expect(state).toEqual(t.snapshot());
}

const kinds = (events: OfficeEvent[]) => events.map((e) => e.kind.case);

describe("office tracker", () => {
  it("numbers events one after another across drains", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    const a = t.drain();
    t.toolStart(shell("t1", "ls"), 2);
    t.toolEnd("t1", true, 3);
    const b = t.drain();
    const seqs = [...a, ...b].map((e) => Number(e.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(t.seq).toBe(seqs.length);
    expect(t.drain()).toEqual([]);
  });

  it("starts a turn on each idle-to-busy edge, and the director thinks while nothing runs", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 10);
    t.setStatus(busy, 11);
    t.setStatus(idle, 20);
    t.setStatus(busy, 30);
    const ev = t.drain();
    expect(kinds(ev).filter((k) => k === "turnStart")).toHaveLength(2);
    const director = t.snapshot().actors[0];
    expect(director?.role).toBe(OfficeRole.DIRECTOR);
    expect(director?.state).toBe(OfficeActorState.WORKING);
    expect(director?.activity).toMatchObject({ id: "think", group: OfficeAnimGroup.THINK, room: OfficeRoom.DIRECTOR });
    expect(t.snapshot().session?.startedAt).toBe(10n);
  });

  it("puts the director's tools in their rooms with a short subject", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.toolStart(shell("t1", "FOO=1 git push origin secret-branch"), 2);
    let d = t.snapshot().actors[0];
    expect(d?.activity).toMatchObject({ id: "t1", tool: "Bash", group: OfficeAnimGroup.MACHINE, room: OfficeRoom.POST, subject: "git" });
    t.toolEnd("t1", true, 3);
    t.toolStart({ toolId: "t2", name: "Read", kind: "read", summary: "src/deep/folder/file.ts", sensitive: false, background: false }, 4);
    d = t.snapshot().actors[0];
    expect(d?.activity).toMatchObject({ room: OfficeRoom.LIBRARY, subject: "file.ts" });
    t.toolStart({ toolId: "t3", name: "Read", kind: "read", summary: ".ssh/id_rsa", sensitive: true, background: false }, 5);
    expect(t.snapshot().actors[0]?.activity?.subject).toBe("");
  });

  it("shows the newest of parallel tools, and the one still open when it ends", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    const from = t.snapshot();
    t.drain();
    t.toolStart({ toolId: "a", name: "Read", kind: "read", summary: "a.ts", sensitive: false, background: false }, 2);
    t.toolStart({ toolId: "b", name: "Read", kind: "read", summary: "b.ts", sensitive: false, background: false }, 3);
    t.toolEnd("b", true, 4);
    expect(t.snapshot().actors[0]?.activity?.id).toBe("a");
    t.toolEnd("a", true, 5);
    expect(t.snapshot().actors[0]?.activity?.id).toBe("think");
    expectReplay(t, from, t.drain());
  });

  it("closes every open activity when the session goes idle", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.toolStart(shell("t1", "sleep 100"), 2);
    t.subagentStart({ toolId: "s1", agentType: "scout", description: "Find files", background: false }, 3);
    t.toolStart({ ...shell("s1-a", "ls"), actorId: "s1" }, 4);
    t.setStatus(idle, 5);
    const s = t.snapshot();
    expect(s.actors[0]).toMatchObject({ state: OfficeActorState.IDLE });
    expect(s.actors[0]?.activity).toBeUndefined();
    expect(s.actors[1]).toMatchObject({ id: "s1", state: OfficeActorState.DONE, doneAt: 5n });
    expect(s.actors[1]?.activity).toMatchObject({ id: "hand-in", group: OfficeAnimGroup.HAND_IN, room: OfficeRoom.DIRECTOR });
    // A late result of a closed call changes nothing.
    t.toolEnd("t1", true, 6);
    expect(t.snapshot()).toEqual(s);
  });

  it("brings staff in through the lobby, gives them only tool names, and lets them go after 10 idle minutes", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    const from = t.snapshot();
    t.drain();
    t.subagentStart({ toolId: "s1", agentType: "code-reviewer", description: "Review the diff", background: false }, 2);
    let e = t.snapshot().actors[1];
    expect(e).toMatchObject({ role: OfficeRole.EMPLOYEE, agentType: "code-reviewer", description: "Review the diff", spawnDepth: 1, state: OfficeActorState.WORKING });
    expect(e?.activity).toMatchObject({ id: "arrive", group: OfficeAnimGroup.ARRIVE, room: OfficeRoom.LOBBY });
    t.toolStart({ toolId: "s1-t", actorId: "s1", name: "Bash", kind: "shell", summary: "", command: "pnpm test --filter secret", sensitive: false, background: false }, 3);
    e = t.snapshot().actors[1];
    expect(e?.activity).toMatchObject({ tool: "Bash", room: OfficeRoom.QA, subject: "" });
    t.toolEnd("s1-t", false, 4);
    t.subagentDone("s1", 5);
    t.setStatus(idle, 6);
    expect(t.snapshot().session?.tasksDone).toBe(1);
    expect(t.snapshot().session?.checks).toMatchObject({ passed: 0, failed: 1, lastOk: false });
    t.tick(6 + LEAVE_AFTER_IDLE_MS - 1);
    expect(t.snapshot().actors).toHaveLength(2);
    t.tick(6 + LEAVE_AFTER_IDLE_MS);
    expect(t.snapshot().actors.map((a) => a.id)).toEqual(["director"]);
    expectReplay(t, from, t.drain());
  });

  it("nests a subagent's subagent under it, with no description", () => {
    const t = new OfficeTracker(true, 0);
    t.subagentStart({ toolId: "s1", agentType: "planner", description: "Plan", background: false }, 1);
    t.subagentStart({ toolId: "s2", parentId: "s1", agentType: "scout", description: "secret task", background: false }, 2);
    t.subagentStart({ toolId: "w1", workflowId: "wf_1", agentType: "tester", description: "x", background: false, spawnDepth: 1 }, 3);
    const [, s1, s2, w1] = t.snapshot().actors;
    expect(s1).toMatchObject({ parentId: "", spawnDepth: 1, description: "Plan" });
    expect(s2).toMatchObject({ parentId: "s1", spawnDepth: 2, description: "" });
    expect(w1).toMatchObject({ parentId: "workflow:wf_1", description: "" });
  });

  it("keeps a subagent in the background working until its work ends", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "researcher", description: "Read docs", background: true }, 2);
    // Its tool call answers at once: that is its launch, not its end.
    t.subagentDone("bg", 3);
    t.setStatus(idle, 4);
    expect(t.snapshot().actors[1]?.state).toBe(OfficeActorState.WORKING);
    t.backgroundEnded("bg", true, 5);
    expect(t.snapshot().actors[1]?.state).toBe(OfficeActorState.DONE);
  });

  it("makes a shell in the background a machine, which leaves when its work ends or none is left", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    const from = t.snapshot();
    t.drain();
    t.toolStart(shell("m1", "pnpm test", { background: true }), 2);
    t.toolStart(shell("m2", "npm run dev", { background: true }), 3);
    t.toolEnd("m1", true, 4);
    let s = t.snapshot();
    expect(s.actors.filter((a) => a.role === OfficeRole.MACHINE).map((a) => [a.id, a.agentType, a.activity?.room])).toEqual([
      ["m1", "Bash", OfficeRoom.QA],
      ["m2", "Bash", OfficeRoom.SERVER],
    ]);
    t.backgroundEnded("m1", true, 5);
    s = t.snapshot();
    expect(s.actors.map((a) => a.id)).toEqual(["director", "m2"]);
    expect(s.session?.checks).toMatchObject({ passed: 1, failed: 0, lastOk: true });
    t.setStatus({ ...busy, backgroundTasks: 1 }, 6);
    t.setStatus({ ...busy, backgroundTasks: 0 }, 7);
    expect(t.snapshot().actors.map((a) => a.id)).toEqual(["director"]);
    expectReplay(t, from, t.drain());
  });

  it("puts a prompt on the actor whose tool waits, back on answer, and on the director when it cannot tell", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "s1", agentType: "tester", description: "Test", background: false }, 2);
    t.toolStart({ ...shell("s1-t", "rm -rf build"), actorId: "s1" }, 3);
    const from = t.snapshot();
    t.drain();
    t.prompt("ask:s1-t", "s1-t", "waiting", 4);
    expect(t.snapshot().actors[1]?.state).toBe(OfficeActorState.AWAITING_APPROVAL);
    t.prompt("ask:s1-t", "s1-t", "denied", 5);
    expect(t.snapshot().actors[1]?.state).toBe(OfficeActorState.WORKING);
    t.prompt("outside", "", "waiting", 6);
    expect(t.snapshot().actors[0]?.state).toBe(OfficeActorState.AWAITING_APPROVAL);
    t.prompt("outside", "", "waiting", 7);
    t.prompt("outside", "", "cancelled", 8);
    t.prompt("outside", "", "cancelled", 9);
    expect(t.snapshot().actors[0]?.state).toBe(OfficeActorState.WORKING);
    const ev = t.drain();
    const approvals = ev.flatMap((e) => (e.kind.case === "approval" ? [[e.kind.value.actorId, e.kind.value.state]] : []));
    expect(approvals).toEqual([
      ["s1", OfficeApprovalState.WAITING],
      ["s1", OfficeApprovalState.DENIED],
      ["director", OfficeApprovalState.WAITING],
      ["director", OfficeApprovalState.CANCELLED],
    ]);
    expectReplay(t, from, ev);
  });

  it("counts todo entries and test runs, never their text", () => {
    const t = new OfficeTracker(true, 0);
    t.setTodo({ pending: 2, inProgress: 1, done: 3 }, 1);
    t.setStatus(busy, 2);
    t.toolStart(shell("q1", "pnpm lint"), 3);
    t.toolEnd("q1", true, 4);
    t.toolStart(shell("q2", "ls"), 5);
    t.toolEnd("q2", false, 6);
    const s = t.snapshot().session;
    expect(s?.todo).toMatchObject({ pending: 2, inProgress: 1, done: 3 });
    expect(s?.tasksDone).toBe(3);
    expect(s?.checks).toMatchObject({ passed: 1, failed: 0, lastOk: true });
  });

  it("sends the session's numbers only when one changed", () => {
    const t = new OfficeTracker(true, 0);
    t.setTodo({ pending: 1, inProgress: 0, done: 0 }, 1);
    t.setTodo({ pending: 1, inProgress: 0, done: 0 }, 2);
    t.setUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0, hasCost: false, available: true }, 3);
    t.setUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0, hasCost: false, available: true }, 4);
    expect(kinds(t.drain())).toEqual(["session", "session"]);
  });

  it("keeps at most MAX_ACTORS and counts the rest", () => {
    const t = new OfficeTracker(true, 0);
    for (let i = 0; i < MAX_ACTORS + 5; i++) t.subagentStart({ toolId: `s${i}`, agentType: "scout", description: "", background: false }, i);
    const s = t.snapshot();
    expect(s.actors).toHaveLength(MAX_ACTORS);
    expect(s.session?.hiddenActors).toBe(6);
    t.subagentDone(`s${MAX_ACTORS + 4}`, 100);
    expect(t.snapshot().session).toMatchObject({ hiddenActors: 5, tasksDone: 1 });
  });

  it("a machine over the limit that ends is not counted as a subagent's work handed in", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus({ ...busy, backgroundTasks: 1 }, 1);
    for (let i = 0; i < MAX_ACTORS - 1; i++) t.subagentStart({ toolId: `s${i}`, agentType: "scout", description: "", background: false }, 2);
    t.toolStart(shell("m", "npm run dev", { background: true }), 3);
    expect(t.snapshot().session).toMatchObject({ hiddenActors: 1, tasksDone: 0 });
    t.backgroundEnded("m", true, 4);
    expect(t.snapshot().session).toMatchObject({ hiddenActors: 0, tasksDone: 0 });
  });

  it("fewer background tasks also send hidden machines away", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus({ ...busy, backgroundTasks: 2 }, 1);
    for (let i = 0; i < MAX_ACTORS - 1; i++) t.subagentStart({ toolId: `s${i}`, agentType: "scout", description: "", background: false }, 2);
    t.toolStart(shell("m1", "npm run dev", { background: true }), 3);
    t.toolStart(shell("m2", "npm run worker", { background: true }), 4);
    expect(t.snapshot().session?.hiddenActors).toBe(2);
    t.setStatus({ ...busy, backgroundTasks: 0 }, 5);
    expect(t.snapshot().session).toMatchObject({ hiddenActors: 0, tasksDone: 0 });
  });

  it("an MCP call's tool is sent as \"mcp\", never with its server's name", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.toolStart({ toolId: "c1", name: "mcp__private-server__create_issue", kind: "mcp", summary: "", sensitive: false, background: false }, 2);
    t.subagentStart({ toolId: "s", agentType: "scout", description: "", background: false }, 3);
    t.toolStart({ toolId: "c2", actorId: "s", name: "mcp__private-server__list", kind: "mcp", summary: "", sensitive: false, background: false }, 4);
    const activities = t.snapshot().actors.map((a) => [a.id, a.activity?.tool, a.activity?.subject, a.activity?.room]);
    expect(activities).toEqual([
      ["director", "mcp", "create_issue", OfficeRoom.POST],
      ["s", "mcp", "", OfficeRoom.POST],
    ]);
    expect(JSON.stringify(t.drain().map((e) => e.kind.value), (_k, v: unknown) => (typeof v === "bigint" ? Number(v) : v))).not.toContain("private-server");
  });

  it("never brings staff in for an AI that does not report them", () => {
    const t = new OfficeTracker(false, 0);
    t.subagentStart({ toolId: "s1", agentType: "scout", description: "", background: false }, 1);
    const s = t.snapshot();
    expect(s.reportsStaff).toBe(false);
    expect(s.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR]);
  });

  it("starts a tool call seen twice (live, then from a record) once", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.toolStart(shell("x", "ls"), 2);
    t.drain();
    t.toolStart(shell("x", "ls"), 3);
    expect(t.drain()).toEqual([]);
  });

  it("a snapshot taken any time, plus the events after it, gives the same state", () => {
    const script: ((t: OfficeTracker, at: number) => void)[] = [
      (t, at) => t.setStatus(busy, at),
      (t, at) => t.toolStart(shell("a", "git status"), at),
      (t, at) => t.subagentStart({ toolId: "s", agentType: "scout", description: "Look", background: false }, at),
      (t, at) => t.toolStart({ ...shell("s-a", "grep x"), actorId: "s" }, at),
      (t, at) => t.prompt("p", "s-a", "waiting", at),
      (t, at) => t.toolEnd("a", true, at),
      (t, at) => t.prompt("p", "s-a", "allowed", at),
      (t, at) => t.toolEnd("s-a", true, at),
      (t, at) => t.toolStart(shell("m", "tail -f log", { background: true }), at),
      (t, at) => t.subagentDone("s", at),
      (t, at) => t.setTodo({ pending: 0, inProgress: 0, done: 2 }, at),
      (t, at) => t.setStatus({ ...idle, backgroundTasks: 1 }, at),
      (t, at) => t.setStatus(idle, at),
    ];
    for (let cut = 0; cut <= script.length; cut++) {
      const t = new OfficeTracker(true, 0);
      script.slice(0, cut).forEach((step, i) => step(t, i + 1));
      const from = t.snapshot();
      t.drain();
      script.slice(cut).forEach((step, i) => step(t, cut + i + 1));
      expectReplay(t, from, t.drain());
    }
  });
});

it("an actor's wire shape has no field for input, output or command text", () => {
  const fields = OfficeActorSchema.fields.map((f) => f.name).sort();
  expect(fields).toEqual(["activity", "agent_type", "description", "done_at", "entered_at", "id", "parent_id", "role", "service", "spawn_depth", "state"].sort());
  expect(create(OfficeActorSchema).activity).toBeUndefined();
  // A machine's label is an enum, a number and a time: nothing to put a command in.
  expect(OfficeServiceSchema.fields.map((f) => [f.name, f.fieldKind, f.fieldKind === "scalar" ? f.scalar : f.fieldKind === "enum" ? f.enum.typeName : ""])).toEqual([
    ["kind", "enum", "remote.v1.OfficeServiceKind"],
    ["port", "scalar", 13],
    ["started_at", "scalar", 3],
  ]);
  expect(OfficeResidentSchema.fields.map((f) => f.name).sort()).toEqual(["agent_type", "done_at", "entered_at", "id", "left_at", "parent_id", "spawn_depth"].sort());
});

describe("residents and machine labels", () => {
  it("keeps employees that left in the snapshot, in the order they came in, at most MAX_RESIDENTS", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "s2", agentType: "tester", description: "Test", background: false }, 3);
    t.subagentStart({ toolId: "s1", parentId: "s2", agentType: "scout", description: "Look", background: false }, 2);
    t.subagentDone("s2", 4);
    t.setStatus(idle, 5);
    expect(t.snapshot().residents).toEqual([]);
    t.tick(5 + LEAVE_AFTER_IDLE_MS);
    const residents = t.snapshot().residents.map((r) => [r.id, r.agentType, r.parentId, r.spawnDepth, r.enteredAt, r.doneAt, r.leftAt]);
    expect(residents).toEqual([
      ["s1", "scout", "s2", 2, 2n, 5n, BigInt(5 + LEAVE_AFTER_IDLE_MS)],
      ["s2", "tester", "", 1, 3n, 4n, BigInt(5 + LEAVE_AFTER_IDLE_MS)],
    ]);
    // Machines are not residents.
    t.setStatus(busy, 10 + LEAVE_AFTER_IDLE_MS);
    t.toolStart(shell("m", "pnpm dev", { background: true }), 11 + LEAVE_AFTER_IDLE_MS);
    t.backgroundEnded("m", true, 12 + LEAVE_AFTER_IDLE_MS);
    expect(t.snapshot().residents.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("forgets the first to leave past MAX_RESIDENTS", () => {
    const t = new OfficeTracker(true, 0);
    for (let i = 0; i < MAX_RESIDENTS + 3; i++) {
      const at = i * 2 * LEAVE_AFTER_IDLE_MS + 1;
      t.setStatus(busy, at);
      t.subagentStart({ toolId: `s${i}`, agentType: "scout", description: "", background: false }, at + 1);
      t.setStatus(idle, at + 2);
      t.tick(at + 2 + LEAVE_AFTER_IDLE_MS);
    }
    const ids = t.snapshot().residents.map((r) => r.id);
    expect(ids).toHaveLength(MAX_RESIDENTS);
    expect(ids[0]).toBe("s3");
    expect(ids.at(-1)).toBe(`s${MAX_RESIDENTS + 2}`);
  });

  it("labels a machine with the kind of its command, a port it was given and its start, and never sends the command", () => {
    const MARK = "ZZMARKER-5f1d-private";
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    const from = t.snapshot();
    t.drain();
    t.toolStart(shell("m1", `cd /work/${MARK} && API_KEY=${MARK} pnpm --filter web dev --port 5173`, { background: true }), 2);
    t.toolStart(shell("m2", `gh run watch 12345 --repo ${MARK}/x`, { background: true }), 3);
    t.toolStart({ ...shell("m3", "", { background: true }), summary: `node ./${MARK}.js` }, 4);
    const events = t.drain();
    const machines = t.snapshot().actors.filter((a) => a.role === OfficeRole.MACHINE);
    expect(machines.map((a) => [a.id, a.service?.kind, a.service?.port, a.service?.startedAt])).toEqual([
      ["m1", OfficeServiceKind.DEV_SERVER, 5173, 2n],
      ["m2", OfficeServiceKind.CI_WATCH, 0, 3n],
      ["m3", OfficeServiceKind.SCRIPT, 0, 4n],
    ]);
    // The director and employees carry no label.
    expect(t.snapshot().actors[0]?.service).toBeUndefined();
    const wire = JSON.stringify([toBinary(OfficeStateSchema, t.snapshot()), ...events.map((e) => toBinary(OfficeEventSchema, e))].map((b) => Buffer.from(b).toString("latin1")));
    expect(wire).not.toContain(MARK);
    expectReplay(t, from, events);
  });
});

describe("subagents in the background", () => {
  const stateOf = (t: OfficeTracker, id: string): OfficeActorState | undefined => t.snapshot().actors.find((a) => a.id === id)?.state;

  it("are not done when no background work is counted while they still run", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "fullstack-developer", description: "Build", background: true }, 2);
    t.subagentDone("bg", 3);
    // The count of background work reaches 0 (it may miss subagents) once the turn is over.
    t.setStatus({ ...idle, backgroundTasks: 1 }, 4);
    t.setStatus(idle, 5);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.WORKING);
    t.backgroundEnded("bg", true, 6);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.DONE);
  });

  it("keep everyone in while one still runs, however long the session is idle", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "fullstack-developer", description: "Build", background: true }, 2);
    t.subagentStart({ toolId: "fg", agentType: "scout", description: "Look", background: false }, 2);
    t.setStatus(idle, 3);
    // It keeps working (a tool call of its own every few minutes).
    for (let at = 3; at < 3 * LEAVE_AFTER_IDLE_MS; at += 5 * 60_000) {
      t.toolStart({ ...shell(`bg-${at}`, "ls"), actorId: "bg" }, at);
      t.toolEnd(`bg-${at}`, true, at + 1);
      t.tick(at + 2);
    }
    expect(t.snapshot().actors.map((a) => a.id)).toEqual(["director", "bg", "fg"]);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.WORKING);
  });

  it("works again when its tool call answered before it was known to run in the background", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "", description: "Build", background: false }, 2);
    // "Async agent launched": the answer comes first, then the AI's record says it runs in the background.
    t.subagentDone("bg", 3);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.DONE);
    expect(t.snapshot().session?.tasksDone).toBe(1);
    t.subagentStart({ toolId: "bg", agentType: "fullstack-developer", description: "", background: true }, 4);
    expect(t.snapshot().actors.find((a) => a.id === "bg")).toMatchObject({ state: OfficeActorState.WORKING, doneAt: 0n, agentType: "fullstack-developer" });
    expect(t.snapshot().session?.tasksDone).toBe(0);
    t.setStatus(idle, 5);
    t.tick(5 + LEAVE_AFTER_IDLE_MS);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.WORKING);
    // Done for good once its background work ends: a later record does not bring it back.
    t.backgroundEnded("bg", true, 6);
    t.subagentStart({ toolId: "bg", agentType: "fullstack-developer", description: "", background: true }, 7);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.DONE);
  });

  it("is done after BACKGROUND_SILENT_MS silent with no background work counted, and goes home later", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "researcher", description: "Read", background: true }, 2);
    t.setStatus(idle, 3);
    t.tick(2 + BACKGROUND_SILENT_MS - 1);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.WORKING);
    t.tick(2 + BACKGROUND_SILENT_MS);
    expect(stateOf(t, "bg")).toBe(OfficeActorState.DONE);
    expect(t.snapshot().actors.map((a) => a.id)).toContain("bg");
    t.tick(2 + BACKGROUND_SILENT_MS + LEAVE_AFTER_IDLE_MS);
    expect(t.snapshot().actors.map((a) => a.id)).toEqual(["director"]);
  });
});

describe("subagents in the background: presumed and final ends", () => {
  const actorOf = (t: OfficeTracker, id: string) => t.snapshot().actors.find((a) => a.id === id);

  it("a tool of its own still open keeps it at work past BACKGROUND_SILENT_MS", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "tester", description: "", background: true }, 2);
    t.toolStart({ ...shell("bg-long", "pnpm test"), actorId: "bg" }, 3);
    t.setStatus(idle, 4);
    t.tick(4 + 2 * BACKGROUND_SILENT_MS);
    expect(actorOf(t, "bg")?.state).toBe(OfficeActorState.WORKING);
  });

  it("presumed done for its silence, a tool call of its own brings it back to work", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "tester", description: "", background: true }, 2);
    t.setStatus(idle, 3);
    t.tick(2 + BACKGROUND_SILENT_MS);
    expect(actorOf(t, "bg")?.state).toBe(OfficeActorState.DONE);
    const from = t.snapshot();
    t.drain();
    t.toolStart({ ...shell("bg-next", "ls"), actorId: "bg" }, 3 + BACKGROUND_SILENT_MS);
    expect(actorOf(t, "bg")).toMatchObject({ state: OfficeActorState.WORKING, doneAt: 0n });
    expect(actorOf(t, "bg")?.activity?.id).toBe("bg-next");
    const events = t.drain();
    // Devices never hear of an activity ending that they were not told it showed.
    expect(events.filter((e) => e.kind.case === "activityEnd")).toEqual([]);
    expectReplay(t, from, events);
  });

  it("finished by its record when already done: keeps its time and hand-in, no work again, and stays done", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "", description: "", background: false }, 2);
    t.setStatus(idle, 5);
    expect(actorOf(t, "bg")).toMatchObject({ state: OfficeActorState.DONE, doneAt: 5n });
    t.drain();
    // Its record, read later: it ran in the background and finished.
    t.subagentStart({ toolId: "bg", agentType: "tester", description: "", background: false }, 100);
    t.subagentDone("bg", 100, true, { doneAt: 4 });
    expect(actorOf(t, "bg")).toMatchObject({ state: OfficeActorState.DONE, doneAt: 5n, agentType: "tester" });
    expect(t.drain().filter((e) => e.kind.case === "actorUpdate" && e.kind.value.state === OfficeActorState.WORKING)).toEqual([]);
    // Final now: a later word that it runs in the background does not bring it back.
    t.subagentStart({ toolId: "bg", agentType: "tester", description: "", background: true }, 101);
    expect(actorOf(t, "bg")?.state).toBe(OfficeActorState.DONE);
  });

  it("finished by its record while still at work: done at its record's last write", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.subagentStart({ toolId: "bg", agentType: "tester", description: "", background: true }, 2);
    t.subagentDone("bg", 100, true, { doneAt: 40 });
    expect(actorOf(t, "bg")).toMatchObject({ state: OfficeActorState.DONE, doneAt: 40n });
  });
});

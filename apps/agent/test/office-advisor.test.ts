// Advisor in the office (docs/office-wire.md): advisor_weigh under either
// name is a visit to Advisor's seat; Advisor sits in while the session's
// automatic Advisor is on, listens while it is asked and says its latest
// answer ("<option> · 72%"), all of it rebuilt from the journal; and only a
// device that draws Advisor hears of it (any other gets the same seq with
// the events about Advisor emptied, and a snapshot without it).
import { type MessageInitShape, clone, create } from "@bufbuild/protobuf";
import {
  type Item,
  ItemSchema,
  type OfficeActivity,
  type OfficeActor,
  OfficeActorSchema,
  OfficeActorState,
  OfficeAnimGroup,
  type OfficeEvent,
  type OfficeEvents,
  OfficeRole,
  OfficeRoom,
  type OfficeState,
  OfficeStateSchema,
  ThreadState,
  ThreadSummarySchema,
  ToolKind as WireToolKind,
  TurnState,
} from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { classifyActivity } from "../src/office/office-activity-map.ts";
import { OfficeHub } from "../src/office/office-hub.ts";
import { OfficeMemory, OfficeThread, advisorSays } from "../src/office/office-thread.ts";
import { LEAVE_AFTER_IDLE_MS, MAX_ACTORS, OfficeTracker, type ToolStart } from "../src/office/office-tracker.ts";
import { toolKind } from "../src/providers/claude/tool-map.ts";
import type { AgentProvider, ProviderEvent, ProviderSession } from "../src/providers/types.ts";
import { Channel } from "../src/util/channel.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, until } from "./harness.ts";

const CLAUDE_WEIGH = "mcp__tunelo__advisor_weigh";
const AGY_WEIGH = "mcp_tunelo_advisor_weigh";
const busy = { busy: true, waitingForUser: false, backgroundTasks: 0 };
const idle = { busy: false, waitingForUser: false, backgroundTasks: 0 };
const consent = { sensitive: false, projectSettings: false };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const weigh = (toolId: string, name = CLAUDE_WEIGH): ToolStart => ({ toolId, name, kind: name === CLAUDE_WEIGH ? "mcp" : "other", summary: "advisor_weigh", sensitive: false, background: false });
const advisorOf = (s: OfficeState): OfficeActor | undefined => s.actors.find((a) => a.role === OfficeRole.ADVISOR);
const place = (a: OfficeActivity | undefined) => (a ? { id: a.id, group: a.group, room: a.room } : undefined);

/** What a device does with an event (docs/office-wire.md, part 3), enough for Advisor's part. */
function apply(state: OfficeState, ev: OfficeEvent): void {
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
    case "actorLeave":
      state.actors = state.actors.filter((a) => a.id !== k.value.actorId);
      return;
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
    case "session":
      state.session = k.value;
      return;
    default:
      return;
  }
}

function expectReplay(t: OfficeTracker, from: OfficeState, events: OfficeEvent[]): void {
  const state = clone(OfficeStateSchema, from);
  for (const ev of events) apply(state, ev);
  expect(state).toEqual(t.snapshot());
}

describe("asking Advisor is a visit to its seat", () => {
  it("advisor_weigh under Claude's and agy's names, whatever kind the AI gave it", () => {
    const consult = { group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING };
    expect(classifyActivity({ kind: toolKind(CLAUDE_WEIGH), name: CLAUDE_WEIGH })).toEqual(consult);
    expect(classifyActivity({ kind: "other", name: AGY_WEIGH })).toEqual(consult);
    expect(classifyActivity({ kind: "mcp", name: AGY_WEIGH })).toEqual(consult);
    // Another tool of tunelo's MCP stays in the lobby.
    expect(classifyActivity({ kind: "mcp", name: "mcp__tunelo__chat_send" })).toEqual({ group: OfficeAnimGroup.TYPE, room: OfficeRoom.LOBBY });
  });
});

describe("what Advisor says", () => {
  it("its likeliest option and how likely", () => {
    expect(advisorSays({ error: "", options: [{ text: "Merge", probability: 0.25 }, { text: "Rebase onto main", probability: 0.724 }] })).toBe("Rebase onto main · 72%");
  });

  it("nothing when it did not answer", () => {
    expect(advisorSays({ error: "timeout", options: [{ text: "Rebase", probability: 0 }] })).toBe("");
    expect(advisorSays({ error: "", options: [] })).toBe("");
    expect(advisorSays({ error: "", options: [{ text: " \n\t ", probability: 1 }] })).toBe("");
  });

  it("one line of at most 80 characters, the percent kept", () => {
    const says = advisorSays({ error: "", options: [{ text: `Run\nthe ${"very ".repeat(30)}long plan`, probability: 1 }] });
    expect([...says].length).toBe(80);
    expect(says).toMatch(/^Run the very .*… · 100%$/);
    expect(says).not.toContain("\n");
  });
});

describe("Advisor in the tracker", () => {
  it("sits in while on, listens while asked, says its answer, and the events replay to the snapshot", () => {
    const t = new OfficeTracker(true, 0);
    t.drain();
    const from = t.snapshot();
    t.setAdvisor(true, 1);
    t.setStatus(busy, 2);
    t.toolStart(weigh("w1"), 3);
    let s = t.snapshot();
    expect(place(s.actors[0]?.activity)).toEqual({ id: "w1", group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING });
    expect(advisorOf(s)).toMatchObject({ id: "advisor", state: OfficeActorState.IDLE, description: "" });
    expect(place(advisorOf(s)?.activity)).toEqual({ id: "w1", group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING });
    t.toolEnd("w1", true, 4);
    t.advisorAnswered("Rebase · 90%", 4);
    s = t.snapshot();
    expect(advisorOf(s)?.activity).toBeUndefined();
    expect(advisorOf(s)?.description).toBe("Rebase · 90%");
    t.setStatus(idle, 5);
    expectReplay(t, from, t.drain());
  });

  it("stays while the session rests and leaves when turned off, never as a resident", () => {
    const t = new OfficeTracker(true, 0);
    t.setAdvisor(true, 1);
    t.tick(1 + LEAVE_AFTER_IDLE_MS * 3);
    expect(advisorOf(t.snapshot())).toBeDefined();
    t.drain();
    t.setAdvisor(true, 2);
    expect(t.drain()).toEqual([]);
    t.setAdvisor(false, 3);
    expect(t.drain().map((e) => e.kind.case)).toEqual(["actorLeave"]);
    expect(advisorOf(t.snapshot())).toBeUndefined();
    expect(t.snapshot().residents).toEqual([]);
  });

  it("says its last answer again when it comes back", () => {
    const t = new OfficeTracker(true, 0);
    t.advisorAnswered("Merge · 61%", 1);
    t.setAdvisor(true, 2);
    expect(advisorOf(t.snapshot())?.description).toBe("Merge · 61%");
  });

  it("a call nobody answered before the turn ended: Advisor stops listening with the turn", () => {
    const t = new OfficeTracker(true, 0);
    t.setAdvisor(true, 1);
    t.setStatus(busy, 2);
    t.toolStart(weigh("w1", AGY_WEIGH), 3);
    t.setStatus(idle, 4);
    expect(advisorOf(t.snapshot())?.activity).toBeUndefined();
  });

  it("asked twice at once, listens until the last call ends; the askers' calls are not cut when it leaves", () => {
    const t = new OfficeTracker(true, 0);
    t.setAdvisor(true, 1);
    t.setStatus(busy, 2);
    t.toolStart(weigh("w1"), 3);
    t.toolStart(weigh("w2"), 4);
    t.toolEnd("w2", true, 5);
    expect(advisorOf(t.snapshot())?.activity?.id).toBe("w1");
    t.toolEnd("w1", true, 6);
    expect(advisorOf(t.snapshot())?.activity).toBeUndefined();
    // Turned off while asked: the asker's call still ends as its own.
    t.toolStart(weigh("w3"), 7);
    t.setAdvisor(false, 8);
    t.toolEnd("w3", true, 9);
    expect(t.snapshot().actors[0]?.activity?.id).toBe("think");
  });

  it("never counted among hidden actors when the office is full; comes in once there is room", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    for (let i = 1; i < MAX_ACTORS; i++) t.toolStart({ ...weigh(`bg${i}`), name: "Bash", kind: "shell", summary: "sleep 1", background: true }, 2);
    t.setAdvisor(true, 3);
    expect(advisorOf(t.snapshot())).toBeUndefined();
    expect(t.snapshot().session?.hiddenActors).toBe(0);
    t.backgroundEnded("bg1", true, 4);
    t.setAdvisor(true, 5);
    expect(advisorOf(t.snapshot())).toBeDefined();
  });

  it("without Advisor in, asking it is still a visit to the meeting room", () => {
    const t = new OfficeTracker(true, 0);
    t.setStatus(busy, 1);
    t.toolStart(weigh("w1"), 2);
    expect(advisorOf(t.snapshot())).toBeUndefined();
    expect(t.snapshot().actors[0]?.activity?.group).toBe(OfficeAnimGroup.CONSULT);
  });
});

describe("Advisor rebuilt from the journal", () => {
  const item = (id: string, at: number, body: NonNullable<MessageInitShape<typeof ItemSchema>["body"]>): Item => create(ItemSchema, { id, at: BigInt(at), body });
  const summary = (state: ThreadState) => create(ThreadSummarySchema, { id: "t1", provider: "claude", state });
  const journal = (open: boolean): Item[] => [
    item("u1", 10, { case: "turn", value: { state: open ? TurnState.RUNNING : TurnState.COMPLETED } }),
    item("c1", 11, { case: "toolCall", value: { toolId: "w1", name: CLAUDE_WEIGH, kind: WireToolKind.MCP, summary: "advisor_weigh" } }),
    item("r1", 12, { case: "toolResult", value: { toolId: "w1", ok: true } }),
    item("v1", 12, { case: "advisorVerdict", value: { toolId: "w1", options: [{ text: "Rebase", probability: 0.9 }, { text: "Merge", probability: 0.1 }], verdict: "confident" } }),
    ...(open ? [item("c2", 13, { case: "toolCall", value: { toolId: "w2", name: CLAUDE_WEIGH, kind: WireToolKind.MCP, summary: "advisor_weigh" } })] : []),
  ];

  it("opened after the turn: Advisor at its seat with its last answer, nobody asking", () => {
    const thread = new OfficeThread("t1", true, new OfficeMemory(), 100);
    thread.tracker.setAdvisor(true, 100);
    thread.seed(journal(false), summary(ThreadState.IDLE), 100);
    const s = thread.tracker.snapshot();
    expect(advisorOf(s)?.description).toBe("Rebase · 90%");
    expect(advisorOf(s)?.activity).toBeUndefined();
    expect(s.actors[0]?.activity).toBeUndefined();
  });

  it("opened while a call runs: the director at Advisor's seat, Advisor listening", () => {
    const thread = new OfficeThread("t1", true, new OfficeMemory(), 100);
    thread.tracker.setAdvisor(true, 100);
    thread.seed(journal(true), summary(ThreadState.RUNNING), 100);
    const s = thread.tracker.snapshot();
    expect(place(s.actors[0]?.activity)).toEqual({ id: "w2", group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING });
    expect(place(advisorOf(s)?.activity)).toEqual({ id: "w2", group: OfficeAnimGroup.CONSULT, room: OfficeRoom.MEETING });
    expect(advisorOf(s)?.description).toBe("Rebase · 90%");
  });
});

describe("Advisor over the hub", () => {
  /** An AI that takes tunelo's MCP and asks Advisor once per message (its answer as advisor_weigh returns it). */
  function weighingAi(): AgentProvider {
    const base = fakeProvider("adv");
    return {
      ...base,
      capabilities: { ...base.capabilities, sessionMcp: true },
      async start(): Promise<ProviderSession> {
        const events = new Channel<ProviderEvent>();
        events.push({ type: "session", sessionId: "adv-1" });
        let n = 0;
        const verdict = {
          advisor: "verdict",
          kind: "decision",
          verdict: "confident",
          choice: "Rebase",
          confidence: 0.9,
          options: [
            { text: "Rebase", probability: 0.8 },
            { text: "Merge", probability: 0.2 },
          ],
          sent: { kind: "decision", question: "Which way?", options: ["Rebase", "Merge"], context: "" },
          guidance: "",
        };
        return {
          events,
          async send() {
            const toolId = `toolu_${++n}`;
            events.push({ type: "tool-start", toolId, kind: "mcp", name: CLAUDE_WEIGH, summary: "advisor_weigh", input: JSON.stringify({ kind: "decision" }) });
            await wait(30);
            events.push({ type: "tool-end", toolId, ok: true, output: JSON.stringify(verdict) });
            events.push({ type: "turn-end", state: "completed", durationMs: 1 });
          },
          async interrupt() {},
          async setModel() {},
          async setEffort() {},
          async setPermissionMode() {},
          async close() {
            events.close();
          },
        };
      },
    };
  }

  const lease = () => ({ ticket: "t-1", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => undefined });

  it("a device that draws Advisor sees it asked; any other gets the same seq without a word of it", async () => {
    const ai = weighingAi();
    const { core, work } = makeCore([ai], { sessionMcp: lease, advisorKeySet: () => true });
    const hub = new OfficeHub(core, { providers: [ai], flushMs: 5 });
    const release = hub.attach();
    const thread = await core.create({ provider: "adv", model: "", dir: work, text: "", consent, device: "test" });
    core.setAdvisor(thread.id, true, "test");
    const drawn: OfficeEvents[] = [];
    const plain: OfficeEvents[] = [];
    const sinkDrawn = (e: OfficeEvents) => drawn.push(e);
    const sinkPlain = (e: OfficeEvents) => plain.push(e);
    const snapDrawn = hub.watch(thread.id, sinkDrawn, true);
    const snapPlain = hub.watch(thread.id, sinkPlain);
    expect(snapDrawn.state?.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR, OfficeRole.ADVISOR]);
    expect(snapPlain.state?.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR]);

    await core.send(thread.id, "go", "c1");
    await until(core, thread.id, (all) => byCase(all, "advisorVerdict").length === 1 && byCase(all, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));
    await wait(60);
    const evDrawn = drawn.flatMap((f) => f.events);
    const evPlain = plain.flatMap((f) => f.events);
    // Both run on from the same snapshot seq without a gap.
    expect(evDrawn.map((e) => e.seq)).toEqual(evPlain.map((e) => e.seq));
    expect(evDrawn.map((e) => Number(e.seq))).toEqual(evDrawn.map((_, i) => Number(snapDrawn.seq) + i + 1));
    const aboutAdvisor = (e: OfficeEvent) =>
      (e.kind.case === "actorUpdate" && e.kind.value.id === "advisor") || ((e.kind.case === "activityStart" || e.kind.case === "activityEnd") && e.kind.value.actorId === "advisor");
    expect(evDrawn.some((e) => e.kind.case === "activityStart" && e.kind.value.actorId === "advisor" && e.kind.value.activity?.group === OfficeAnimGroup.CONSULT)).toBe(true);
    expect(evDrawn.some((e) => e.kind.case === "actorUpdate" && e.kind.value.id === "advisor" && e.kind.value.description === "Rebase · 80%")).toBe(true);
    expect(evPlain.some(aboutAdvisor)).toBe(false);
    // Each event about Advisor reached the other device as an empty one.
    expect(evPlain.filter((e) => e.kind.case === undefined).length).toBe(evDrawn.filter(aboutAdvisor).length);
    // The asker's own visit goes to everyone (an older device acts it out as typing).
    expect(evPlain.some((e) => e.kind.case === "activityStart" && e.kind.value.actorId === "director" && e.kind.value.activity?.group === OfficeAnimGroup.CONSULT)).toBe(true);

    // Watched again later (a reload): Advisor and its answer come back from the journal.
    hub.unwatch(thread.id, sinkDrawn);
    hub.unwatch(thread.id, sinkPlain);
    const again = hub.watch(thread.id, sinkDrawn, true);
    expect(again.state?.actors.find((a) => a.role === OfficeRole.ADVISOR)?.description).toBe("Rebase · 80%");

    // Turned off: Advisor leaves.
    core.setAdvisor(thread.id, false, "test");
    await wait(30);
    expect(drawn.flatMap((f) => f.events).some((e) => e.kind.case === "actorLeave" && e.kind.value.actorId === "advisor")).toBe(true);
    release();
    await core.stop();
  });

  it("no Advisor in the office while the session's automatic Advisor is off", async () => {
    const ai = weighingAi();
    const { core, work } = makeCore([ai], { sessionMcp: lease, advisorKeySet: () => true });
    const hub = new OfficeHub(core, { providers: [ai] });
    const thread = await core.create({ provider: "adv", model: "", dir: work, text: "", consent, device: "test" });
    expect(hub.watch(thread.id, () => undefined, true).state?.actors.map((a) => a.role)).toEqual([OfficeRole.DIRECTOR]);
    await core.stop();
  });
});

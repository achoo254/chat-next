// The hub that serves devices a Claude Code session's timeline, on a real
// store: the recent sessions newest first with their /clear links; a
// snapshot capped at its limit whose older events page back without a gap
// or a repeat, rows of one millisecond included; events written later with
// seq one apart, a row written again replacing its event and one unchanged
// sending nothing; a gap answered by watching again; the caps; no state and
// no reads for a session nobody watches; the service told of the first and
// last watcher; a new epoch at start and after a wipe; and never content.
import { ErrorReason, type ObservatoryEvent, type ObservatoryEvents } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../../src/core/agent-core.ts";
import {
  DEFAULT_PAGE,
  type ObservatoryEventSink,
  ObservatoryHub,
  SESSIONS_PER_MACHINE,
  VIEWERS_PER_SESSION,
  WATCHES_PER_CONNECTION,
} from "../../src/observatory/hub/observatory-hub.ts";
import type { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { openTempStore, sessionOps } from "./store-fixture.ts";

const MARK = "ZZCONTENT-5d1e-private";
const T = 1_790_000_000_000;

type Setup = {
  store: ObservatoryStore;
  hub: ObservatoryHub;
  write: (ops: WriteOp[]) => void;
  watched: string[];
  unwatched: string[];
  problems: string[];
};

const opened: ObservatoryStore[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

async function setup(): Promise<Setup> {
  const store = await openTempStore();
  opened.push(store);
  const watched: string[] = [];
  const unwatched: string[] = [];
  const problems: string[] = [];
  const hub = new ObservatoryHub({
    store: () => store,
    watchSession: (id) => watched.push(id),
    unwatchSession: (id) => unwatched.push(id),
    problems: (place) => problems.push(place),
    flushMs: 5,
  });
  hub.start();
  const write = (ops: WriteOp[]): void => {
    store.write(ops);
    hub.written(ops);
  };
  return { store, hub, write, watched, unwatched, problems };
}

/** A sink recording every frame it gets. */
function recorder(): { sink: ObservatoryEventSink; frames: ObservatoryEvents[]; events: () => ObservatoryEvent[] } {
  const frames: ObservatoryEvents[] = [];
  return { sink: (f) => frames.push(f), frames, events: () => frames.flatMap((f) => f.events) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function reasonOf(fn: () => unknown): ErrorReason | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AgentError ? err.reason : undefined;
  }
  return undefined;
}

function prompts(sessionId: string, n: number, at: number): WriteOp[] {
  return Array.from({ length: n }, (_, i) => ({ kind: "prompt", row: { promptId: `${sessionId}-p${String(i).padStart(4, "0")}`, sessionId, at: at + i, length: i, excerpt: `${MARK} ${i}` } }));
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

describe("listing sessions", () => {
  it("lists the newest first with the session each one continues after /clear", async () => {
    const { hub, write } = await setup();
    write([
      { kind: "session", row: { sessionId: "old", source: "cli", startedAt: T, cwd: "~/work/app" } },
      { kind: "session", row: { sessionId: "new", source: "cli", startedAt: T + 10, previousSessionId: "old", previousSessionInferred: false, cwd: "~/work/app" } },
      { kind: "session", row: { sessionId: "sdk", source: "sdk", startedAt: T + 5 } },
    ]);
    const list = hub.listSessions(0);
    expect(list.sessions.map((s) => [s.sessionId, s.previousSessionId])).toEqual([
      ["new", "old"],
      ["sdk", ""],
      ["old", ""],
    ]);
    expect(hub.listSessions(1).sessions).toHaveLength(1);
  });
});

describe("the snapshot and older pages", () => {
  it("carries the newest events up to its limit, and pages back to the first without a gap or a repeat", async () => {
    const { hub, write } = await setup();
    write([{ kind: "session", row: { sessionId: "s", source: "cli", startedAt: T } }, ...prompts("s", 600, T)]);
    const { sink } = recorder();
    const capped = hub.watch("s", sink, 10_000);
    expect(capped.events).toHaveLength(500);
    expect(capped.events.map((e) => Number(e.seq))).toEqual(new Array(500).fill(0));
    expect(capped.events.at(-1)?.id).toBe("prompt:s-p0599");
    expect(capped.session?.totals?.prompts).toBe(600);
    expect(capped.session?.info?.sessionId).toBe("s");
    expect(hub.watch("s", sink).events).toHaveLength(DEFAULT_PAGE);

    const ids = capped.events.map((e) => e.id);
    let earlier = capped.earlier;
    while (earlier !== "") {
      const page = hub.earlier("s", earlier, 64);
      ids.unshift(...page.events.map((e) => e.id));
      earlier = page.earlier;
    }
    expect(ids).toEqual(Array.from({ length: 600 }, (_, i) => `prompt:s-p${String(i).padStart(4, "0")}`));
  });

  it("pages rows of every kind written in the same millisecond one by one, each once", async () => {
    const { hub, write } = await setup();
    const ops = [...sessionOps("a", T), ...sessionOps("b", T)].map((op) => (op.kind === "session" ? op : ({ ...op, row: { ...op.row, sessionId: "same" } } as WriteOp)));
    // Every row at one time.
    write(ops.map((op) => (op.kind === "subagent" ? { ...op, row: { ...op.row, startedAt: T } } : op.kind === "session" ? op : ({ ...op, row: { ...op.row, at: T } } as WriteOp))));
    const all = hub.watch("same", recorder().sink, 500).events.map((e) => e.id);
    expect(all).toHaveLength(12);
    const seen: string[] = [];
    let page = hub.watch("same", recorder().sink, 1);
    seen.unshift(...page.events.map((e) => e.id));
    let earlier = page.earlier;
    while (earlier !== "") {
      const older = hub.earlier("same", earlier, 1);
      seen.unshift(...older.events.map((e) => e.id));
      earlier = older.earlier;
    }
    expect(seen).toEqual(all);
    page = hub.watch("same", recorder().sink, 3);
    expect(page.events.map((e) => e.id)).toEqual(all.slice(-3));
  });

  it("refuses a cursor or a session id it did not make", async () => {
    const { hub } = await setup();
    expect(reasonOf(() => hub.earlier("s", "not-a-cursor"))).toBe(ErrorReason.OBSERVATORY_INVALID);
    expect(reasonOf(() => hub.earlier("s", "1.9.x"))).toBe(ErrorReason.OBSERVATORY_INVALID);
    expect(reasonOf(() => hub.watch("", recorder().sink))).toBe(ErrorReason.OBSERVATORY_INVALID);
    expect(reasonOf(() => hub.watch("a\nb", recorder().sink))).toBe(ErrorReason.OBSERVATORY_INVALID);
    expect(reasonOf(() => hub.watch("x".repeat(201), recorder().sink))).toBe(ErrorReason.OBSERVATORY_INVALID);
  });
});

describe("events", () => {
  it("go to the watchers with seq one apart from the snapshot; a row written again replaces its event, unchanged it sends nothing", async () => {
    const { hub, write } = await setup();
    const a = recorder();
    const b = recorder();
    // Not stored yet: an empty snapshot, the events follow.
    const snap = hub.watch("s", a.sink);
    expect(snap.events).toEqual([]);
    expect(snap.session?.info).toBeUndefined();
    expect(hub.watch("s", b.sink).seq).toBe(snap.seq);

    write(sessionOps("s", T));
    await wait(40);
    const first = a.events();
    expect(first.map((e) => Number(e.seq))).toEqual(first.map((_, i) => Number(snap.seq) + i + 1));
    expect(first.map((e) => e.kind.case)).toEqual(["prompt", "toolCall", "toolCall", "subagent", "apiRequest", "instructionLoaded", "gitOp", "session"]);
    expect(b.frames).toEqual(a.frames);
    const state = first.at(-1)?.kind;
    if (state?.case !== "session") throw new Error("no session event");
    expect(state.value.totals).toMatchObject({ prompts: 1, toolCalls: 2, toolFailures: 1, subagents: 1, apiRequests: 1, gitOps: 1, hasCost: true, costUsdEstimate: 0.25 });
    expect(state.value.info?.source).toBeGreaterThan(0);
    expect(state.value.live?.subagents.map((x) => x.agentId)).toEqual(["s-a1"]);

    // The same rows again: nothing changed, nothing sent.
    write(sessionOps("s", T));
    await wait(40);
    expect(a.events()).toHaveLength(first.length);

    // The subagent ended: its event again, same id, the totals unchanged, and the live state without it.
    write([{ kind: "subagent", row: { sessionId: "s", agentId: "s-a1", startedAt: T + 4, endedAt: T + 50, toolCount: 3 } }]);
    await wait(40);
    const update = a.events().slice(first.length);
    expect(update.map((e) => [Number(e.seq), e.kind.case])).toEqual([
      [first.length + 1, "subagent"],
      [first.length + 2, "session"],
    ]);
    expect(update[0]?.id).toBe("subagent:s-a1");
    const sub = update[0]?.kind;
    expect(sub?.case === "subagent" ? [sub.value.endedAt, sub.value.toolCount] : undefined).toEqual([BigInt(T + 50), 3]);
    const after = update[1]?.kind;
    expect(after?.case === "session" ? [after.value.live?.subagents, after.value.totals?.subagents] : undefined).toEqual([[], 1]);
  });

  it("leave a gap a device answers by watching again: the snapshot holds what it missed and the next events follow it", async () => {
    const { hub, write } = await setup();
    const frames: ObservatoryEvents[] = [];
    let drop = true;
    // A connection too busy for the first frame drops it (connection.ts).
    const sink: ObservatoryEventSink = (f) => {
      if (drop) drop = false;
      else frames.push(f);
    };
    const snap = hub.watch("s", sink);
    write(prompts("s", 2, T));
    await wait(40);
    write(prompts("s", 3, T + 100).map((op) => (op.kind === "prompt" ? { ...op, row: { ...op.row, promptId: `late-${op.row.promptId}` } } : op)));
    await wait(40);
    const got = frames.flatMap((f) => f.events);
    expect(Number(got[0]?.seq)).toBeGreaterThan(Number(snap.seq) + 1);
    const again = hub.watch("s", sink);
    expect(again.seq).toBe(got.at(-1)?.seq);
    expect(again.events.filter((e) => e.kind.case === "prompt")).toHaveLength(5);
    write(prompts("s", 1, T + 200).map((op) => (op.kind === "prompt" ? { ...op, row: { ...op.row, promptId: "last" } } : op)));
    await wait(40);
    expect(frames.at(-1)?.events[0]?.seq).toBe(again.seq + 1n);
  });

  it("are not read for a session nobody watches, and a watch that ends keeps nothing", async () => {
    const { hub, write, store, watched, unwatched } = await setup();
    let reads = 0;
    const timelineEntry = store.timelineEntry.bind(store);
    store.timelineEntry = (ref) => {
      reads++;
      return timelineEntry(ref);
    };
    write(sessionOps("nobody", T));
    await wait(30);
    expect(reads).toBe(0);
    expect(hub.watched).toEqual([]);

    const a = recorder();
    const b = recorder();
    hub.watch("s", a.sink);
    hub.watch("s", b.sink);
    expect(watched).toEqual(["s"]);
    hub.unwatch("s", a.sink);
    expect(unwatched).toEqual([]);
    hub.forget(b.sink);
    expect(unwatched).toEqual(["s"]);
    expect(hub.watched).toEqual([]);
    write(sessionOps("s", T));
    await wait(30);
    expect(reads).toBe(0);
    expect(a.frames).toEqual([]);
  });
});

describe("the caps", () => {
  it("refuse a fifth session on one connection, a seventeenth on the machine and a ninth viewer of one session; watching again is never refused", async () => {
    const { hub } = await setup();
    const one = recorder().sink;
    for (let i = 0; i < WATCHES_PER_CONNECTION; i++) hub.watch(`c${i}`, one);
    expect(reasonOf(() => hub.watch("c-extra", one))).toBe(ErrorReason.OBSERVATORY_WATCH_LIMIT);
    expect(reasonOf(() => hub.watch("c0", one))).toBeUndefined();
    hub.unwatch("c0", one);
    expect(reasonOf(() => hub.watch("c-extra", one))).toBeUndefined();

    const others = Array.from({ length: SESSIONS_PER_MACHINE }, () => recorder().sink);
    for (let i = hub.watched.length; i < SESSIONS_PER_MACHINE; i++) hub.watch(`m${i}`, others[i] ?? one);
    expect(hub.watched).toHaveLength(SESSIONS_PER_MACHINE);
    expect(reasonOf(() => hub.watch("m-extra", recorder().sink))).toBe(ErrorReason.OBSERVATORY_WATCH_LIMIT);

    const viewers = Array.from({ length: VIEWERS_PER_SESSION - 1 }, () => recorder().sink);
    for (const v of viewers) hub.watch("c1", v);
    expect(reasonOf(() => hub.watch("c1", recorder().sink))).toBe(ErrorReason.OBSERVATORY_WATCH_LIMIT);
    expect(reasonOf(() => hub.watch("c1", one))).toBeUndefined();
  });
});

describe("the lifecycle", () => {
  it("refuses requests while stopped, and takes a new epoch at start and after a wipe", async () => {
    const { hub, write } = await setup();
    const a = recorder();
    const first = hub.watch("s", a.sink);
    hub.stop();
    expect(reasonOf(() => hub.watch("s", a.sink))).toBe(ErrorReason.OBSERVATORY_OFF);
    expect(reasonOf(() => hub.listSessions(0))).toBe(ErrorReason.OBSERVATORY_OFF);
    write(sessionOps("s", T));
    await wait(30);
    expect(a.frames).toEqual([]);
    hub.start();
    const second = hub.watch("s", a.sink);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    hub.reset();
    write(prompts("s", 1, T + 50));
    await wait(30);
    // The watcher hears the new epoch on its next frame and watches again.
    expect(a.frames.at(-1)?.epoch).toBeGreaterThan(second.epoch);
    expect(a.frames.at(-1)?.events[0]?.seq).toBe(1n);
  });
});

describe("content", () => {
  it("never reaches a snapshot, an event or a page, though the store keeps it", async () => {
    const { hub, write, store } = await setup();
    const a = recorder();
    write([...prompts("s", 3, T), { kind: "toolCall", row: { toolUseId: "t1", sessionId: "s", at: T + 5, toolName: "Bash", content: `{"input":"${MARK}"}` } }]);
    const snap = hub.watch("s", a.sink, 2);
    write([...prompts("s", 2, T + 10).map((op) => (op.kind === "prompt" ? { ...op, row: { ...op.row, promptId: `n-${op.row.promptId}` } } : op)), { kind: "toolCall", row: { toolUseId: "t2", sessionId: "s", at: T + 20, toolName: "Read", content: MARK } }]);
    await wait(40);
    const page = hub.earlier("s", snap.earlier, 100);
    expect(a.events().length).toBeGreaterThan(0);
    expect(page.events.length).toBeGreaterThan(0);
    expect(json(store.sessionTimeline("s"))).toContain(MARK);
    for (const wire of [snap, page, ...a.frames]) expect(json(wire)).not.toContain(MARK);
  });
});

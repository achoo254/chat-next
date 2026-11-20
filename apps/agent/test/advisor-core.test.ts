// A session's automatic Advisor in the core, with tunelo's MCP and a fake Jev
// (never the real service): what the AI is told (beside the message, or
// below its text), the transcript card of each advisor_weigh call with its
// tool and turn, calls stopped with the turn, and advisor_missed.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type Item, TurnState } from "@achoo254/chat-proto/remote/remote";
import { afterEach, describe, expect, it } from "vitest";
import { ADVISOR_OFF, AUTO_INSTRUCTIONS, AUTO_REMINDER, NOTE_SEPARATOR, stopReminder, withNote } from "../src/advisor/advisor-instructions.ts";
import type { AdvisorHooks } from "../src/advisor/advisor-tools.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { forgetSecrets, rememberSecret, secretVariants } from "../src/mcp/redact.ts";
import type { AgentProvider, HistoryEntry, ProviderEvent, SessionHistory } from "../src/providers/types.ts";
import { Channel } from "../src/util/channel.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const KEY = "ts_live_9d1e5b3a7c2f4e6a8b0d1c3e5f7a9b2c4d6e8f0a";
const consent = { sensitive: false, projectSettings: false };
const WEIGH = "mcp__tunelo__advisor_weigh";

afterEach(() => forgetSecrets());

const textOf = (r: CallToolResult): string => (r.content[0]?.type === "text" ? r.content[0].text : "");

type Sent = { text: string; note?: string };

type Options = {
  notes?: boolean;
  key?: boolean;
  history?: SessionHistory;
  /** A message sent while a turn runs is answered in that same turn (one end for both), as an AI may do. */
  merge?: boolean;
};

/**
 * A machine whose AI runs a script per message (by the user's words, tunelo's
 * note taken off): "weigh <kind>" calls advisor_weigh through tunelo's MCP,
 * "hang" calls it while Jev never answers, "late" reports a good answer only
 * after the gate opens (the test interrupts first), "pause" waits for the
 * gate, "pause next" asks for next steps then waits for the gate, "fail"
 * fails; anything else just answers. An AI taking notes beside a message
 * gets them when `deliver` says the message reached it (a hook that ran).
 */
function machine(opts: Options = {}) {
  const sent: Sent[] = [];
  const control = { deliver: true, failStart: false, startGate: undefined as Promise<void> | undefined, stop: (() => undefined) as () => string | undefined };
  const jevBodies: string[] = [];
  let hang = false;
  /** The machine-wide automatic Advisor switch (AdvisorSetAuto). */
  const auto = { on: false };
  let openGate: () => void = () => undefined;
  const gate = () => new Promise<void>((r) => (openGate = r));
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    jevBodies.push(String(init?.body));
    if (hang) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return new Response(JSON.stringify({ answers: { q: { choice: "o1", probabilities: { o1: 0.9, o2: 0.1 }, confidence: 0.9 } } }), { status: 200 });
  }) as typeof fetch;

  // Made once the core exists (its hooks call the core); sessions only start after that.
  const mcp: { host?: McpHost } = {};
  const base = fakeProvider("adv");
  const provider: AgentProvider = {
    ...base,
    capabilities: { ...base.capabilities, sessionMcp: true, ...(opts.notes ? { sessionNotes: true } : {}) },
    ...(opts.history ? { history: opts.history } : {}),
    async start({ policy }) {
      await control.startGate;
      if (control.failStart) throw new Error("the AI did not start");
      const events = new Channel<ProviderEvent>();
      events.push({ type: "session", sessionId: "adv-1" });
      const ticket = policy.sessionMcp?.ticket;
      // What the AI's Stop hook asks as it is about to end a turn.
      control.stop = () => policy.sessionMcp?.advisorStop?.();
      const mcpId = mcp.host && ticket ? mcp.host.open("https://tunnel.example", ticket) : undefined;
      let n = 0;
      let busy = 0;
      let chain = Promise.resolve();
      const weigh = async (toolId: string, args: Record<string, unknown>) => {
        events.push({ type: "tool-start", toolId, kind: "mcp", name: WEIGH, summary: "advisor_weigh", input: JSON.stringify(args) });
        const r = mcp.host && mcpId ? await mcp.host.call(mcpId, "advisor", "advisor_weigh", args) : { isError: true, content: [{ type: "text" as const, text: "no MCP" }] };
        events.push({ type: "tool-end", toolId, ok: !r.isError, output: textOf(r) });
      };
      const run = async (words: string) => {
        const turn = ++n;
        const ask = { question: "Which way?", options: ["Rebase", "Merge"], context: "Push was rejected" };
        if (words.startsWith("weigh ")) {
          await weigh(`toolu_${turn}`, { kind: words.slice(6), ...ask });
        } else if (words === "bad next") {
          await weigh(`toolu_${turn}`, { kind: "next_steps", ...ask, options: ["/compact", "Run the tests"] });
        } else if (words === "hang") {
          hang = true;
          await weigh(`toolu_${turn}`, { kind: "decision", ...ask });
          hang = false;
          return events.push({ type: "turn-end", state: "interrupted", durationMs: 1 });
        } else if (words === "late") {
          events.push({ type: "tool-start", toolId: `toolu_${turn}`, kind: "mcp", name: WEIGH, summary: "", input: JSON.stringify({ kind: "next_steps" }) });
          await gate();
          const good = { advisor: "verdict", kind: "next_steps", verdict: "confident", choice: "A", confidence: 1, options: [{ text: "A", probability: 1 }], sent: { kind: "next_steps", question: "q", options: ["A", "B"], context: "" }, guidance: "" };
          events.push({ type: "tool-end", toolId: `toolu_${turn}`, ok: true, output: JSON.stringify(good) });
          return events.push({ type: "turn-end", state: "interrupted", durationMs: 1 });
        } else if (words === "pause") {
          await gate();
        } else if (words === "pause next") {
          await weigh(`toolu_${turn}`, { kind: "next_steps", ...ask });
          await gate();
        } else if (words === "fail") {
          return events.push({ type: "turn-end", state: "failed", durationMs: 1 });
        }
        events.push({ type: "text", blockId: `b${turn}`, role: "assistant", text: `done ${words}` });
        events.push({ type: "turn-end", state: "completed", durationMs: 1 });
      };
      return {
        events,
        async send(text, _images, note) {
          const given = control.deliver ? note?.take() : undefined;
          if (given) note?.delivered();
          sent.push({ text, ...(given ? { note: given } : {}) });
          const words = text.split(NOTE_SEPARATOR)[0] ?? text;
          if (opts.merge && busy > 0) return;
          busy += 1;
          chain = chain.then(() => run(words)).finally(() => (busy -= 1));
        },
        async interrupt() {
          // the core stops Advisor's call; the script ends the turn
        },
        async close() {
          events.close();
        },
      };
    },
  };

  const { core, work } = makeCore([provider], {
    sessionMcp: (threadId) => {
      const h = mcp.host;
      if (!h) return undefined;
      const ticket = h.tickets.issue(threadId);
      return { ticket, configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => h.release(ticket) };
    },
    advisorKeySet: () => opts.key !== false,
    more: { advisorAuto: () => auto.on },
  });
  const hooks: AdvisorHooks = {
    allowed: (id) => core.advisorAllowed(id),
    key: async () => (opts.key === false ? undefined : KEY),
    call: (id, run) => core.advisorCall(id, run),
    isSensitive: () => false,
    jev: { fetch: fetchFake, timeoutMs: 2_000 },
  };
  mcp.host = new McpHost(tempDir("advisor-core-"), { advisor: () => hooks, localWrites: () => false, enabledGroups: () => [] });

  /** A thread with Advisor on whose first turn (`text`) went through. */
  const thread = async (text = "hello", on = true) => {
    const t = await core.create({ provider: "adv", model: "", dir: work, text, consent, device: "phone" });
    await until(core, t.id, (i) => byCase(i, "turn").every((x) => x.body.value.state !== TurnState.RUNNING));
    if (on) core.setAdvisor(t.id, true, "phone");
    return t.id;
  };
  const turns = (id: string) => byCase(core.snapshot(id), "turn").map((x) => x.body.value);
  const settled = (id: string, count: number) =>
    until(core, id, (i) => byCase(i, "turn").filter((x) => x.body.value.state !== TurnState.RUNNING).length === count);
  /** Flips the machine-wide switch the way the machine does. */
  const setAuto = (on: boolean) => {
    auto.on = on;
    core.advisorAutoChanged();
  };
  return { core, sent, jevBodies, thread, turns, settled, control, setAuto, open: () => openGate() };
}

const verdicts = (items: Item[]) => byCase(items, "advisorVerdict").map((x) => x.body.value);

describe("the transcript card of an advisor_weigh call", () => {
  it("carries the call's tool and turn, what was sent and Advisor's answer; the key is nowhere", async () => {
    rememberSecret(KEY);
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "weigh decision", "c1");
    const items = await m.settled(id, 2);
    const [v] = verdicts(items);
    const turnItem = byCase(items, "turn")[1];
    expect(v).toMatchObject({
      toolId: "toolu_2",
      turnId: turnItem?.id,
      kind: "decision",
      question: "Which way?",
      context: "Push was rejected",
      verdict: "confident",
      error: "",
    });
    expect(v?.options.map((o) => [o.text, Number(o.probability.toFixed(2))])).toEqual([
      ["Rebase", 0.9],
      ["Merge", 0.1],
    ]);
    // The tool call and its result stay in the journal too: a device folds them into the card by tool_id.
    expect(byCase(items, "toolCall").some((x) => x.body.value.toolId === "toolu_2")).toBe(true);
    const journal = JSON.stringify(items, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    for (const form of secretVariants(KEY)) expect(journal).not.toContain(form);
    for (const body of m.jevBodies) expect(body).not.toContain(KEY);
  });

  it("an interrupted turn stops the call: the card says so and no next step is offered", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "hang", "c1");
    await until(m.core, id, (i) => byCase(i, "toolCall").length === 1);
    await new Promise((r) => setTimeout(r, 20));
    await m.core.interrupt(id);
    const items = await m.settled(id, 2);
    expect(verdicts(items)).toEqual([expect.objectContaining({ toolId: "toolu_2", error: "interrupted", verdict: "" })]);
    expect(m.turns(id)[1]).toMatchObject({ state: TurnState.INTERRUPTED, advisorMissed: false });
  });

  it("an answer that comes after the user stopped the turn reads as interrupted", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "late", "c1");
    await until(m.core, id, (i) => byCase(i, "toolCall").length === 1);
    await m.core.interrupt(id);
    m.open();
    const items = await m.settled(id, 2);
    expect(verdicts(items)).toEqual([expect.objectContaining({ error: "interrupted", verdict: "", kind: "next_steps" })]);
  });
});

describe("advisor_missed", () => {
  it("a completed turn that never asked for next steps", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "just answer", "c1");
    await m.settled(id, 2);
    expect(m.turns(id)[1]?.advisorMissed).toBe(true);
  });

  it("not when it asked, even when the call was refused", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "weigh next_steps", "c1");
    await m.settled(id, 2);
    await m.core.send(id, "bad next", "c2");
    const items = await m.settled(id, 3);
    expect(m.turns(id).slice(1).map((t) => t.advisorMissed)).toEqual([false, false]);
    expect(verdicts(items).map((v) => v.error)).toEqual(["", "invalid"]);
  });

  it("not for a failed turn, with Advisor off, without a key, or once turned off during the turn", async () => {
    const failed = machine();
    const a = await failed.thread();
    await failed.core.send(a, "fail", "c1");
    await failed.settled(a, 2);
    expect(failed.turns(a)[1]).toMatchObject({ state: TurnState.FAILED, advisorMissed: false });

    const off = machine();
    const b = await off.thread("hello", false);
    await off.core.send(b, "just answer", "c1");
    await off.settled(b, 2);
    expect(off.turns(b)[1]?.advisorMissed).toBe(false);

    const noKey = machine({ key: false });
    const c = await noKey.thread();
    await noKey.core.send(c, "just answer", "c1");
    await noKey.settled(c, 2);
    expect(noKey.turns(c)[1]?.advisorMissed).toBe(false);

    const toggled = machine();
    const d = await toggled.thread();
    await toggled.core.send(d, "pause", "c1");
    await until(toggled.core, d, (i) => byCase(i, "turn").length === 2);
    toggled.core.setAdvisor(d, false, "phone");
    toggled.core.setAdvisor(d, true, "phone");
    toggled.open();
    await toggled.settled(d, 2);
    expect(toggled.turns(d)[1]?.advisorMissed).toBe(false);
  });
});

describe("the AI's Stop hook asks the core before a turn ends", () => {
  /** Waits until the first tool call of the second turn (advisor_weigh) went through. */
  const asked = (m: ReturnType<typeof machine>, id: string) => until(m.core, id, (i) => byCase(i, "toolCall").length === 1).then(() => new Promise((r) => setTimeout(r, 20)));

  it("a turn that has not asked for next steps is held with the reminder", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "pause", "c1");
    await until(m.core, id, (i) => byCase(i, "turn").length === 2);
    expect(m.control.stop()).toBe(stopReminder());
    m.open();
    await m.settled(id, 2);
  });

  it("not once it asked for next steps, nor when it asked only for a decision", async () => {
    const next = machine();
    const a = await next.thread();
    await next.core.send(a, "pause next", "c1");
    await asked(next, a);
    expect(next.control.stop()).toBeUndefined();
    next.open();
    await next.settled(a, 2);

    const decision = machine();
    const b = await decision.thread();
    await decision.core.send(b, "weigh decision", "c1");
    await decision.settled(b, 2);
    // The turn is over by now; a decision alone never counted: the miss shows on the turn.
    expect(decision.turns(b)[1]?.advisorMissed).toBe(true);
  });

  it("not with Advisor off, without a key, or between turns", async () => {
    const off = machine();
    const a = await off.thread("hello", false);
    await off.core.send(a, "pause", "c1");
    await until(off.core, a, (i) => byCase(i, "turn").length === 2);
    expect(off.control.stop()).toBeUndefined();
    off.open();
    await off.settled(a, 2);

    const noKey = machine({ key: false });
    const b = await noKey.thread();
    await noKey.core.send(b, "pause", "c1");
    await until(noKey.core, b, (i) => byCase(i, "turn").length === 2);
    expect(noKey.control.stop()).toBeUndefined();
    noKey.open();
    await noKey.settled(b, 2);

    const idle = machine();
    await idle.thread();
    expect(idle.control.stop()).toBeUndefined();
  });

  it("not when Advisor was turned off and on again during the turn (the turn was not covered all along)", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.send(id, "pause", "c1");
    await until(m.core, id, (i) => byCase(i, "turn").length === 2);
    m.core.setAdvisor(id, false, "phone");
    m.core.setAdvisor(id, true, "phone");
    expect(m.control.stop()).toBeUndefined();
    m.open();
    await m.settled(id, 2);
  });
});

describe("the machine-wide automatic Advisor switch", () => {
  it("turns every session on and off at once, with no per-session switch, and tells the AI as it does for one session", async () => {
    const m = machine();
    const id = await m.thread("hello", false);
    expect(m.core.advisorOn(id)).toBe(false);
    m.setAuto(true);
    expect(m.core.advisorOn(id)).toBe(true);
    expect(m.core.advisorAllowed(id)).toBe(true);
    await m.core.send(id, "first", "c1");
    await m.settled(id, 2);
    m.setAuto(false);
    expect(m.core.advisorOn(id)).toBe(false);
    await m.core.send(id, "second", "c2");
    await m.settled(id, 3);
    await m.core.send(id, "third", "c3");
    await m.settled(id, 4);
    expect(m.sent.map((s) => s.text)).toEqual(["hello", withNote("first", AUTO_INSTRUCTIONS), withNote("second", ADVISOR_OFF), "third"]);
  });

  it("leaves a session turned on by an older device on when the machine-wide switch goes off", async () => {
    const m = machine();
    const id = await m.thread("hello", true);
    m.setAuto(true);
    m.setAuto(false);
    expect(m.core.advisorOn(id)).toBe(true);
  });
});

describe("what the AI is told about Advisor", () => {
  it("below the message for an AI that takes no note beside it: whole text, reminder, nothing with a command, off once", async () => {
    const m = machine();
    const id = await m.thread("hello");
    await m.core.send(id, "first", "c1");
    await m.settled(id, 2);
    await m.core.send(id, "/compact", "c2");
    await m.settled(id, 3);
    await m.core.send(id, "second", "c3");
    await m.settled(id, 4);
    m.core.setAdvisor(id, false, "phone");
    await m.core.send(id, "third", "c4");
    await m.settled(id, 5);
    await m.core.send(id, "fourth", "c5");
    await m.settled(id, 6);
    expect(m.sent.map((s) => s.text)).toEqual([
      "hello",
      withNote("first", AUTO_INSTRUCTIONS),
      "/compact",
      withNote("second", AUTO_REMINDER),
      withNote("third", ADVISOR_OFF),
      "fourth",
    ]);
    // The journal keeps the user's words only.
    const users = byCase(m.core.snapshot(id), "text")
      .filter((x) => x.body.value.clientMsgId !== "")
      .map((x) => x.body.value.text);
    expect(users).toEqual(["first", "/compact", "second", "third", "fourth"]);
  });

  it("beside the message for an AI that takes notes: the text stays the user's", async () => {
    const m = machine({ notes: true });
    const id = await m.thread("hello");
    await m.core.send(id, "first", "c1");
    await m.settled(id, 2);
    await m.core.send(id, "/review", "c2");
    await m.settled(id, 3);
    await m.core.send(id, "second", "c3");
    await m.settled(id, 4);
    expect(m.sent).toEqual([{ text: "hello" }, { text: "first", note: AUTO_INSTRUCTIONS }, { text: "/review" }, { text: "second", note: AUTO_REMINDER }]);
  });

  it("a turn read back from the AI's transcript comes in without tunelo's note", async () => {
    let end = 0;
    let entries: HistoryEntry[] = [];
    const history: SessionHistory = {
      list: () => ({ sessions: [], total: 0, dirs: [] }),
      find: () => undefined,
      end: () => end,
      read: () => ({ entries, end }),
    };
    const m = machine({ history });
    const id = await m.thread("hello");
    end = 100;
    entries = [{ at: 1, type: "user", id: "h:1", text: withNote("typed in the terminal", AUTO_REMINDER) }];
    await m.core.send(id, "next", "c1");
    await m.settled(id, 2);
    const texts = byCase(m.core.snapshot(id), "text").map((x) => x.body.value.text);
    expect(texts).toContain("typed in the terminal");
    expect(texts.some((t) => t.includes(NOTE_SEPARATOR))).toBe(false);
  });
});

describe("a message sent while a turn runs", () => {
  for (const merge of [false, true]) {
    it(`never flags a turn by guess, and every card has the running turn (${merge ? "one end for both" : "one end each"})`, async () => {
      const m = machine({ merge });
      const id = await m.thread();
      await m.core.send(id, "pause next", "c1");
      await until(m.core, id, (i) => byCase(i, "advisorVerdict").length === 1);
      // Queued: it asks Advisor in its own turn when the AI answers it apart.
      await m.core.send(id, "weigh decision", "c2");
      m.open();
      const want = merge ? 1 : 2;
      const items = await until(m.core, id, (i) => byCase(i, "advisorVerdict").length === want && byCase(i, "turn").at(-1)?.body.value.state === TurnState.COMPLETED);
      const turnIds = byCase(items, "turn").map((x) => x.id);
      const cards = verdicts(items);
      expect(cards.every((v) => v.turnId !== "" && turnIds.includes(v.turnId))).toBe(true);
      if (!merge) expect(cards[1]?.turnId).toBe(turnIds.at(-1));
      expect(m.turns(id).some((t) => t.advisorMissed)).toBe(false);
      // The next turn on an idle session is judged again.
      await m.core.send(id, "just answer", "c3");
      await until(m.core, id, (i) => byCase(i, "turn").at(-1)?.body.value.state === TurnState.COMPLETED);
      expect(m.turns(id).at(-1)?.advisorMissed).toBe(true);
    });
  }
});

describe("the whole text only counts once the AI got it", () => {
  it("a session that did not start: the next message carries the whole text again", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.close(id);
    m.control.failStart = true;
    await m.core.send(id, "first", "c1").catch(() => undefined);
    m.control.failStart = false;
    await m.core.send(id, "second", "c2");
    await m.settled(id, 3);
    expect(m.sent.at(-1)?.text).toBe(withNote("second", AUTO_INSTRUCTIONS));
  });

  it("stopped before the session opened: the next message carries the whole text again", async () => {
    const m = machine();
    const id = await m.thread();
    await m.core.close(id);
    let release: () => void = () => undefined;
    m.control.startGate = new Promise<void>((r) => (release = r));
    const first = m.core.send(id, "first", "c1");
    await new Promise((r) => setTimeout(r, 10));
    await m.core.interrupt(id);
    release();
    await first;
    m.control.startGate = undefined;
    await m.core.send(id, "second", "c2");
    await m.settled(id, 3);
    expect(m.sent.map((x) => x.text)).not.toContain(withNote("first", AUTO_INSTRUCTIONS));
    expect(m.sent.at(-1)?.text).toBe(withNote("second", AUTO_INSTRUCTIONS));
  });

  it("beside the message: a note whose hook never ran is sent again with the next one", async () => {
    const m = machine({ notes: true });
    const id = await m.thread();
    m.control.deliver = false;
    await m.core.send(id, "first", "c1");
    await m.settled(id, 2);
    m.control.deliver = true;
    await m.core.send(id, "second", "c2");
    await m.settled(id, 3);
    await m.core.send(id, "third", "c3");
    await m.settled(id, 4);
    expect(m.sent.slice(1)).toEqual([{ text: "first" }, { text: "second", note: AUTO_INSTRUCTIONS }, { text: "third", note: AUTO_REMINDER }]);
  });
});

import { join } from "node:path";
import { PromptState, Role } from "@achoo254/chat-proto/remote/remote";
import { conversationBreakItem } from "@achoo254/chat-remote-protocol";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/threads/journal.ts";
import { MAX_PAGE, earlierPage, pageSize, tailPage } from "../src/threads/journal-pages.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";

const meta = { provider: "fake", model: "" };

/** A journal of `n` user messages m0..m(n-1), one millisecond apart. */
function journalOf(n: number): Journal {
  const j = new Journal(join(tempDir(), "j.jsonl"));
  for (let i = 0; i < n; i++) j.put(`m${i}`, { case: "text", value: { role: Role.USER, text: `t${i}` } }, { ...meta, now: 1000 + i });
  return j;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("journal pages", () => {
  it("sends everything when the tail holds it", () => {
    const page = tailPage(journalOf(3).all(), 5);
    expect(ids(page.items)).toEqual(["m0", "m1", "m2"]);
    expect(page.earlier).toBe("");
  });

  it("sends the newest items first and pages back to the start without gaps or repeats", () => {
    const all = journalOf(25).all();
    const first = tailPage(all, 10);
    expect(ids(first.items)).toEqual(["m15", "m16", "m17", "m18", "m19", "m20", "m21", "m22", "m23", "m24"]);
    const seen = [...ids(first.items)];
    let mark = first.earlier;
    while (mark !== "") {
      const page = earlierPage(all, mark, 10);
      expect(page).toBeDefined();
      seen.unshift(...ids(page?.items ?? []));
      mark = page?.earlier ?? "";
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  it("keeps a page boundary when an earlier item gets a new revision meanwhile", () => {
    const j = journalOf(6);
    const first = tailPage(j.all(), 3);
    j.update("m1", (b) => {
      if (b.case === "text") b.value.text = "edited";
    });
    const rest = earlierPage(j.all(), first.earlier, 10);
    expect(ids(rest?.items ?? [])).toEqual(["m0", "m1", "m2"]);
  });

  it("adds the latest conversation break and pending prompts left before the tail", () => {
    const j = journalOf(3);
    const brk = conversationBreakItem(1, "s");
    j.put(brk.id, brk.body, { ...meta, now: 1003 });
    j.put("ask", { case: "approval", value: { toolId: "t", state: PromptState.PENDING } }, { ...meta, now: 1004 });
    j.put("done", { case: "approval", value: { toolId: "t", state: PromptState.ANSWERED } }, { ...meta, now: 1005 });
    for (let i = 0; i < 5; i++) j.put(`n${i}`, { case: "text", value: { role: Role.USER, text: `n${i}` } }, { ...meta, now: 2000 + i });
    const page = tailPage(j.all(), 3);
    expect(ids(page.items)).toEqual([brk.id, "ask", "n2", "n3", "n4"]);
    expect(page.earlier).not.toBe("");
  });

  it("puts the current conversation after earlier ones even when it keeps older times", () => {
    const j = new Journal(join(tempDir(), "j.jsonl"));
    j.put("late-old", { case: "text", value: { role: Role.USER, text: "x" } }, { ...meta, now: 5000 });
    const brk = conversationBreakItem(1, "s");
    j.put(brk.id, brk.body, { ...meta, now: 5001 });
    // A conversation the CLI went back to is written again after the break with its own, older times.
    j.put("resumed", { case: "text", value: { role: Role.USER, text: "y" } }, { ...meta, now: 100 });
    expect(ids(tailPage(j.all(), 1).items)).toEqual([brk.id, "resumed"]);
  });

  it("keeps paging where it was after a later break (a /clear): no page of items the device already holds", () => {
    const j = journalOf(6);
    const first = tailPage(j.all(), 3);
    const brk = conversationBreakItem(1, "s");
    j.put(brk.id, brk.body, { ...meta, now: 3000 });
    expect(ids(earlierPage(j.all(), first.earlier, 10)?.items ?? [])).toEqual(["m0", "m1", "m2"]);
  });

  it("refuses a mark it did not make and bounds page sizes", () => {
    expect(earlierPage(journalOf(2).all(), "nonsense", 10)).toBeUndefined();
    expect(earlierPage(journalOf(2).all(), "0:2:1:a", 10)).toBeUndefined();
    expect(earlierPage(journalOf(2).all(), "0:1:x:a", 10)).toBeUndefined();
    expect(pageSize(0)).toBeGreaterThan(0);
    expect(pageSize(100_000)).toBe(MAX_PAGE);
  });
});

describe("subscribe with a tail", () => {
  it("answers a fresh device with the newest items and pages the rest on request", async () => {
    const { core, work } = makeCore([fakeProvider()]);
    const t = await core.create({ provider: "fake", model: "", dir: work, text: "hi", consent: { sensitive: false, projectSettings: false }, device: "d" });
    await until(core, t.id, (i) => byCase(i, "turn").length > 0 && byCase(i, "text").length > 1);
    const total = core.snapshot(t.id).length;
    const fresh = core.subscribe(t.id, undefined, 1);
    expect(fresh.items.length).toBeLessThan(total);
    expect(fresh.earlier).not.toBe("");
    const rest = core.earlier(t.id, fresh.earlier, 500);
    expect(new Set([...ids(rest.items), ...ids(fresh.items)]).size).toBe(total);
    expect(rest.earlier).toBe("");
    // No tail: everything, as older devices expect.
    expect(core.subscribe(t.id, undefined).items).toHaveLength(total);
    expect(() => core.earlier(t.id, "bad", 10)).toThrow();
    await core.stop();
  });
});

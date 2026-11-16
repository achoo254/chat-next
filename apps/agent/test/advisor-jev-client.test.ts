// Advisor's call to Jev, against a fake fetch (never the real service): the
// request shape Jev takes, the key only in the Authorization header, the
// answer mapped back to the options' order, and every failure a fixed message.
import { describe, expect, it } from "vitest";
import { JEV_MODEL, JEV_URL, JevError, type WeighBody, jevRequest, weigh } from "../src/advisor/jev-client.ts";

const KEY = "ts_live_0123456789abcdefABCDEF0123456789abcdef";
const BODY: WeighBody = { kind: "decision", question: "Which cache?", options: ["Redis", "In-memory map"], context: "A small API" };

type Seen = { url: string; init: RequestInit };

function fakeFetch(answer: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const s = { url: String(url), init: init ?? {} };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  return { fetch: fn, seen };
}

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A fetch that never answers until its signal aborts. */
const hanging = fakeFetch(
  (s) =>
    new Promise<Response>((_, reject) => {
      s.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
);

describe("jevRequest", () => {
  it("one choice question, criteria an object of option id to text (an array would be refused)", () => {
    const req = jevRequest(BODY);
    expect(req).toEqual({
      model: JEV_MODEL,
      state: { kind: "decision", context: "A small API" },
      questions: { q: { type: "choice", instructions: "Which cache?", criteria: { o1: "Redis", o2: "In-memory map" } } },
    });
  });
});

describe("weigh", () => {
  it("posts to Jev with the key as a Bearer and maps the answer to the options' order", async () => {
    const f = fakeFetch(() => json(200, { answers: { q: { choice: "o2", probabilities: { o1: 0.25, o2: 0.75 }, confidence: 0.8 } } }));
    const answer = await weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch });
    expect(answer).toEqual({ choice: 1, probabilities: [0.25, 0.75], confidence: 0.8 });
    expect(f.seen[0]?.url).toBe(JEV_URL);
    expect(f.seen[0]?.init.method).toBe("POST");
    expect((f.seen[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // The key travels only in the header, never in the body.
    expect(String(f.seen[0]?.init.body)).not.toContain(KEY);
  });

  it("a probability Jev leaves out is 0", async () => {
    const f = fakeFetch(() => json(200, { answers: { q: { choice: "o1", probabilities: { o1: 0.9 }, confidence: 0.7 } } }));
    expect((await weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch })).probabilities).toEqual([0.9, 0]);
  });

  it.each([
    [401, "key_invalid"],
    [403, "key_invalid"],
    [429, "timeout"],
    [500, "timeout"],
    [503, "timeout"],
    [422, "unavailable"],
  ] as const)("HTTP %i is %s, with a fixed message", async (status, kind) => {
    const f = fakeFetch(() => json(status, { error: `echo ${KEY}` }));
    const err = await weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevError);
    expect((err as JevError).kind).toBe(kind);
    expect((err as JevError).message).not.toContain(KEY);
    expect((err as JevError).message).not.toContain("echo");
  });

  it("an answer it cannot read, or a choice that is no option, is unavailable", async () => {
    for (const value of [{}, { answers: { q: { choice: "o9", probabilities: {}, confidence: 1 } } }, { answers: { q: { choice: "o1" } } }]) {
      const f = fakeFetch(() => json(200, value));
      await expect(weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch })).rejects.toMatchObject({ kind: "unavailable" });
    }
    const text = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(weigh(BODY, KEY, new AbortController().signal, { fetch: text.fetch })).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("gives up after the timeout", async () => {
    await expect(weigh(BODY, KEY, new AbortController().signal, { fetch: hanging.fetch, timeoutMs: 30 })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("stops when the turn is interrupted", async () => {
    const stop = new AbortController();
    const pending = weigh(BODY, KEY, stop.signal, { fetch: hanging.fetch });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ kind: "interrupted" });
    const already = new AbortController();
    already.abort();
    await expect(weigh(BODY, KEY, already.signal, { fetch: hanging.fetch })).rejects.toMatchObject({ kind: "interrupted" });
  });

  it("a service that cannot be reached is unavailable, not late", async () => {
    const f = fakeFetch(() => Promise.reject(new Error(`connect failed ${KEY}`)));
    const err = await weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
    expect((err as Error).message).not.toContain(KEY);
  });

  it("lets go of the body of a refused answer", async () => {
    for (const status of [401, 429, 503, 422]) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull: (c) => c.enqueue(new TextEncoder().encode("x")),
        cancel: () => {
          cancelled = true;
        },
      });
      const f = fakeFetch(() => new Response(stream, { status }));
      await expect(weigh(BODY, KEY, new AbortController().signal, { fetch: f.fetch })).rejects.toBeInstanceOf(JevError);
      expect(cancelled).toBe(true);
    }
  });
});

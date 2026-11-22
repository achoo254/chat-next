// The OTLP receiver: only POST /v1/logs with the token, from no browser
// (no Origin, exact Host, no preflight); answers 200 before it filters;
// another service's records and a record too large are dropped alone and
// counted; a taken port is not traded for another; stopping filters what
// waits and closes the port; a thousand requests in a row barely hold the
// event loop up.
import { Agent, type OutgoingHttpHeaders, createServer, request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FilteredOtelRecord } from "../../src/observatory/privacy/filtered-record.ts";
import { OtlpReceiver, type OtlpReceiverOptions } from "../../src/observatory/receiver/otlp-receiver.ts";
import { OTLP_PORT_MAX, OTLP_PORT_MIN, listenOn, pickFreePort } from "../../src/observatory/receiver/receiver-port.ts";
import { type ReceiverTokens, tokenMatch } from "../../src/observatory/receiver/receiver-token.ts";
import { OTEL_LOGS, otelLog, otlpBody } from "./observatory-payloads.ts";

const TOKEN = "a".repeat(64);
let tokens: ReceiverTokens = { current: TOKEN, previous: "b".repeat(64) };
const running: OtlpReceiver[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

async function receiver(over: Partial<OtlpReceiverOptions> = {}): Promise<{ r: OtlpReceiver; got: FilteredOtelRecord[] }> {
  const port = await pickFreePort();
  if (port === undefined) throw new Error("no free port in the OTLP range");
  const got: FilteredOtelRecord[] = [];
  const r = new OtlpReceiver({ port, tokens: () => tokens, known: () => [], onRecords: (recs) => got.push(...recs), problems: () => undefined, ...over });
  running.push(r);
  expect(await r.start()).toBe("listening");
  return { r, got };
}

type Reply = { status: number; body: string };

function send(port: number, opts: { method?: string; path?: string; headers?: OutgoingHttpHeaders; body?: string; agent?: Agent }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...opts.headers };
    const req = request({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/v1/logs", headers, agent: opts.agent ?? false }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(opts.body ?? JSON.stringify(otlpBody(OTEL_LOGS)));
  });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Waits until `done()` holds, checking every 10 ms, at most `ms`; fails naming `what` (a large body is filtered off the request, later under load). */
async function waitUntil(done: () => boolean, what: () => string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("who the receiver answers", () => {
  it("refuses a wrong or missing token with 401, accepts the previous one and counts its use", async () => {
    const { r, got } = await receiver({ now: () => 1_234 });
    expect((await send(r.port, { headers: { authorization: `Bearer ${"c".repeat(64)}` } })).status).toBe(401);
    expect((await send(r.port, { headers: { authorization: "" } })).status).toBe(401);
    expect(r.stats.unauthorized).toBe(2);
    expect((await send(r.port, { headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(200);
    expect(r.stats).toMatchObject({ previousToken: 1, previousTokenLastAt: 1_234 });
    await settle();
    expect(got.length).toBe(3);
  });

  it("reads the tokens for every request: a rotation or a revoke reaches the running receiver", async () => {
    const saved = tokens;
    try {
      const { r } = await receiver();
      tokens = { current: "d".repeat(64), previous: TOKEN };
      expect((await send(r.port, { headers: { authorization: `Bearer ${"d".repeat(64)}` } })).status).toBe(200);
      expect((await send(r.port, {})).status).toBe(200);
      tokens = { current: "d".repeat(64) };
      expect((await send(r.port, {})).status).toBe(401);
      expect(tokenMatch(TOKEN, tokens)).toBeUndefined();
    } finally {
      tokens = saved;
    }
  });

  it("refuses a browser: an Origin, another Host, a preflight; and anything but POST /v1/logs as JSON", async () => {
    const { r } = await receiver();
    expect((await send(r.port, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await send(r.port, { headers: { host: `localhost:${r.port}` } })).status).toBe(403);
    expect((await send(r.port, { headers: { host: `evil.example:${r.port}` } })).status).toBe(403);
    expect((await send(r.port, { method: "OPTIONS" })).status).toBe(405);
    expect((await send(r.port, { path: "/v1/metrics" })).status).toBe(404);
    expect((await send(r.port, { method: "GET" })).status).toBe(405);
    expect((await send(r.port, { headers: { "content-type": "application/x-protobuf" } })).status).toBe(415);
    expect(r.stats).toMatchObject({ refused: 7, unauthorized: 0, requests: 0 });
  });
});

describe("what the receiver keeps", () => {
  it("answers 200 and passes on only Claude Code's kept events, counting the rest", async () => {
    const { r, got } = await receiver();
    expect(await send(r.port, {})).toEqual({ status: 200, body: "{}" });
    expect((await send(r.port, { body: JSON.stringify(otlpBody(OTEL_LOGS, "user-app")) })).status).toBe(200);
    expect((await send(r.port, { body: "{not json" })).status).toBe(200);
    await settle();
    expect(got.map((g) => g.event)).toEqual(["api_request", "tool_result", "subagent_completed"]);
    expect(r.stats).toMatchObject({ requests: 3, received: 3, ignored: 1, otherService: OTEL_LOGS.length, malformed: 1 });
  });

  it("drops a record too large alone, and a body past the limit whole", async () => {
    const { r, got } = await receiver({ maxBodyBytes: 600 * 1024 });
    const huge = otelLog("api_request", [{ key: "model", value: { stringValue: "m".repeat(300 * 1024) } }]);
    expect((await send(r.port, { body: JSON.stringify(otlpBody([huge, ...OTEL_LOGS])) })).status).toBe(200);
    expect((await send(r.port, { body: JSON.stringify(otlpBody([huge, huge, huge])) })).status).toBe(413);
    await waitUntil(() => got.length >= 3 && r.stats.tooLarge >= 2, () => `3 records taken and 2 counted too large (now ${got.length} taken, ${r.stats.tooLarge} too large)`);
    // A moment more: nothing beyond that may come.
    await settle();
    expect(got).toHaveLength(3);
    expect(r.stats.tooLarge).toBe(2);
  });
});

describe("the receiver's port and lifecycle", () => {
  it("does not move off a taken port: it tries the same port again and comes up once it is free", async () => {
    const port = await pickFreePort();
    if (port === undefined) throw new Error("no free port");
    const holder = createServer();
    expect(await listenOn(holder, port)).toBe("listening");
    const r = new OtlpReceiver({ port, tokens: () => tokens, known: () => [], onRecords: () => undefined, problems: () => undefined, relistenEveryMs: 50 });
    running.push(r);
    expect(await r.start()).toBe("port-taken");
    await new Promise((res) => setTimeout(res, 150));
    expect(r.state).toBe("port-taken");
    expect(r.port).toBe(port);
    await new Promise<void>((res) => holder.close(() => res()));
    for (let i = 0; i < 40 && r.state !== "listening"; i++) await new Promise((res) => setTimeout(res, 25));
    expect(r.state).toBe("listening");
    expect((await send(port, {})).status).toBe(200);
    expect(port).toBeGreaterThanOrEqual(OTLP_PORT_MIN);
    expect(port).toBeLessThanOrEqual(OTLP_PORT_MAX);
  });

  it("stops trying a taken port when it stops", async () => {
    const port = await pickFreePort();
    if (port === undefined) throw new Error("no free port");
    const holder = createServer();
    expect(await listenOn(holder, port)).toBe("listening");
    const r = new OtlpReceiver({ port, tokens: () => tokens, known: () => [], onRecords: () => undefined, problems: () => undefined, relistenEveryMs: 20 });
    expect(await r.start()).toBe("port-taken");
    await r.stop();
    await new Promise<void>((res) => holder.close(() => res()));
    await new Promise((res) => setTimeout(res, 100));
    expect(r.state).toBe("stopped");
    await expect(send(port, {})).rejects.toThrow();
  });

  it("filters what waits when it stops, and closes the port", async () => {
    const { r, got } = await receiver();
    const replies = await Promise.all(Array.from({ length: 5 }, () => send(r.port, {})));
    expect(replies.every((x) => x.status === 200)).toBe(true);
    await r.stop();
    expect(got).toHaveLength(15);
    expect(r.queueDepth).toBe(0);
    await expect(send(r.port, {})).rejects.toThrow();
  });

  it("answers a thousand requests in a row without holding the event loop up more than a few ms", async () => {
    const { r, got } = await receiver();
    const agent = new Agent({ keepAlive: true, maxSockets: 4 });
    const body = JSON.stringify(otlpBody(OTEL_LOGS));
    // The longest the event loop goes between two turns, measured with setImmediate: no timer resolution in it
    // (Windows rounds timers to about 16 ms, which would hide everything below that).
    let last = performance.now();
    let longest = 0;
    let measuring = true;
    const turn = (): void => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (measuring) setImmediate(turn);
    };
    setImmediate(turn);
    for (let i = 0; i < 1_000; i++) await send(r.port, { body, agent });
    await settle();
    measuring = false;
    agent.destroy();
    expect(got).toHaveLength(3_000);
    expect(r.stats.requests).toBe(1_000);
    // The client's requests and the receiver share this event loop; one turn still stays within a few ms.
    expect(longest).toBeLessThan(10);
    console.log(`receiver: 1000 requests, longest event loop turn ${longest.toFixed(2)} ms`);
  }, 60_000);
});

// advisor_weigh in tunelo's MCP: only a session tunelo opened has it, it is
// refused while Advisor is off for the thread or no key is kept, and Jev (a
// fake fetch here, never the real service) only ever gets the checked body.
// The key reaches no log line, tool result or session environment.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { ADVISOR_OFF_REFUSAL, type AdvisorHooks, advisorResultOf, isAdvisorWeigh } from "../src/advisor/advisor-tools.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { forgetSecrets, rememberSecret, secretVariants } from "../src/mcp/redact.ts";
import { sessionMcpLaunch } from "../src/mcp/session-mcp-launch.ts";
import { tempDir } from "./harness.ts";

const KEY = "ts_live_9d1e5b3a7c2f4e6a8b0d1c3e5f7a9b2c4d6e8f0a";
const ASK = { kind: "decision", question: "Rebase or merge?", options: ["Rebase", "Merge"], context: "Push was rejected" };

afterEach(() => forgetSecrets());

const textOf = (r: CallToolResult): string => (r.content[0]?.type === "text" ? r.content[0].text : "");

/** A machine with Advisor: on or off for every thread, a key or none, and a fake Jev that records what it got. */
function setup(opts: { on?: boolean; key?: string; status?: number; answer?: unknown; hang?: boolean } = {}) {
  const bodies: string[] = [];
  const headers: Record<string, string>[] = [];
  const lines: string[] = [];
  const calls: AbortController[] = [];
  const fetchFake = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    if (opts.hang) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const answer = opts.answer ?? { answers: { q: { choice: "o1", probabilities: { o1: 0.85, o2: 0.15 }, confidence: 0.8 } } };
    return new Response(JSON.stringify(answer), { status: opts.status ?? 200 });
  }) as typeof fetch;
  const hooks: AdvisorHooks = {
    allowed: () => opts.on ?? true,
    key: async () => opts.key,
    call: async (_threadId, run) => {
      const c = new AbortController();
      calls.push(c);
      return run(c.signal);
    },
    isSensitive: () => false,
    jev: { fetch: fetchFake, timeoutMs: 1_000 },
  };
  const dir = tempDir("advisor-tools-");
  const host = new McpHost(dir, { advisor: () => hooks, localWrites: () => false, enabledGroups: () => [], log: (l) => lines.push(l) });
  const ticket = host.tickets.issue("thread-a");
  const id = host.open("https://tunnel.example", ticket);
  return { host, id, bodies, headers, lines, calls };
}

describe("advisor_weigh", () => {
  it("is not offered to a client tunelo did not start (no ticket)", async () => {
    const { host } = setup({ key: KEY });
    const local = host.open("https://tunnel.example");
    const r = await host.call(local, "advisor", "advisor_weigh", ASK);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/only offered in a session tunelo opened/);
  });

  it("is refused while Advisor is off for the thread", async () => {
    const { host, id, bodies } = setup({ on: false, key: KEY });
    const r = await host.call(id, "advisor", "advisor_weigh", ASK);
    expect(r.isError).toBe(true);
    expect(advisorResultOf(textOf(r))).toMatchObject({ advisor: "error", error: "off", message: ADVISOR_OFF_REFUSAL });
    expect(bodies).toEqual([]);
  });

  it("is refused without a key", async () => {
    const { host, id, bodies } = setup({});
    const r = await host.call(id, "advisor", "advisor_weigh", ASK);
    expect(advisorResultOf(textOf(r))).toMatchObject({ error: "no_key" });
    expect(bodies).toEqual([]);
  });

  it("weighs the options with the user's key and says what was sent", async () => {
    rememberSecret(KEY);
    const { host, id, bodies, headers, lines } = setup({ key: KEY });
    const r = await host.call(id, "advisor", "advisor_weigh", ASK);
    expect(r.isError).toBeFalsy();
    expect(advisorResultOf(textOf(r))).toMatchObject({
      advisor: "verdict",
      kind: "decision",
      verdict: "confident",
      choice: "Rebase",
      options: [
        { text: "Rebase", probability: 0.85 },
        { text: "Merge", probability: 0.15 },
      ],
      sent: { kind: "decision", question: "Rebase or merge?", options: ["Rebase", "Merge"], context: "Push was rejected" },
    });
    expect(headers[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ model: "jev-latest", questions: { q: { criteria: { o1: "Rebase", o2: "Merge" } } } });
    for (const form of secretVariants(KEY)) {
      expect(textOf(r)).not.toContain(form);
      expect(lines.join("\n")).not.toContain(form);
    }
    expect(lines).toContain("mcp thread-a: advisor advisor_weigh ok");
  });

  it("a secret value tunelo holds never reaches Jev", async () => {
    rememberSecret("my-saved-github-password");
    const { host, id, bodies } = setup({ key: KEY });
    await host.call(id, "advisor", "advisor_weigh", { ...ASK, context: "login with my-saved-github-password failed" });
    expect(bodies[0]).not.toContain("my-saved-github-password");
    expect(bodies[0]).toContain("[hidden]");
  });

  it("a request shaped like a secret is refused and nothing is sent", async () => {
    const { host, id, bodies } = setup({ key: KEY });
    const r = await host.call(id, "advisor", "advisor_weigh", { ...ASK, context: "remote https://x:glpat-abcdefghij0123456789xy@gitlab.example.com" });
    expect(advisorResultOf(textOf(r))).toMatchObject({ error: "refused" });
    expect(textOf(r)).not.toContain("glpat-");
    expect(bodies).toEqual([]);
  });

  it('an option that starts with "/" or "!" is refused, for every kind', async () => {
    const { host, id, bodies } = setup({ key: KEY });
    for (const kind of ["decision", "next_steps", "answer"]) {
      for (const bad of ["/compact", "!rm -rf build"]) {
        const r = await host.call(id, "advisor", "advisor_weigh", { ...ASK, kind, options: ["Fine", bad] });
        expect(advisorResultOf(textOf(r))).toMatchObject({ error: "invalid" });
      }
    }
    expect(bodies).toEqual([]);
  });

  it("arguments outside the limits are refused before anything runs", async () => {
    const { host, id, bodies } = setup({ key: KEY });
    for (const args of [
      { ...ASK, options: ["only one"] },
      { ...ASK, options: ["a", "b", "c", "d", "e", "f"] },
      { ...ASK, question: "x".repeat(301) },
      { ...ASK, options: ["x".repeat(81), "b"] },
      { ...ASK, context: "x".repeat(601) },
      { ...ASK, kind: "plan" },
    ]) {
      expect((await host.call(id, "advisor", "advisor_weigh", args)).isError).toBe(true);
    }
    expect(bodies).toEqual([]);
  });

  it("a refused key: key_invalid with a fixed message, what was sent kept", async () => {
    const { host, id } = setup({ key: KEY, status: 401 });
    const r = await host.call(id, "advisor", "advisor_weigh", ASK);
    expect(advisorResultOf(textOf(r))).toMatchObject({ error: "key_invalid", sent: { question: "Rebase or merge?" } });
    expect(textOf(r)).not.toContain(KEY);
  });

  it("stops when the core aborts the call (the turn was interrupted)", async () => {
    const { host, id, calls } = setup({ key: KEY, hang: true });
    const pending = host.call(id, "advisor", "advisor_weigh", ASK);
    await new Promise((r) => setTimeout(r, 20));
    calls[0]?.abort();
    expect(advisorResultOf(textOf(await pending))).toMatchObject({ error: "interrupted" });
  });

  it("a session's environment never carries the key", () => {
    rememberSecret(KEY);
    const launch = sessionMcpLaunch({ ticket: "t-1", configDir: "/cfg" });
    expect(JSON.stringify(launch)).not.toContain(KEY);
    expect(Object.keys(launch.env).sort()).toEqual(["TUNELO_HOME", "TUNELO_MCP_TICKET"]);
  });
});

describe("advisorResultOf and isAdvisorWeigh", () => {
  const result = { advisor: "error", error: "timeout", message: "late" };

  it("finds the tool's JSON however the AI reports it", () => {
    const text = JSON.stringify(result);
    expect(advisorResultOf(text)).toEqual(result);
    expect(advisorResultOf(`Tool output:\n${text}\n`)).toEqual(result);
    expect(advisorResultOf(JSON.stringify([{ type: "text", text }]))).toEqual(result);
    expect(advisorResultOf(JSON.stringify({ output: text }))).toEqual(result);
    expect(advisorResultOf("Invalid arguments: too small")).toBeUndefined();
    expect(advisorResultOf(JSON.stringify({ advisor: "verdict", kind: "other" }))).toBeUndefined();
  });

  it("knows the tool under each AI's prefix only", () => {
    expect(isAdvisorWeigh("mcp__tunelo__advisor_weigh")).toBe(true);
    expect(isAdvisorWeigh("mcp_tunelo_advisor_weigh")).toBe(true);
    expect(isAdvisorWeigh("advisor_weigh")).toBe(false);
    expect(isAdvisorWeigh("mcp__other__advisor_weigh")).toBe(false);
  });
});

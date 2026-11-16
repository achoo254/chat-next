// Advisor's threads stay out of sight: a device that never said it knows them
// (an older web) neither lists them nor hears their status; the machine's
// session list, its sessions' folders and the office leave them out; the
// session's MCP has Advisor's tools only; over the link only the device that
// asked stops a question; and a question answered while nobody looks asks
// for one content-free push.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, ErrorReason, type Frame, ThreadKind, TurnState } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { usageApiOf } from "../src/link/usage-link.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { Ledger } from "../src/usage/ledger.ts";
import { Machine } from "../src/machine.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { sessionMcpLaunch } from "../src/mcp/session-mcp-launch.ts";
import { ADVISOR_MCP_ENV } from "../src/mcp/session-tickets.ts";
import { officeHubFor } from "../src/office/office-hub.ts";
import type { AgentProvider, LocalSession, ProviderEvent, SessionHistory, SessionQuery } from "../src/providers/types.ts";
import type { AdvisorHooks } from "../src/advisor/advisor-tools.ts";
import { Channel } from "../src/util/channel.ts";
import { fakeProvider } from "./fake-provider.ts";
import { byCase, makeCore, tempDir, until } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";

const lease = () => ({ ticket: "t-1", configDir: "/cfg", approveWrite: () => undefined, describeWrite: async () => undefined, release: () => undefined });

/** An AI for Advisor's threads that answers each question at once; "gate" waits for the test. */
function advisorAi(history?: SessionHistory): AgentProvider & { open: () => void } {
  const base = fakeProvider("adv");
  let release: () => void = () => undefined;
  return {
    ...base,
    open: () => release(),
    capabilities: { ...base.capabilities, sessionMcp: true, advisorSession: true },
    ...(history ? { history } : {}),
    async start() {
      const events = new Channel<ProviderEvent>();
      events.push({ type: "session", sessionId: "adv-session" });
      let chain = Promise.resolve();
      let n = 0;
      return {
        events,
        async send(text) {
          chain = chain.then(async () => {
            n += 1;
            // The question is the line after tunelo's first one.
            const question = text.split("\n")[1] ?? "";
            if (question.startsWith("gate")) await new Promise<void>((r) => (release = r));
            if (question.startsWith("fail")) return events.push({ type: "turn-end", state: "failed", durationMs: 1 });
            events.push({ type: "text", blockId: `b${n}`, role: "assistant", text: "answer" });
            events.push({ type: "turn-end", state: "completed", durationMs: 1 });
          });
        },
        async interrupt() {
          release();
        },
        async close() {
          events.close();
        },
      };
    },
  };
}

const statusOf = (frames: readonly Frame[], threadId: string) => frames.filter((f) => f.body.case === "threadStatus" && f.body.value.thread?.id === threadId);

describe("over the link", () => {
  it("an older device neither lists nor hears an Advisor thread; one that says it knows them does", async () => {
    const dir = tempDir("adv-hidden-");
    const ai = advisorAi();
    const { core, audit, work } = makeCore([ai], { sessionMcp: lease, more: { isKnownFolder: () => true } });
    const config = new ConfigStore(dir);
    const asker = await pairedDevice({ core, config, audit });
    const older = await pairedDevice({ core, config, audit });
    const created = await asker.request("c1", { case: "threadCreate", value: { provider: "adv", dir: work, kind: ThreadKind.ADVISOR } });
    if (created.body.case !== "threadCreated") throw new Error(`not created: ${created.body.case}`);
    const id = created.body.value.thread?.id ?? "";
    expect(created.body.value.thread).toMatchObject({ kind: ThreadKind.ADVISOR, archived: true });

    const sent = await asker.request("s1", { case: "threadSend", value: { threadId: id, text: "gate why?", clientMsgId: "q-1" } });
    expect(sent.body.case).toBe("ack");
    // Another device may not stop the asker's question.
    const refused = await older.request("i1", { case: "threadInterrupt", value: { threadId: id, clientMsgId: "q-1" } });
    expect(refused.body.case).toBe("error");
    ai.open();
    await until(core, id, (i) => byCase(i, "turn").some((t) => t.body.value.state === TurnState.COMPLETED));

    const listed = await older.request("l1", { case: "threadList", value: {} });
    expect(listed.body.case === "threadListResult" && listed.body.value.threads.map((t) => t.id)).toEqual([]);
    expect(statusOf(older.received, id)).toEqual([]);
    expect(statusOf(asker.received, id).length).toBeGreaterThan(0);

    const aware = await older.request("l2", { case: "threadList", value: { advisor: true } });
    expect(aware.body.case === "threadListResult" && aware.body.value.threads.map((t) => [t.id, t.kind])).toEqual([[id, ThreadKind.ADVISOR]]);
    asker.close();
    older.close();
    await core.stop();
  });

  it("the asker stops its own question; a question names its id on an Advisor thread", async () => {
    const dir = tempDir("adv-hidden-");
    const ai = advisorAi();
    const { core, audit, work } = makeCore([ai], { sessionMcp: lease, more: { isKnownFolder: () => true } });
    const asker = await pairedDevice({ core, config: new ConfigStore(dir), audit });
    const created = await asker.request("c1", { case: "threadCreate", value: { provider: "adv", dir: work, kind: ThreadKind.ADVISOR } });
    const id = created.body.case === "threadCreated" ? (created.body.value.thread?.id ?? "") : "";
    await asker.request("s1", { case: "threadSend", value: { threadId: id, text: "gate why?", clientMsgId: "q-1" } });
    const noId = await asker.request("i0", { case: "threadInterrupt", value: { threadId: id } });
    expect(noId.body.case).toBe("error");
    const stopped = await asker.request("i1", { case: "threadInterrupt", value: { threadId: id, clientMsgId: "q-1" } });
    expect(stopped.body.case).toBe("ack");
    await until(core, id, (i) => byCase(i, "turn").every((t) => t.body.value.state !== TurnState.RUNNING));
    // Attachments on an ordinary thread are refused.
    const plain = await asker.request("c2", { case: "threadCreate", value: { provider: "adv", dir: work, text: "" } });
    const plainId = plain.body.case === "threadCreated" ? (plain.body.value.thread?.id ?? "") : "";
    const wrong = await asker.request("s2", { case: "threadSend", value: { threadId: plainId, text: "hi", clientMsgId: "m", advisorAttachments: [{ text: "x" }] } });
    expect(wrong.body.case).toBe("error");
    asker.close();
    await core.stop();
  });

  it("a sensitive folder: NEEDS_CONSENT until the device sends the user's consent", async () => {
    const dir = tempDir("adv-hidden-");
    const { core, audit, home } = makeCore([advisorAi()], { sessionMcp: lease, more: { isKnownFolder: () => true } });
    const device = await pairedDevice({ core, config: new ConfigStore(dir), audit });
    const ssh = join(home, ".ssh");
    const asked = await device.request("c1", { case: "threadCreate", value: { provider: "adv", dir: ssh, kind: ThreadKind.ADVISOR } });
    expect(asked.body.case === "error" && [asked.body.value.code, asked.body.value.reason]).toEqual([ErrorCode.NEEDS_CONSENT, ErrorReason.SENSITIVE_FOLDER]);
    const agreed = await device.request("c2", { case: "threadCreate", value: { provider: "adv", dir: ssh, kind: ThreadKind.ADVISOR, consent: { sensitive: true } } });
    expect(agreed.body.case).toBe("threadCreated");
    device.close();
    await core.stop();
  });
});

describe("on the machine", () => {
  it("the AI's session list leaves Advisor's sessions out and never opens one; the office has none", async () => {
    const queries: SessionQuery[] = [];
    const advisorSession: LocalSession = { sessionId: "adv-session", dir: "/w", title: "Advisor", updatedAt: 1, messages: 1, entrypoint: "", busy: false };
    const history: SessionHistory = {
      list: (q) => {
        queries.push(q);
        return { sessions: [], total: 0, dirs: [] };
      },
      find: (id) => (id === "adv-session" ? advisorSession : undefined),
      end: () => undefined,
      read: () => undefined,
    };
    const ai = advisorAi(history);
    const { core, work } = makeCore([ai], { sessionMcp: lease, more: { isKnownFolder: () => true } });
    const t = await core.createAdvisor({ provider: "adv", model: "", dir: work, consent: { sensitive: false }, device: "phone" });
    await core.send(t.id, "why?", "q-1", [], { attachments: [], device: "phone" });
    await until(core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
    await core.localSessions({ provider: "adv", dir: "", query: "", offset: 0, limit: 10 });
    expect([...(queries[0]?.exclude ?? [])]).toEqual(["adv-session"]);
    await expect(core.openLocal({ provider: "adv", sessionId: "adv-session", consent: { sensitive: false, projectSettings: false }, openAnyway: true, device: "phone" })).rejects.toMatchObject({
      reason: ErrorReason.SESSION_NOT_FOUND,
    });
    expect(() => officeHubFor(core, [ai]).watch(t.id, () => undefined)).toThrow(/no such thread/);
    expect(core.accountStates().map((s) => s.threadId)).not.toContain(t.id);
    await core.stop();
  });

  it("the session's MCP: Advisor's tools only, the rest refused; `tunelo mcp` told to list them alone", async () => {
    const dir = tempDir("adv-mcp-");
    const { core, work } = makeCore([advisorAi()], { sessionMcp: lease, more: { isKnownFolder: () => true } });
    const t = await core.createAdvisor({ provider: "adv", model: "", dir: work, consent: { sensitive: false }, device: "phone" });
    const plain = await core.create({ provider: "adv", model: "", dir: work, text: "", consent: { sensitive: false, projectSettings: false }, device: "phone" });
    const hooks: AdvisorHooks = {
      allowed: (id) => core.advisorAllowed(id),
      key: async () => undefined,
      call: (id, run) => core.advisorCall(id, run),
      isSensitive: () => false,
      sessionDir: (id) => core.advisorSessionDir(id),
      git: async () => Promise.reject(new Error("unused")),
    };
    const host = new McpHost(dir, { advisor: () => hooks, localWrites: () => false });
    const advisorTicket = host.tickets.issue(t.id);
    const session = host.open("https://tunnel.example", advisorTicket);
    const refused = await host.call(session, "tunnels", "tunnel_list", {});
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("only has advisor_weigh, advisor_git and advisor_grep");
    const weigh = await host.call(session, "advisor", "advisor_weigh", { kind: "answer", question: "Why?", options: ["A", "B"] });
    expect(JSON.stringify(weigh.content)).toContain("no_key");
    // An ordinary session's advisor_git says it is not for it.
    const other = host.open("https://tunnel.example", host.tickets.issue(plain.id));
    expect(JSON.stringify((await host.call(other, "advisor", "advisor_git", { command: "status" })).content)).toContain("only for Advisor's own session");
    // The core's own word decides, even without Advisor's hooks: an Advisor thread's session gets no other tool.
    const bare = new McpHost(dir, { isAdvisorThread: (id) => id === t.id, localWrites: () => false });
    const closed = bare.open("https://tunnel.example", bare.tickets.issue(t.id));
    expect((await bare.call(closed, "tunnels", "tunnel_list", {})).isError).toBe(true);
    expect(sessionMcpLaunch({ ticket: "t", configDir: "/c", advisorSession: true }).env[ADVISOR_MCP_ENV]).toBe("1");
    expect(sessionMcpLaunch({ ticket: "t", configDir: "/c" }).env[ADVISOR_MCP_ENV]).toBeUndefined();
    await core.stop();
  });

  it("an answer nobody looks at asks for one content-free push; Advisor's threads never count as needing the user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tunelo-adv-push-"));
    try {
      const ai = advisorAi();
      const mcp = new McpHost(dir, { localWrites: () => false });
      const machine = new Machine({ config: new ConfigStore(dir), providers: [ai], mcp, log: () => undefined });
      let pushes = 0;
      machine.setNotifyAdvisor(async () => {
        pushes += 1;
      });
      const work = tempDir("adv-push-work-");
      machine.projects.add({ dir: work, name: "work", sensitive: false, device: "phone" });
      const t = await machine.core.createAdvisor({ provider: "adv", model: "", dir: work, consent: { sensitive: false }, device: "phone" });
      await machine.core.send(t.id, "why?", "q-1", [], { attachments: [], device: "phone" });
      await until(machine.core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.COMPLETED));
      await new Promise((r) => setTimeout(r, 10));
      expect(pushes).toBe(1);
      // A question that failed is no answer: no push.
      await machine.core.send(t.id, "fail now", "q-2", [], { attachments: [], device: "phone" });
      await until(machine.core, t.id, (i) => byCase(i, "turn").some((x) => x.body.value.state === TurnState.FAILED));
      await new Promise((r) => setTimeout(r, 10));
      expect(pushes).toBe(1);
      expect(machine.core.openSessionsOf("adv").map((s) => s.title)).toEqual(["a background session"]);
      expect((await machine.machineInfo()).recentDirs).not.toContain(work);
      await machine.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the AI usage statistics leave Advisor's sessions out", async () => {
    const root = tempDir("adv-usage-");
    const ledger = new Ledger(join(root, "config", "usage"));
    const at = new Date(2026, 10, 3, 10).getTime();
    const stats = { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} };
    const turn = (key: string, sessionId: string, input: number) => ({ key, sessionId, subagent: false, at, model: "m", cwd: "/work/app", inputTokens: input, outputTokens: 1, tools: [] });
    await ledger.apply("claude", { path: "/fake/a.jsonl", dev: 1, ino: 1, size: 1, mtimeMs: 1 }, { turns: [turn("k1", "work-1", 1000), turn("k2", "ADV-1", 500_000)], end: 1, stats }, () => "example.com/team/app");
    await ledger.save();
    const config = new ConfigStore(join(root, "config"));
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const api = usageApiOf({ ledger, config, audit, deleteLedger: () => ledger.delete(), hiddenSessions: () => new Set(["adv-1"]) });
    const report = await api.report({ from: "2026-11-03", to: "2026-11-03" });
    expect(report.days.map((d) => [d.input, d.sessions])).toEqual([[1000, 1]]);
    expect(report.suggestions.map((x) => x.sessionId)).not.toContain("ADV-1");
  });
});

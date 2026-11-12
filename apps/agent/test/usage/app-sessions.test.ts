// The core tells which AI sessions this machine opened (a chat thread, its
// CLI in the terminal), for the ledger's "calls through the app".
import { TurnState } from "@achoo254/chat-proto/remote/remote";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCore } from "../../src/core/agent-core.ts";
import type { AgentProvider } from "../../src/providers/types.ts";
import { AuditLog } from "../../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../../src/safety/sensitive-paths.ts";
import { fakeProvider } from "../fake-provider.ts";
import { byCase, tempDir, until } from "../harness.ts";

describe("sessions the app opened", () => {
  it("reports the session id of a chat thread and of its CLI opened in the terminal, and lists them", async () => {
    const root = tempDir("app-sessions-");
    const home = join(root, "home");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const seen: [string, string][] = [];
    const provider: AgentProvider = {
      ...fakeProvider(),
      terminal: { command: async (req) => ({ file: "/opt/fake-ai", args: req.resumeId ? ["--resume", req.resumeId] : [], env: {} }) },
    };
    const core = new AgentCore({
      dataDir: join(root, "data"),
      providers: [provider],
      audit: new AuditLog(join(root, "audit.jsonl")),
      isSensitive: createSensitiveCheck({ home }),
      trash: async () => undefined,
      onSessionId: (p, id) => seen.push([p, id]),
    });
    const t = await core.create({ provider: provider.id, model: "", dir: work, text: "hello", consent: { sensitive: false, projectSettings: false }, device: "test" });
    await until(core, t.id, (items) => byCase(items, "turn").some((x) => x.body.value.state !== TurnState.RUNNING));
    const chatId = seen[0]?.[1];
    expect(chatId).toBeTruthy();
    expect(seen.every(([p]) => p === provider.id)).toBe(true);
    seen.length = 0;
    await core.terminalLaunch(t.id);
    expect(seen).toEqual([[provider.id, chatId]]);
    expect(core.sessionIds()).toEqual([{ provider: provider.id, sessionId: chatId }]);
    await core.stop();
  });
});

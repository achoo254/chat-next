import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { AgentCore, type CoreOptions } from "../src/core/agent-core.ts";
import type { AgentProvider } from "../src/providers/types.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { createSensitiveCheck } from "../src/safety/sensitive-paths.ts";

export function tempDir(prefix = "agent-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeCore(
  providers: AgentProvider[],
  opts: { dataDir?: string; home?: string; maxSessions?: number; trusted?: (dir: string) => boolean; trust?: CoreOptions["trust"]; sessionMcp?: CoreOptions["sessionMcp"]; trash?: CoreOptions["trash"] } = {},
) {
  const root = tempDir();
  const home = opts.home ?? join(root, "home");
  const work = join(home, "work");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(work, { recursive: true });
  const dataDir = opts.dataDir ?? join(root, "data");
  const audit = new AuditLog(join(root, "audit.jsonl"));
  const core = new AgentCore({
    dataDir,
    providers,
    audit,
    isSensitive: createSensitiveCheck({ home }),
    maxSessions: opts.maxSessions ?? 3,
    ...(opts.trusted ? { isTrusted: opts.trusted } : {}),
    ...(opts.trust ? { trust: opts.trust } : {}),
    ...(opts.sessionMcp ? { sessionMcp: opts.sessionMcp } : {}),
    // Tests never touch the real trash.
    trash: opts.trash ?? (async () => undefined),
  });
  return { core, audit, home, work, dataDir };
}

/** Resolves with the thread's items once `done` holds (checked on every change). */
export function until(core: AgentCore, threadId: string, done: (items: Item[]) => boolean, ms = 3000): Promise<Item[]> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const items = core.snapshot(threadId);
      if (done(items)) {
        off();
        offStatus();
        clearTimeout(timer);
        resolve(items);
      }
    };
    const off = core.onItems((id) => id === threadId && check());
    const offStatus = core.onStatus((s: ThreadSummary) => s.id === threadId && check());
    const timer = setTimeout(() => {
      off();
      offStatus();
      reject(new Error(`timeout; items: ${JSON.stringify(core.snapshot(threadId).map((i) => [i.id, i.body.case]))}`));
    }, ms);
    check();
  });
}

export const byCase = <C extends NonNullable<Item["body"]["case"]>>(items: Item[], c: C) =>
  items.filter((i) => i.body.case === c) as (Item & { body: Extract<Item["body"], { case: C }> })[];

// Shared pieces of the Observatory store tests: a database path in a fresh
// temp folder, and one complete session's writes.
import { join } from "node:path";
import { ObservatoryStore } from "../../src/observatory/store/observatory-store.ts";
import type { WriteOp } from "../../src/observatory/store/write-ops.ts";
import { tempDir } from "../harness.ts";

export const DAY = 24 * 60 * 60_000;

/** A database path in a new temp folder; the observatory folder itself does not exist yet. */
export function tempDbPath(): string {
  return join(tempDir("observatory-"), "observatory", "observatory.db");
}

export async function openTempStore(): Promise<ObservatoryStore> {
  return ObservatoryStore.open({ path: tempDbPath() });
}

/** Every kind of write for one session `id` at `at`, in project `project`. */
export function sessionOps(id: string, at: number, project = "github.com/acme/app"): WriteOp[] {
  return [
    { kind: "session", row: { sessionId: id, source: "terminal", startedAt: at, projectKey: project, cwd: "~/work/app", mainModel: "claude-opus" } },
    { kind: "prompt", row: { promptId: `${id}-p1`, sessionId: id, at: at + 1, length: 42, excerpt: "fix the build" } },
    {
      kind: "toolCall",
      row: { toolUseId: `${id}-t1`, sessionId: id, promptId: `${id}-p1`, at: at + 2, toolName: "Bash", toolKind: "builtin", durationMs: 120, success: true },
    },
    { kind: "toolCall", row: { toolUseId: `${id}-t2`, sessionId: id, promptId: `${id}-p1`, at: at + 3, toolName: "Read", success: false, error: "ENOENT" } },
    { kind: "subagent", row: { agentId: `${id}-a1`, sessionId: id, promptId: `${id}-p1`, agentType: "Explore", startedAt: at + 4, model: "claude-haiku", totalTokens: 900 } },
    {
      kind: "apiRequest",
      row: {
        dedupeKey: `${id}-r1`,
        sessionId: id,
        promptId: `${id}-p1`,
        at: at + 5,
        model: "claude-opus",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWrite5mTokens: 40,
        cacheWrite1hTokens: 5,
        costUsd: 0.25,
        durationMs: 900,
        ttftMs: 300,
        querySource: "repl_main_thread",
      },
    },
    { kind: "instructionLoaded", row: { sessionId: id, seq: 0, at: at + 6, filePath: "~/work/app/CLAUDE.md", memoryType: "Project", loadReason: "session_start" } },
    { kind: "gitOp", row: { sessionId: id, promptId: `${id}-p1`, at: at + 7, sha: "abc1234", branch: "main", kind: "commit" } },
  ];
}

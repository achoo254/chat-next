// A made-up Claude folder for the usage tests: projects/<folder>/<session>.jsonl
// and <folder>/<session>/subagents/agent-<id>.jsonl, with records in the
// shape Claude Code 2.1 writes them. Every value here is invented; MARKER is
// put in every message, tool input and tool result so a test can prove the
// ledger never keeps any of them.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "zz-private-marker-7f3a";

export type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };

export type ReplyOptions = {
  sessionId: string;
  msgId: string;
  /** Absent: the record has no requestId. */
  requestId?: string;
  at: string;
  cwd?: string;
  model?: string;
  usage?: Usage | null;
  /** Tool calls in the reply, by name; `skill` goes into a Skill call's input. */
  tools?: { name: string; skill?: string }[];
  agentId?: string;
  blockType?: string;
};

export function replyRecord(o: ReplyOptions): string {
  const content: object[] = [];
  if (o.blockType) content.push({ type: o.blockType, data: MARKER });
  else content.push({ type: "text", text: `answer ${MARKER}` });
  for (const t of o.tools ?? []) {
    content.push({ type: "tool_use", id: `toolu_${t.name}`, name: t.name, input: t.skill ? { skill: t.skill, args: MARKER } : { command: `echo ${MARKER}` } });
  }
  const u = o.usage === undefined ? { input: 3, cacheRead: 1000, cacheWrite: 100, output: 50 } : o.usage;
  const message: Record<string, unknown> = { model: o.model ?? "claude-test-model", id: o.msgId, type: "message", role: "assistant", content };
  if (u) {
    message.usage = {
      input_tokens: u.input ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
      cache_read_input_tokens: u.cacheRead ?? 0,
      output_tokens: u.output ?? 0,
      service_tier: "standard",
    };
  }
  const rec: Record<string, unknown> = {
    parentUuid: null,
    isSidechain: o.agentId !== undefined,
    ...(o.agentId ? { agentId: o.agentId } : {}),
    message,
    ...(o.requestId ? { requestId: o.requestId } : {}),
    type: "assistant",
    uuid: `${o.msgId}-${o.requestId ?? "x"}`,
    timestamp: o.at,
    userType: "external",
    entrypoint: "cli",
    cwd: o.cwd ?? "/work/example-repo",
    sessionId: o.sessionId,
    version: "2.1.319",
    gitBranch: "main",
  };
  return JSON.stringify(rec);
}

export function userRecord(sessionId: string, at: string): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: `question ${MARKER} "type":"assistant"` }, uuid: `u-${at}`, timestamp: at, sessionId, cwd: "/work/example-repo" });
}

export function toolResultRecord(sessionId: string, at: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Bash", content: `output ${MARKER}` }] }, timestamp: at, sessionId });
}

export const projectsOf = (home: string) => join(home, "projects");

/** The main transcript of a session in folder `folder` of `home`. */
export function mainFile(home: string, folder: string, sessionId: string): string {
  const dir = join(projectsOf(home), folder);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.jsonl`);
}

/** A subagent's transcript under the parent session `sessionId`. */
export function subagentFile(home: string, folder: string, sessionId: string, agentId: string, nested?: string): string {
  const dir = join(projectsOf(home), folder, sessionId, "subagents", ...(nested ? [nested] : []));
  mkdirSync(dir, { recursive: true });
  return join(dir, `agent-${agentId}.jsonl`);
}

export function writeLines(file: string, lines: string[], end = "\n"): void {
  writeFileSync(file, lines.join("\n") + (lines.length ? end : ""));
}

export function appendLines(file: string, lines: string[], end = "\n"): void {
  appendFileSync(file, lines.join("\n") + end);
}

/** `n` minutes after a fixed start, as an ISO time. */
export const minute = (n: number) => new Date(Date.parse("2026-11-01T08:00:00.000Z") + n * 60_000).toISOString();

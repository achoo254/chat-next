// What a session's subagents do, from Claude Code's own record of them, for
// the office view of a session the machine does not run (a terminal, an
// IDE): <session>/subagents/agent-<id>.meta.json (kind, description, the
// tool call that started it, depth, background, finished) and the tail of
// agent-<id>.jsonl (tool calls by name, their results' ok, token counts);
// agents of a workflow sit one folder deeper (subagents/workflows/<id>/).
// Also the token counts of the session's own transcript.
//
// Only names, ids, times and counts are taken, as in usage-scan.ts: a line
// is read field by field (usage-json.ts), never decoded whole, and a tool's
// input is looked into only for a shell's command (to pick a room on the
// machine) and a subagent's kind. Neither format has official docs: a field
// missing or of another type is skipped, a file that cannot be read is
// passed over, and nothing here throws.
import { type Dirent, lstatSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionUsageCall, SubagentActivity, SubagentReport, SubagentToolCall } from "../types.ts";
import { toolKind } from "./tool-map.ts";
import { JsonCursor } from "./usage-json.ts";
import { LINE_CAP, parseUsageLine, readLines } from "./usage-scan.ts";

/** How deep the subagents' folder goes (workflows nest one level more), as usage-scan.ts. */
const SUBAGENT_DEPTH = 4;
/** The end of a subagent's transcript read the first time. */
const AGENT_TAIL_BYTES = 4 * 1024 * 1024;
/** The end of the session's own transcript read the first time, for token counts. */
const MAIN_TAIL_BYTES = 64 * 1024 * 1024;
const META_MAX_BYTES = 64 * 1024;
/** Tool calls kept per subagent (the newest). */
const TOOLS_KEPT = 8;
/** Tool call ids remembered per subagent, to find who started a nested one. */
const IDS_KEPT = 2_000;
/** Sessions whose reads are remembered at once. */
const SESSIONS_KEPT = 16;
const CALLS_KEPT = 200_000;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.(meta\.json|jsonl)$/;
const NAME_MAX = 200;

type FilePos = { pos: number; size: number };

type AgentState = {
  agentId: string;
  workflowId: string;
  metaPath?: string;
  metaMtime: number;
  logPath?: string;
  log?: FilePos;
  meta: { agentType: string; description: string; toolUseId: string; spawnDepth: number; background: boolean; finished: boolean };
  /** The newest tool calls, oldest first, with when each ended (0 while open). */
  tools: (SubagentToolCall & { doneAt: number })[];
  ids: Set<string>;
  updatedAt: number;
};

type SessionState = { main?: FilePos; agents: Map<string, AgentState>; calls: Map<string, SessionUsageCall> };

// eslint-disable-next-line no-control-regex
const clean = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, NAME_MAX);
const str = (v: unknown): string => (typeof v === "string" ? clean(v) : "");

/** A plain folder or file (never a link) and its size and change time. */
function plain(path: string, dir: boolean): { size: number; mtimeMs: number } | undefined {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) return undefined;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

type Block = { type: string; id: string; name: string; command?: string; toolUseId: string; isError: boolean };
type Line = { type: string; at: number; blocks: Block[] };

/** Reads a tool_use's input for a shell's command only; every other field is stepped over. */
function pickInput(c: JsonCursor, block: Block): void {
  c.object((k) => {
    if (k === "command" && c.peek() === '"') block.command = c.string();
  });
}

function pickBlock(c: JsonCursor): Block | undefined {
  if (c.peek() !== "{") return undefined;
  const b: Block = { type: "", id: "", name: "", toolUseId: "", isError: false };
  c.object((k) => {
    if ((k === "type" || k === "id" || k === "name" || k === "tool_use_id") && c.peek() === '"') {
      const v = c.string();
      if (k === "tool_use_id") b.toolUseId = v;
      else b[k] = v;
    } else if (k === "is_error") b.isError = c.scalar() === true;
    else if (k === "input" && c.peek() === "{") pickInput(c, b);
  });
  // The command is kept for a shell only (read on the machine to pick a room, never sent).
  if (b.command !== undefined && (b.type !== "tool_use" || toolKind(b.name) !== "shell")) delete b.command;
  return b;
}

/** The top-level type, time and content blocks (tool calls and results) of one record; undefined when it is not one. */
export function parseAgentLine(line: Buffer): Line | undefined {
  const out: Line = { type: "", at: Number.NaN, blocks: [] };
  try {
    const c = new JsonCursor(line);
    c.object((key) => {
      if ((key === "type" || key === "timestamp") && c.peek() === '"') {
        const v = c.string();
        if (key === "type") out.type = v;
        else out.at = Date.parse(v);
      } else if (key === "message" && c.peek() === "{") {
        c.object((k) => {
          if (k !== "content" || c.peek() !== "[") return;
          c.array(() => {
            const b = pickBlock(c);
            if (b) out.blocks.push(b);
          });
        });
      }
    });
  } catch {
    return undefined;
  }
  return out.type === "assistant" || out.type === "user" ? out : undefined;
}

function parseMeta(path: string): AgentState["meta"] | undefined {
  try {
    const st = plain(path, false);
    if (!st || st.size > META_MAX_BYTES) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const m = raw as Record<string, unknown>;
    const depth = typeof m.spawnDepth === "number" && Number.isInteger(m.spawnDepth) && m.spawnDepth > 0 ? m.spawnDepth : 1;
    return {
      agentType: str(m.agentType).slice(0, 60),
      description: str(m.description),
      toolUseId: str(m.toolUseId),
      spawnDepth: depth,
      background: m.requestShape === "background",
      finished: m.finished === true || m.stoppedByUser === true,
    };
  } catch {
    return undefined;
  }
}

/** Reads the subagents of Claude Code's sessions for the office view; one per machine's Claude folders. */
export class ClaudeSubagentFeed {
  private readonly sessions = new Map<string, SessionState>();

  /** `transcriptOf`: the path of a session's transcript (<id>.jsonl); undefined when there is none. */
  constructor(private readonly transcriptOf: (sessionId: string) => string | undefined) {}

  async read(sessionId: string, since: number): Promise<SubagentReport> {
    try {
      const transcript = this.transcriptOf(sessionId);
      if (!transcript) return { subagents: [], usage: [] };
      const s = this.session(sessionId);
      await this.readMain(s, transcript);
      const folder = transcript.slice(0, -".jsonl".length);
      await this.walk(s, join(folder, "subagents"), SUBAGENT_DEPTH, "");
      for (const a of s.agents.values()) await this.readAgent(s, a);
      return { subagents: this.report(s, since), usage: [...s.calls.values()].filter((c) => c.at >= since) };
    } catch {
      return { subagents: [], usage: [] };
    }
  }

  private session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (s) {
      // Most recently used last.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, s);
      return s;
    }
    s = { agents: new Map(), calls: new Map() };
    this.sessions.set(sessionId, s);
    if (this.sessions.size > SESSIONS_KEPT) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return s;
  }

  /** Token counts of the session's own transcript, from where the last read ended. */
  private async readMain(s: SessionState, path: string): Promise<void> {
    const st = plain(path, false);
    if (!st) return;
    s.main = await this.readFrom(path, st.size, s.main, MAIN_TAIL_BYTES, (line) => this.addCall(s, line, false));
  }

  private async walk(s: SessionState, dir: string, depth: number, workflowId: string): Promise<void> {
    if (depth <= 0 || !plain(dir, true)) return;
    for (const e of await entries(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        // subagents/workflows/<workflow id>/agent-<id>.*
        const wf = basename(dir) === "workflows" ? clean(e.name) : workflowId;
        await this.walk(s, path, depth - 1, wf);
        continue;
      }
      const m = AGENT_FILE.exec(e.name);
      if (!m?.[1] || !e.isFile()) continue;
      const key = `${workflowId}/${m[1]}`;
      let a = s.agents.get(key);
      if (!a) {
        a = {
          agentId: m[1],
          workflowId,
          metaMtime: -1,
          meta: { agentType: "", description: "", toolUseId: "", spawnDepth: 1, background: false, finished: false },
          tools: [],
          ids: new Set(),
          updatedAt: 0,
        };
        s.agents.set(key, a);
      }
      if (m[2] === "jsonl") a.logPath = path;
      else a.metaPath = path;
    }
  }

  private async readAgent(s: SessionState, a: AgentState): Promise<void> {
    if (a.metaPath) {
      const st = plain(a.metaPath, false);
      if (st && st.mtimeMs !== a.metaMtime) {
        const meta = parseMeta(a.metaPath);
        a.metaMtime = st.mtimeMs;
        if (meta) {
          a.meta = meta;
          a.updatedAt = Math.max(a.updatedAt, st.mtimeMs);
        }
      }
    }
    if (!a.logPath) return;
    const st = plain(a.logPath, false);
    if (!st) return;
    a.log = await this.readFrom(a.logPath, st.size, a.log, AGENT_TAIL_BYTES, (line) => {
      this.addCall(s, line, true);
      const rec = parseAgentLine(line);
      if (rec) this.addRecord(a, rec);
    });
  }

  /** Reads the whole lines of `path` after the last read (the first time, its last `tail` bytes). */
  private async readFrom(path: string, size: number, last: FilePos | undefined, tail: number, onLine: (line: Buffer) => void): Promise<FilePos> {
    // Rewritten shorter: start over from its end.
    const from = last && size >= last.pos ? last.pos : Math.max(0, size - tail);
    if (from >= size) return { pos: from, size };
    const stats = { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} };
    const pos = await readLines(path, from, LINE_CAP, stats, onLine);
    return { pos, size };
  }

  private addCall(s: SessionState, line: Buffer, subagent: boolean): void {
    const stats = { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} };
    const turn = parseUsageLine(line, subagent, stats);
    if (!turn || s.calls.has(turn.key)) return;
    if (s.calls.size >= CALLS_KEPT) {
      const oldest = s.calls.keys().next().value;
      if (oldest !== undefined) s.calls.delete(oldest);
    }
    s.calls.set(turn.key, { key: turn.key, at: turn.at, inputTokens: turn.inputTokens ?? 0, outputTokens: turn.outputTokens ?? 0 });
  }

  private addRecord(a: AgentState, rec: Line): void {
    const at = Number.isFinite(rec.at) ? rec.at : 0;
    for (const b of rec.blocks) {
      if (rec.type === "assistant" && b.type === "tool_use" && b.id && b.name) {
        if (a.ids.size >= IDS_KEPT) a.ids.clear();
        a.ids.add(b.id);
        if (a.tools.some((t) => t.toolId === b.id)) continue;
        const name = clean(b.name);
        a.tools.push({ toolId: b.id, name, kind: toolKind(name), at, done: false, ok: true, doneAt: 0, ...(b.command !== undefined ? { command: b.command } : {}) });
        if (a.tools.length > TOOLS_KEPT) a.tools.shift();
        a.updatedAt = Math.max(a.updatedAt, at);
      } else if (rec.type === "user" && b.type === "tool_result" && b.toolUseId) {
        const t = a.tools.find((x) => x.toolId === b.toolUseId);
        if (!t || t.done) continue;
        t.done = true;
        t.ok = !b.isError;
        t.doneAt = at;
        a.updatedAt = Math.max(a.updatedAt, at);
      }
    }
  }

  /** Every subagent read so far, with its tool calls that started, ended or still run at or after `since`. */
  private report(s: SessionState, since: number): SubagentActivity[] {
    const ownerOf = (toolUseId: string): string => {
      for (const a of s.agents.values()) if (a.meta.toolUseId !== toolUseId && a.ids.has(toolUseId)) return a.meta.toolUseId;
      return "";
    };
    const out: SubagentActivity[] = [];
    for (const a of s.agents.values()) {
      // An agent with neither record nor id cannot be told apart from another one: skip it.
      if (!a.metaPath && !a.logPath) continue;
      const toolUseId = a.meta.toolUseId;
      if (!toolUseId && !a.workflowId) continue;
      out.push({
        // A workflow's agent has no tool call of its own: an id from its workflow and agent.
        toolUseId: toolUseId || `workflow:${a.workflowId}/${a.agentId}`,
        agentType: a.meta.agentType,
        description: a.meta.description,
        spawnDepth: a.meta.spawnDepth,
        parentToolUseId: toolUseId ? ownerOf(toolUseId) : "",
        workflowId: a.workflowId,
        background: a.meta.background,
        finished: a.meta.finished,
        updatedAt: a.updatedAt,
        tools: a.tools.filter((t) => !t.done || t.at >= since || t.doneAt >= since).map(({ doneAt: _doneAt, ...t }) => t),
      });
    }
    return out;
  }
}

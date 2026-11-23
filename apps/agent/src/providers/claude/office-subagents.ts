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
// passed over (and logged, rate-limited), and nothing here throws.
//
// Reading is bounded (docs/office-wire.md, part 9): a byte budget for the
// first read of a session and for each later one, only the newest agents'
// logs followed, a finished agent left alone once its files stop changing,
// and a folder listed again only when it changed.
import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readLinesUntil } from "../../activity/bounded-lines.ts";
import { type ProblemSink as OfficeLog, ProblemLog as OfficeProblems } from "../../activity/problem-log.ts";
import type { SessionUsageCall, SubagentActivity, SubagentReport, SubagentToolCall } from "../types.ts";
import { type Line, clean, parseAgentLine } from "./office-subagent-lines.ts";
import { toolKind } from "./tool-map.ts";
import { LINE_CAP, parseUsageLine } from "./usage-scan.ts";

export { parseAgentLine } from "./office-subagent-lines.ts";

/** How deep the subagents' folder goes (workflows nest one level more), as usage-scan.ts. */
const SUBAGENT_DEPTH = 4;
/** The end of a subagent's transcript read the first time; a log further behind than this skips to it. */
const AGENT_TAIL_BYTES = 4 * 1024 * 1024;
/** The end of the session's own transcript read the first time, for token counts. */
const MAIN_TAIL_BYTES = 64 * 1024 * 1024;
/** All subagents' logs together, on the first read of a session (newest agents first). */
const FIRST_AGENTS_BUDGET = 32 * 1024 * 1024;
/** Everything read on each later read of a session (its transcript and the subagents' logs). */
const POLL_BUDGET = 2 * 1024 * 1024;
/** Agents whose record (meta.json) is looked at, the newest first. */
const AGENTS_CONSIDERED = 256;
/** Agents whose log is followed, the newest first. */
const AGENTS_FOLLOWED = 32;
/** Every agent's files are looked at again at least this often (a finished subagent may be resumed). */
const RESCAN_MS = 30_000;
/** A finished agent whose files have not changed for this long is not read any more. */
const STALE_FINISHED_MS = 10 * 60_000;
const META_MAX_BYTES = 64 * 1024;
/** Ended tool calls kept per subagent (the newest); open ones are kept until they end, up to OPEN_TOOLS_MAX. */
const TOOLS_KEPT = 8;
const OPEN_TOOLS_MAX = 64;
/** Tool call ids remembered per subagent, to find who started a nested one. */
const IDS_KEPT = 2_000;
/** Sessions whose reads are remembered at once. */
const SESSIONS_KEPT = 16;
const CALLS_KEPT = 200_000;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.(meta\.json|jsonl)$/;

type FileInfo = { size: number; mtimeMs: number };

type AgentState = {
  agentId: string;
  workflowId: string;
  metaPath?: string;
  metaFile?: FileInfo;
  /** The meta.json change time last read (-1: never). */
  metaReadAt: number;
  logPath?: string;
  logFile?: FileInfo;
  /** Where the next read of the log starts; undefined before the first. */
  logPos?: number;
  /** The log's size when a read last reached its end: while the size stays so, there is nothing new (a line not finished yet is not read again). */
  logReadSize?: number;
  meta: { agentType: string; description: string; toolUseId: string; spawnDepth: number; background: boolean; finished: boolean };
  /** Tool calls, oldest first, with when each ended (0 while open). */
  tools: (SubagentToolCall & { doneAt: number })[];
  ids: Set<string>;
  updatedAt: number;
};

/** A folder of the subagents' tree as last listed. */
type Listing = { mtimeMs: number; files: { name: string; path: string }[]; dirs: string[] };

type SessionState = {
  mainPos?: number;
  /** As AgentState.logReadSize, for the session's own transcript. */
  mainReadSize?: number;
  agents: Map<string, AgentState>;
  calls: Map<string, SessionUsageCall>;
  listings: Map<string, Listing>;
  /** When every agent's files were last looked at (0: never). */
  rankedAt: number;
};

const str = (v: unknown): string => (typeof v === "string" ? clean(v) : "");
const newest = (a: AgentState): number => Math.max(a.metaFile?.mtimeMs ?? 0, a.logFile?.mtimeMs ?? 0);
const isMissing = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

/** Reads the subagents of Claude Code's sessions for the office view; one per machine's Claude folders. */
export class ClaudeSubagentFeed {
  private readonly sessions = new Map<string, SessionState>();
  private readonly problems: OfficeProblems;

  /** `transcriptOf`: the path of a session's transcript (<id>.jsonl); undefined when there is none. */
  constructor(
    private readonly transcriptOf: (sessionId: string) => string | undefined,
    log: OfficeLog = (line) => console.log(line),
    private readonly now: () => number = Date.now,
  ) {
    this.problems = new OfficeProblems(log, now);
  }

  async read(sessionId: string, since: number): Promise<SubagentReport> {
    try {
      const transcript = this.transcriptOf(sessionId);
      if (!transcript) return { subagents: [], usage: [] };
      const s = this.session(sessionId);
      const first = s.mainPos === undefined;
      const usedMain = await this.readMain(s, transcript, first);
      const folder = transcript.slice(0, -".jsonl".length);
      const listed = await this.walk(s, join(folder, "subagents"), SUBAGENT_DEPTH, "");
      await this.readAgents(s, listed, first ? FIRST_AGENTS_BUDGET : Math.max(0, POLL_BUDGET - usedMain));
      return { subagents: this.report(s, since), usage: [...s.calls.values()].filter((c) => c.at >= since) };
    } catch (err) {
      this.problems.report("subagent records", err);
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
    s = { agents: new Map(), calls: new Map(), listings: new Map(), rankedAt: 0 };
    this.sessions.set(sessionId, s);
    if (this.sessions.size > SESSIONS_KEPT) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    return s;
  }

  /** A plain folder or file (never a link) and its size and change time; undefined when there is none. */
  private async plain(path: string, dir: boolean): Promise<FileInfo | undefined> {
    let st: Stats;
    try {
      st = await lstat(path);
    } catch (err) {
      if (!isMissing(err)) this.problems.report("subagent file", err);
      return undefined;
    }
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) return undefined;
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  /** Lines of a file from `from`, none starting at or past `end`: where the next read starts, and the bytes read; undefined when it could not be read. */
  private async lines(path: string, from: number, end: number, onLine: (line: Buffer) => void): Promise<{ next: number; bytesRead: number } | undefined> {
    try {
      return await readLinesUntil(path, from, end, LINE_CAP, onLine);
    } catch (err) {
      if (!isMissing(err)) this.problems.report("subagent log", err);
      return undefined;
    }
  }

  /** Token counts of the session's own transcript, from where the last read ended; the bytes read. */
  private async readMain(s: SessionState, path: string, first: boolean): Promise<number> {
    const st = await this.plain(path, false);
    if (!st) {
      s.mainPos ??= 0;
      return 0;
    }
    // The first time (or rewritten shorter, or far behind): from its last MAIN_TAIL_BYTES.
    if (!first && s.mainReadSize === st.size) return 0;
    let from = s.mainPos ?? 0;
    if (first || from > st.size || st.size - from > MAIN_TAIL_BYTES) from = Math.max(0, st.size - MAIN_TAIL_BYTES);
    const end = first ? st.size : Math.min(st.size, from + POLL_BUDGET);
    const stats = { records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} };
    const read = await this.lines(path, from, end, (line) => this.addCall(s, parseUsageLine(line, false, stats)));
    // Not read: tried again next time, from the same place.
    if (!read) {
      s.mainPos ??= from;
      return 0;
    }
    const { next, bytesRead } = read;
    s.mainPos = next;
    if (end >= st.size) s.mainReadSize = st.size;
    else delete s.mainReadSize;
    return bytesRead;
  }

  /** Lists the subagents' tree, a folder again only when it changed; true when any listing changed. */
  private async walk(s: SessionState, dir: string, depth: number, workflowId: string): Promise<boolean> {
    if (depth <= 0) return false;
    const st = await this.plain(dir, true);
    if (!st) return false;
    let listing = s.listings.get(dir);
    let changed = false;
    if (!listing || listing.mtimeMs !== st.mtimeMs) {
      listing = await this.list(dir, st.mtimeMs);
      s.listings.set(dir, listing);
      changed = true;
      for (const f of listing.files) this.agentFile(s, f.name, f.path, workflowId);
    }
    for (const sub of listing.dirs) {
      // subagents/workflows/<workflow id>/agent-<id>.*
      const wf = basename(dir) === "workflows" ? clean(basename(sub)) : workflowId;
      if (await this.walk(s, sub, depth - 1, wf)) changed = true;
    }
    return changed;
  }

  private async list(dir: string, mtimeMs: number): Promise<Listing> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isMissing(err)) this.problems.report("subagent folder", err);
      entries = [];
    }
    const listing: Listing = { mtimeMs, files: [], dirs: [] };
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) listing.dirs.push(path);
      else if (e.isFile() && AGENT_FILE.test(e.name)) listing.files.push({ name: e.name, path });
    }
    return listing;
  }

  private agentFile(s: SessionState, name: string, path: string, workflowId: string): void {
    const m = AGENT_FILE.exec(name);
    if (!m?.[1]) return;
    const key = `${workflowId}/${m[1]}`;
    let a = s.agents.get(key);
    if (!a) {
      a = {
        agentId: m[1],
        workflowId,
        metaReadAt: -1,
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

  /**
   * Looks at the agents' files and reads what changed, within `budget` bytes
   * of logs: every agent's files when the tree changed or RESCAN_MS passed
   * (the newest AGENTS_CONSIDERED), else only the followed ones.
   */
  private async readAgents(s: SessionState, listed: boolean, budget: number): Promise<void> {
    const now = this.now();
    const all = [...s.agents.values()];
    const rescan = listed || now - s.rankedAt >= RESCAN_MS;
    if (rescan) {
      s.rankedAt = now;
      await Promise.all(all.map((a) => this.statAgent(a)));
      const considered = all.sort((x, y) => newest(y) - newest(x)).slice(0, AGENTS_CONSIDERED);
      for (const a of considered) await this.readMeta(a);
    }
    const followed = [...s.agents.values()]
      .filter((a) => a.logPath && !(a.meta.finished && now - newest(a) > STALE_FINISHED_MS))
      .sort((x, y) => newest(y) - newest(x))
      .slice(0, AGENTS_FOLLOWED);
    let left = budget;
    for (const a of followed) {
      if (left <= 0) break;
      if (!rescan) {
        await this.statAgent(a);
        await this.readMeta(a);
      }
      left -= await this.readLog(s, a, left);
    }
  }

  private async statAgent(a: AgentState): Promise<void> {
    if (a.metaPath) {
      const st = await this.plain(a.metaPath, false);
      if (st) a.metaFile = st;
      else delete a.metaFile;
    }
    if (a.logPath) {
      const st = await this.plain(a.logPath, false);
      if (st) a.logFile = st;
      else delete a.logFile;
    }
  }

  private async readMeta(a: AgentState): Promise<void> {
    const st = a.metaFile;
    if (!a.metaPath || !st || st.mtimeMs === a.metaReadAt) return;
    a.metaReadAt = st.mtimeMs;
    if (st.size > META_MAX_BYTES) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(a.metaPath, "utf8"));
    } catch (err) {
      if (!isMissing(err)) this.problems.report("subagent meta", err);
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    const m = raw as Record<string, unknown>;
    const depth = typeof m.spawnDepth === "number" && Number.isInteger(m.spawnDepth) && m.spawnDepth > 0 ? m.spawnDepth : 1;
    a.meta = {
      agentType: str(m.agentType).slice(0, 60),
      description: str(m.description),
      toolUseId: str(m.toolUseId),
      spawnDepth: depth,
      background: m.requestShape === "background",
      finished: m.finished === true || m.stoppedByUser === true,
    };
    a.updatedAt = Math.max(a.updatedAt, st.mtimeMs);
  }

  /** Reads the log's new whole lines, at most about `budget` bytes; the bytes read. */
  private async readLog(s: SessionState, a: AgentState, budget: number): Promise<number> {
    const st = a.logFile;
    if (!a.logPath || !st || a.logReadSize === st.size) return 0;
    // The first time, rewritten shorter, or too far behind: from its last AGENT_TAIL_BYTES (older calls are not counted).
    let from = a.logPos ?? -1;
    if (from < 0 || from > st.size || st.size - from > AGENT_TAIL_BYTES) from = Math.max(0, st.size - AGENT_TAIL_BYTES);
    const end = Math.min(st.size, from + budget);
    const read = await this.lines(a.logPath, from, end, (line) => {
      const rec = parseAgentLine(line);
      if (!rec) return;
      this.addCall(s, rec.call);
      this.addRecord(a, rec);
    });
    if (!read) return 0;
    const { next, bytesRead } = read;
    a.logPos = next;
    if (end >= st.size) a.logReadSize = st.size;
    else delete a.logReadSize;
    return bytesRead;
  }

  private addCall(s: SessionState, call: { key: string; at: number; inputTokens?: number; outputTokens?: number } | undefined): void {
    if (!call || s.calls.has(call.key)) return;
    if (s.calls.size >= CALLS_KEPT) {
      const oldest = s.calls.keys().next().value;
      if (oldest !== undefined) s.calls.delete(oldest);
    }
    s.calls.set(call.key, { key: call.key, at: call.at, inputTokens: call.inputTokens ?? 0, outputTokens: call.outputTokens ?? 0 });
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
        this.trimTools(a);
        a.updatedAt = Math.max(a.updatedAt, at);
      } else if (rec.type === "user" && b.type === "tool_result" && b.toolUseId) {
        const t = a.tools.find((x) => x.toolId === b.toolUseId);
        if (!t || t.done) continue;
        t.done = true;
        t.ok = !b.isError;
        t.doneAt = at;
        a.updatedAt = Math.max(a.updatedAt, at);
        this.trimTools(a);
      }
    }
  }

  /** Keeps the newest TOOLS_KEPT ended calls and every open one (an open call dropped would never end), up to OPEN_TOOLS_MAX. */
  private trimTools(a: AgentState): void {
    let extraEnded = a.tools.filter((t) => t.done).length - TOOLS_KEPT;
    while (extraEnded > 0) {
      // The call that ended first goes (not the one started first: it may have just ended).
      let oldest = -1;
      for (const [i, t] of a.tools.entries()) if (t.done && (oldest < 0 || t.doneAt < (a.tools[oldest]?.doneAt ?? 0))) oldest = i;
      a.tools.splice(oldest, 1);
      extraEnded--;
    }
    while (a.tools.length > TOOLS_KEPT + OPEN_TOOLS_MAX) a.tools.shift();
  }

  /** Every subagent read so far, with its tool calls that started, ended or still run at or after `since`. */
  private report(s: SessionState, since: number): SubagentActivity[] {
    // Who made each tool call, once for all agents: a nested subagent's owner is the agent that called it.
    const ownerOf = new Map<string, string>();
    for (const a of s.agents.values()) {
      const owner = a.meta.toolUseId;
      if (!owner) continue;
      for (const id of a.ids) if (id !== owner && !ownerOf.has(id)) ownerOf.set(id, owner);
    }
    const out: SubagentActivity[] = [];
    for (const a of s.agents.values()) {
      // Nothing read of it yet (over the limits of what is read): not known.
      if (a.metaReadAt < 0 && a.logPos === undefined) continue;
      const toolUseId = a.meta.toolUseId;
      if (!toolUseId && !a.workflowId) continue;
      out.push({
        // A workflow's agent has no tool call of its own: an id from its workflow and agent.
        toolUseId: toolUseId || `workflow:${a.workflowId}/${a.agentId}`,
        agentType: a.meta.agentType,
        description: a.meta.description,
        spawnDepth: a.meta.spawnDepth,
        parentToolUseId: toolUseId ? (ownerOf.get(toolUseId) ?? "") : "",
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

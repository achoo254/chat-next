// Claude Code sessions kept on this machine: every <claude folder>/projects/
// <folder>/<session id>.jsonl, whatever started it. A list reads little of
// each file: the start (where the session began, what was asked first, what
// started it) and the end (Claude's title for it), and keeps both by file
// size and change time. The message count needs the whole file, so it is
// counted only for the sessions shown, within a byte budget per request,
// and then only for what was appended since.
//
// "Busy elsewhere" is a cheap guess: the transcript changed in the last
// minute, a running claude registered the session in <claude folder>/
// sessions/<pid>.json, or a running claude process works in the session's
// folder and that session changed since it started (running-claude.ts; this
// one also sees a claude with a Claude folder tunelo does not know, as an
// IDE may start). Only the folder and start time of the process are read.
//
// Liveness (is a turn running now?) is narrower: the transcript was written
// in the last minute, or it holds a tool call with no result yet (a long
// command writes nothing until it ends) for at most ten minutes while a
// running claude still holds the session. Whether a running claude holds the
// session at all (busy or idle) is told beside it, from the same reads.
import { type Dirent, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HistoryEntry, HistoryRead, Liveness, LocalSession, SessionHistory, SessionPage, SessionQuery } from "../types.ts";
import { ClaudeProcesses, heldSessions } from "./running-claude.ts";
import { TranscriptReader, oneLine, parseRecord, promptText, scanLines, withFile } from "./transcript.ts";

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const PROCESS_FILE = /^\d+\.json$/;
/** The start of a file read for where the session began and its first message: a small read, then a larger one. */
const HEAD_STEPS = [64 * 1024, 1024 * 1024];
const TAIL_BYTES = 64 * 1024;
/** Bytes of a line kept to tell what it is when counting. */
const COUNT_KEEP = 256 * 1024;
/** Bytes counted per list request at most. */
export const COUNT_BUDGET = 256 * 1024 * 1024;
/** The newest part of a transcript read when a session opens; a longer one starts at a user message within it. */
export const RECENT_BYTES = 8 * 1024 * 1024;
/** Longest transcript line taken in whole when reading entries (longer: a giant tool output, skipped). */
const LINE_MAX = 8 * 1024 * 1024;
const BUSY_MS = 60_000;
/** How long a tool call with no result keeps a held session busy without the transcript changing (Bash's longest timeout). */
export const TOOL_BUSY_MS = 10 * 60_000;
/** How long a request to the model with no answer yet (an api-request record after the last message) keeps a held session busy. */
export const REQUEST_BUSY_MS = 30 * 60_000;
/** A record of the conversation itself (its top-level type; nested blocks are typed text, tool_use, ...). */
const MESSAGE_TYPE = /"type":"(?:user|assistant)"/;
/** The end of a transcript read for a tool call that has no result yet. */
const TOOL_TAIL_BYTES = 256 * 1024;
/** The end of a transcript read the first time for background work: older launches are not seen. */
const BACKGROUND_TAIL_BYTES = 4 * 1024 * 1024;
/** Bytes of a line read for background work: the markers sit at its start, a long tool output after them. */
const BACKGROUND_KEEP = 8 * 1024;
const TASK_ID = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/;
const TASK_STATUS = /<status>([a-z_]+)<\/status>/;
/** What the result of a background subagent's launch says: its agentId. */
const AGENT_LAUNCHED = /Async agent launched successfully[\s\S]{0,600}?agentId: ([A-Za-z0-9]+)/;
/** What the result of a shell put in the background says (on purpose, or after its timeout): its id. */
const SHELL_BACKGROUND = /(?:moved to the background \(ID: |running in background with ID: )([A-Za-z0-9_-]+)/;
const TITLE_MAX = 120;
const DIRS_MAX = 50;
export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;

type Head = { end: number; dir: string; prompt: string; entrypoint: string };
type Tail = { size: number; mtimeMs: number; title: string };
type Count = { scanned: number; messages: number };
/**
 * What the transcript's end still waits on, as of `size`: the tool call with
 * no result yet ("" when none), and whether the model was asked after the
 * last message and has not answered (it writes nothing while it thinks).
 */
type OpenTool = { size: number; mtimeMs: number; name: string; request: boolean };
/**
 * The shells and subagents the session started in the background that its
 * transcript does not show finished, read from `pos` on (the part before it is
 * done with).
 */
type Background = { pos: number; running: Set<string> };
type Known = { file: string; sessionId: string; ino: number; size: number; mtimeMs: number; head?: Head; tail?: Tail; count?: Count; tool?: OpenTool; background?: Background };

export type LocalSessionsOptions = {
  /** Claude folders of the machine (its own, then each profile's); their projects and running sessions are read. */
  homes: () => string[];
  now?: () => number;
  /** Whether a process runs; tests replace it. */
  alive?: (pid: number) => boolean;
  /** The running Claude processes; tests replace it. */
  processes?: ClaudeProcesses;
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const caseless = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string) => (caseless ? p.toLowerCase() : p);

/** `dir` is `parent` or inside it. */
function within(dir: string, parent: string): boolean {
  const d = fold(dir).replace(/[\\/]+$/, "");
  const p = fold(parent).replace(/[\\/]+$/, "");
  return d === p || d.startsWith(`${p}/`) || d.startsWith(`${p}\\`);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A folder by its real path when it still exists (a transcript may name it through a link). */
function realDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** Compares folders, also by their real paths (each looked up once per comparer). */
function dirComparer(): (a: string, b: string) => boolean {
  const real = new Map<string, string>();
  const strip = (p: string) => fold(p).replace(/[\\/]+$/, "");
  const key = (p: string) => {
    let k = real.get(p);
    if (k === undefined) {
      k = strip(realDir(p));
      real.set(p, k);
    }
    return k;
  };
  return (a, b) => strip(a) === strip(b) || key(a) === key(b);
}

export class LocalSessions implements SessionHistory {
  private known = new Map<string, Known>();
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly processes: ClaudeProcesses;

  constructor(private readonly opts: LocalSessionsOptions) {
    this.now = opts.now ?? Date.now;
    this.alive = opts.alive ?? processAlive;
    this.processes = opts.processes ?? new ClaudeProcesses();
  }

  /** Reads the running Claude processes again when the last read is old; cheap, and never fails. */
  prime(): Promise<void> {
    return this.processes.refresh();
  }

  list(q: SessionQuery): SessionPage {
    const words = q.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching: { k: Known; head: Head; title: string }[] = [];
    const all: Known[] = [];
    for (const k of this.scan()) {
      const head = this.head(k);
      if (!head?.dir) continue;
      all.push(k);
      const title = this.title(k, head);
      if (!title) continue;
      if (words.length) {
        const text = `${title}\n${head.prompt}\n${head.dir}`.toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
      }
      matching.push({ k, head, title });
    }
    const busy = this.running(all);
    const perDir = new Map<string, number>();
    for (const m of matching) perDir.set(m.head.dir, (perDir.get(m.head.dir) ?? 0) + 1);
    const dirs = [...perDir.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, DIRS_MAX)
      .map(([dir, sessions]) => ({ dir, sessions }));
    const shown = (q.dir ? matching.filter((m) => within(m.head.dir, q.dir)) : matching).sort((a, b) => b.k.mtimeMs - a.k.mtimeMs);
    const limit = Math.min(Math.max(q.limit || PAGE_DEFAULT, 1), PAGE_MAX);
    const offset = Math.max(q.offset, 0);
    let budget = COUNT_BUDGET;
    const sessions = shown.slice(offset, offset + limit).map(({ k, head, title }) => {
      budget -= this.count(k, budget);
      return this.view(k, head, title, busy);
    });
    return { sessions, total: shown.length, dirs };
  }

  find(sessionId: string): LocalSession | undefined {
    const k = this.locate(sessionId);
    const head = k && this.head(k);
    if (!k || !head?.dir) return undefined;
    return this.view(k, head, this.title(k, head) || "", this.running([...this.known.values()]));
  }

  end(sessionId: string): number | undefined {
    return this.locate(sessionId)?.size;
  }

  /**
   * Busy while the transcript was written in the last minute; past that,
   * while a tool call has no result yet (for TOOL_BUSY_MS at most) or the
   * model has not answered the last request (for REQUEST_BUSY_MS at most)
   * and a running claude holds the session. `held` tells a running claude
   * holds it, from the processes as last read (prime() reads them again;
   * only something still to come makes this read them itself). `turnOpen`
   * tells a tool call without its result or a request without its answer,
   * however old (a long subagent, a prompt waiting for the user). Never fails.
   */
  async liveness(sessionId: string): Promise<Liveness> {
    let k: Known | undefined;
    try {
      k = this.locate(sessionId);
    } catch {
      k = undefined;
    }
    if (!k) return { state: "unknown", via: "transcript" };
    const since = Math.round(k.mtimeMs);
    const quiet = this.now() - k.mtimeMs;
    const open = this.openWork(k);
    const turnOpen = open.name !== "" || open.request;
    const work = quiet < REQUEST_BUSY_MS ? open : { name: "", request: false };
    const tool = quiet < TOOL_BUSY_MS ? work.name : "";
    // Something still to come: a tool's result, or the model's answer.
    const pending = tool !== "" || work.request;
    if (pending && quiet >= BUSY_MS) await this.processes.refresh();
    const held = this.held(k);
    const withHeld = held ? { held } : {};
    if (quiet < BUSY_MS) return { state: "busy", since, ...(tool ? { tool } : {}), ...withHeld, turnOpen, via: "transcript" };
    if (!pending) return { state: "idle", since, ...withHeld, turnOpen, via: "transcript" };
    return held ? { state: "busy", since, ...(tool ? { tool } : {}), held, turnOpen, via: "process" } : { state: "idle", since, turnOpen, via: "process" };
  }

  /**
   * Background shells and subagents started in the session with no finish
   * reported (a task-notification of theirs), from the transcript: read once
   * from its end, then only what was appended. Whether claude still runs to
   * finish them is holds(). Never fails.
   */
  backgroundTasks(sessionId: string): number {
    try {
      const k = this.locate(sessionId);
      if (!k) return 0;
      let bg = k.background;
      if (bg && k.size < bg.pos) bg = undefined;
      const first = bg === undefined;
      bg ??= { pos: Math.max(0, k.size - BACKGROUND_TAIL_BYTES), running: new Set<string>() };
      if (bg.pos < k.size) {
        const running = bg.running;
        bg.pos = withFile(k.file, (fd) => scanLines(fd, bg.pos, k.size, BACKGROUND_KEEP, (line) => noteBackground(running, line.toString("utf8")), first && bg.pos > 0));
      }
      k.background = bg;
      return bg.running.size;
    } catch {
      return 0;
    }
  }

  holds(sessionId: string): boolean {
    try {
      const k = this.locate(sessionId);
      return k !== undefined && this.held(k);
    } catch {
      return false;
    }
  }

  /** A running claude holds the session (as of the last read of the processes); never fails. */
  private held(k: Known): boolean {
    try {
      this.head(k);
      return this.running([...this.known.values()]).has(k.sessionId);
    } catch {
      return false;
    }
  }

  /**
   * The newest tool call of the conversation with no result yet, from the
   * end of the transcript ("" when none), and whether the newest message or
   * request record is a request to the model (its answer, or a message after
   * it, ends the wait); kept until the file changes. A result too long to
   * keep whole is still told by the id at its start.
   */
  private openWork(k: Known): OpenTool {
    if (k.tool && k.tool.size === k.size && k.tool.mtimeMs === k.mtimeMs) return k.tool;
    const open = new Map<string, string>();
    const resultIds = /"tool_use_id":"([^"]+)"/g;
    let request = false;
    try {
      withFile(k.file, (fd) =>
        scanLines(
          fd,
          Math.max(0, k.size - TOOL_TAIL_BYTES),
          k.size,
          COUNT_KEEP,
          (line, whole) => {
            if (!whole) {
              const head = line.subarray(0, 4096).toString("utf8");
              for (const m of head.matchAll(resultIds)) if (m[1]) open.delete(m[1]);
              // A message too long to keep whole (a huge answer or tool output) still ends a wait for the model.
              if (MESSAGE_TYPE.test(head)) request = false;
              return;
            }
            const rec = parseRecord(line);
            if (!rec || rec.isSidechain === true) return;
            if (rec.type === "api-request" || rec.type === "user" || rec.type === "assistant") request = rec.type === "api-request";
            if (!Array.isArray(rec.message?.content)) return;
            for (const block of rec.message.content as { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown }[]) {
              if (rec.type === "assistant" && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                open.delete(block.id);
                open.set(block.id, block.name);
              } else if (rec.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
                open.delete(block.tool_use_id);
              }
            }
          },
          true,
        ),
      );
    } catch {
      return { size: k.size, mtimeMs: k.mtimeMs, name: "", request: false };
    }
    k.tool = { size: k.size, mtimeMs: k.mtimeMs, name: [...open.values()].at(-1) ?? "", request };
    return k.tool;
  }

  read(sessionId: string, from: number | "recent"): HistoryRead | undefined {
    const k = this.locate(sessionId);
    const head = k && this.head(k);
    if (!k) return undefined;
    const size = k.size;
    const start = from === "recent" ? Math.max(0, size - RECENT_BYTES) : Math.min(from, size);
    const reader = new TranscriptReader(head?.dir ?? "");
    let end: number;
    try {
      end = withFile(k.file, (fd) =>
        scanLines(
          fd,
          start,
          size,
          LINE_MAX,
          (line, whole) => {
            if (!whole) return;
            const rec = parseRecord(line);
            if (rec) reader.add(rec);
          },
          from === "recent",
        ),
      );
    } catch {
      return undefined;
    }
    let entries: HistoryEntry[] = reader.entries;
    // Cut inside a long session: start with what the user asked, not halfway through an answer.
    if (from === "recent" && start > 0) {
      const first = entries.findIndex((e) => e.type === "user");
      entries = first < 0 ? [] : entries.slice(first);
    }
    return { entries, end };
  }

  /**
   * The transcript <id>.jsonl and the <id>/ folder beside it (subagents,
   * tool results), as found under a Claude folder's projects/; never a link.
   */
  sessionFiles(sessionId: string): string[] {
    const k = this.locate(sessionId);
    if (!k) return [];
    const out: string[] = [];
    const plain = (p: string, dir: boolean) => {
      try {
        const st = lstatSync(p);
        return !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile());
      } catch {
        return false;
      }
    };
    const name = basename(k.file);
    if (name.toLowerCase() !== `${k.sessionId}.jsonl` || !plain(k.file, false)) return [];
    out.push(k.file);
    const beside = join(dirname(k.file), name.slice(0, -".jsonl".length));
    if (plain(beside, true)) out.push(beside);
    return out;
  }

  // --- files -----------------------------------------------------------------

  /** Every session file, refreshed from disk (the newest copy of an id wins). */
  private scan(): Known[] {
    const found = new Map<string, Known>();
    const roots = new Set<string>();
    for (const home of this.opts.homes()) {
      let root: string;
      try {
        root = realpathSync.native(join(home, "projects"));
      } catch {
        continue;
      }
      if (roots.has(root)) continue;
      roots.add(root);
      for (const folder of entries(root)) {
        if (!folder.isDirectory()) continue;
        const dir = join(root, folder.name);
        for (const f of entries(dir)) {
          const m = SESSION_FILE.exec(f.name);
          if (!m?.[1] || !f.isFile()) continue;
          const k = this.refresh(join(dir, f.name), m[1].toLowerCase());
          const prev = k && found.get(k.sessionId);
          if (k && (!prev || prev.mtimeMs < k.mtimeMs)) found.set(k.sessionId, k);
        }
      }
    }
    for (const id of this.known.keys()) if (!found.has(id)) this.known.delete(id);
    for (const [id, k] of found) this.known.set(id, k);
    return [...found.values()];
  }

  /** The cached record of a file, dropped when the file was replaced or cut. */
  private refresh(file: string, sessionId: string): Known | undefined {
    let st;
    try {
      st = statSync(file);
    } catch {
      return undefined;
    }
    const prev = this.known.get(sessionId);
    if (prev && prev.file === file && prev.ino === st.ino && st.size >= prev.size) {
      prev.size = st.size;
      prev.mtimeMs = st.mtimeMs;
      return prev;
    }
    return { file, sessionId, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  }

  private locate(sessionId: string): Known | undefined {
    // Claude's ids are UUIDs: anything else is no session of its own, and no reason to look on disk.
    if (!SESSION_FILE.test(`${sessionId}.jsonl`)) return undefined;
    const id = sessionId.toLowerCase();
    const k = this.known.get(id);
    const fresh = k && this.refresh(k.file, id);
    if (fresh) {
      this.known.set(id, fresh);
      return fresh;
    }
    return this.scan().find((x) => x.sessionId === id);
  }

  /** Where the session began, what started it, and the first thing the user asked. */
  private head(k: Known): Head | undefined {
    // Kept once both are known, or once as much was read as ever will be.
    const most = Math.min(k.size, HEAD_STEPS[HEAD_STEPS.length - 1] ?? 0);
    if (k.head && ((k.head.dir && k.head.prompt) || k.head.end >= most)) return k.head;
    const head: Head = { end: 0, dir: "", prompt: "", entrypoint: "" };
    try {
      withFile(k.file, (fd) => {
        for (const step of HEAD_STEPS) {
          const to = Math.min(k.size, step);
          head.end = to;
          scanLines(fd, 0, to, step, (line, whole) => {
            if (!whole) return;
            const rec = parseRecord(line);
            if (!rec || rec.isSidechain === true) return;
            if (!head.dir && str(rec.cwd)) head.dir = str(rec.cwd);
            if (!head.entrypoint && str(rec.entrypoint)) head.entrypoint = str(rec.entrypoint);
            if (!head.prompt) head.prompt = promptText(rec) ?? "";
            return !(head.dir && head.prompt && head.entrypoint);
          });
          if ((head.dir && head.prompt) || to >= k.size) break;
        }
      });
    } catch {
      return undefined;
    }
    k.head = head;
    return head;
  }

  /** Claude's title for the session (a name the user gave wins), else its first message. */
  private title(k: Known, head: Head): string {
    if (!k.tail || k.tail.size !== k.size || k.tail.mtimeMs !== k.mtimeMs) {
      let custom = "";
      let named = "";
      let summary = "";
      try {
        withFile(k.file, (fd) =>
          scanLines(
            fd,
            Math.max(0, k.size - TAIL_BYTES),
            k.size,
            TAIL_BYTES,
            (line, whole) => {
              // Only the short records carry a title.
              if (!whole || line.length > 8192) return;
              const rec = parseRecord(line);
              if (rec?.type === "custom-title" && str(rec.customTitle)) custom = str(rec.customTitle);
              else if (rec?.type === "ai-title" && str(rec.aiTitle)) named = str(rec.aiTitle);
              else if (rec?.type === "summary" && str(rec.summary)) summary = str(rec.summary);
            },
            true,
          ),
        );
      } catch {
        // unreadable now: the first message names it
      }
      k.tail = { size: k.size, mtimeMs: k.mtimeMs, title: custom || named || summary };
    }
    return oneLine(k.tail.title || head.prompt, TITLE_MAX);
  }

  /**
   * Counts what was appended since the last count (the whole file the first
   * time), within `budget` bytes. Returns the bytes read.
   */
  private count(k: Known, budget: number): number {
    const c = k.count ?? { scanned: 0, messages: 0 };
    const todo = k.size - c.scanned;
    if (todo <= 0 || todo > budget) return 0;
    try {
      c.scanned = withFile(k.file, (fd) =>
        scanLines(fd, c.scanned, k.size, COUNT_KEEP, (line, whole) => {
          if (isMessage(line, whole)) c.messages += 1;
        }),
      );
    } catch {
      return todo;
    }
    k.count = c;
    return todo;
  }

  /**
   * Session ids a running claude holds: from each Claude folder's register of
   * running sessions, and from the running processes' folders (`known`: the
   * sessions to tell apart, with where they began).
   */
  private running(known: readonly Known[]): Set<string> {
    const sessions = known.flatMap((k) => (k.head?.dir ? [{ sessionId: k.sessionId, dir: k.head.dir, mtimeMs: k.mtimeMs }] : []));
    const procs = this.processes.current;
    const ids = procs.length ? heldSessions(procs, sessions, dirComparer()) : new Set<string>();
    const seen = new Set<string>();
    for (const home of this.opts.homes()) {
      const dir = join(home, "sessions");
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const f of entries(dir)) {
        // Only the small <pid>.json records; never anything else in that folder.
        if (!f.isFile() || !PROCESS_FILE.test(f.name)) continue;
        try {
          const rec = JSON.parse(readFileSync(join(dir, f.name), "utf8")) as { pid?: unknown; sessionId?: unknown };
          if (typeof rec.pid === "number" && typeof rec.sessionId === "string" && this.alive(rec.pid)) ids.add(rec.sessionId.toLowerCase());
        } catch {
          // being written, or gone
        }
      }
    }
    return ids;
  }

  private view(k: Known, head: Head, title: string, running: Set<string>): LocalSession {
    const counted = k.count && k.count.scanned >= k.size ? k.count.messages : 0;
    return {
      sessionId: k.sessionId,
      dir: head.dir,
      title,
      updatedAt: Math.round(k.mtimeMs),
      messages: counted,
      entrypoint: head.entrypoint,
      busy: this.now() - k.mtimeMs < BUSY_MS || running.has(k.sessionId),
    };
  }
}

/**
 * One transcript line's mark on the background work: a user record that
 * carries the result of a launch adds the task it names; a task-notification
 * (the CLI telling the model a task ended or was stopped) takes it off. A
 * subagent's own records are not the session's.
 */
export function noteBackground(running: Set<string>, line: string): void {
  if (!line.includes('"type":"user"') || line.includes('"isSidechain":true')) return;
  if (line.includes('"content":"<task-notification>')) {
    const id = TASK_ID.exec(line)?.[1];
    const status = TASK_STATUS.exec(line)?.[1];
    if (id !== undefined && status !== undefined && status !== "running") running.delete(id);
    return;
  }
  const launched = AGENT_LAUNCHED.exec(line)?.[1] ?? SHELL_BACKGROUND.exec(line)?.[1];
  if (launched !== undefined) running.add(launched);
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A user message the person typed, or a text reply of Claude, told from the
 * start of the line where possible: Claude's own records (titles, requests,
 * file history) begin with their type, messages with their parent.
 */
function isMessage(head: Buffer, whole: boolean): boolean {
  const start = head.subarray(0, 2048).toString("latin1");
  if (start.startsWith('{"type":"') && !start.startsWith('{"type":"user"') && !start.startsWith('{"type":"assistant"')) return false;
  if (start.includes('"isSidechain":true')) return false;
  if (start.includes('"role":"assistant","content":[{"type":"text"')) return true;
  if (!start.includes('"role":"user"') || start.includes('"tool_use_id"')) return false;
  if (!whole) return start.includes('"type":"user"') && !start.includes('"isMeta":true');
  const rec = parseRecord(head);
  return rec !== undefined && promptText(rec) !== undefined;
}

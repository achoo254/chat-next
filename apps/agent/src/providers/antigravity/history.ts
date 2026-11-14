// agy's sessions on the machine. The list comes from `session/list` of the
// shared ACP process (folder, title, last change), read again in prime() at
// most every LIST_TTL_MS; what each session said comes from agy's own
// transcript file, brain/<id>/.system_generated/logs/transcript.jsonl. Nothing
// else of agy's is read (no database, no log). A record tunelo does not know
// is skipped. A deleted thread takes the session's brain/<id> folder and
// conversations/<id>.db to the trash, which is all agy's `session/list` goes by.
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEntry, HistoryRead, Liveness, LocalSession, SessionHistory, SessionPage, SessionQuery } from "../types.ts";
import { agyHome } from "./agy.ts";

/** How long a session list stands before prime() asks agy again. */
export const LIST_TTL_MS = 30_000;
/** "recent" reads at most this much of the end of a transcript. */
const RECENT_BYTES = 512 * 1024;
/** One read takes at most this much; the rest comes with the next read, from `end`. */
const READ_MAX_BYTES = 8 * 1024 * 1024;
/** A transcript changed this recently counts as busy. */
const BUSY_MS = 60_000;

export type ListedSession = { sessionId: string; cwd: string; title: string; updatedAt: number };

export type AgyHistoryOptions = {
  /** agy's `session/list`; throws when agy cannot answer. */
  listSessions: () => Promise<ListedSession[]>;
  home?: () => string;
  now?: () => number;
  log?: (line: string) => void;
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type Record_ = { step_index?: unknown; type?: unknown; content?: unknown; thinking?: unknown; created_at?: unknown; tool_calls?: unknown };

/** The user's own words of a USER_INPUT record (agy wraps them with metadata). */
export function userText(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m?.[1] ?? content).trim();
}

/** The entries of transcript lines; ids stable per session and step. */
export function entriesOf(sessionId: string, text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Record_;
    try {
      r = JSON.parse(line) as Record_;
    } catch {
      continue;
    }
    const step = typeof r.step_index === "number" ? r.step_index : -1;
    if (step < 0) continue;
    const at = typeof r.created_at === "string" ? Date.parse(r.created_at) || 0 : 0;
    const id = `${sessionId}:${step}`;
    if (r.type === "USER_INPUT" && typeof r.content === "string") {
      out.push({ at, type: "user", id, text: userText(r.content) });
      continue;
    }
    if (r.type !== "PLANNER_RESPONSE") continue;
    if (typeof r.thinking === "string" && r.thinking) out.push({ at, type: "text", blockId: `${id}:thinking`, role: "thinking", text: r.thinking });
    if (typeof r.content === "string" && r.content) out.push({ at, type: "text", blockId: `${id}:text`, role: "assistant", text: r.content });
    const calls = Array.isArray(r.tool_calls) ? (r.tool_calls as { name?: unknown; args?: unknown }[]) : [];
    calls.forEach((c, i) => {
      const name = typeof c.name === "string" ? c.name : "tool";
      const args = (typeof c.args === "object" && c.args !== null ? c.args : {}) as Record<string, unknown>;
      const summary = String(args.toolSummary ?? args.CommandLine ?? args.AbsolutePath ?? args.Path ?? name).slice(0, 300);
      out.push({ at, type: "tool-start", toolId: `${id}:tool:${i}`, kind: "other", name, summary, input: JSON.stringify(args) });
      out.push({ at, type: "tool-end", toolId: `${id}:tool:${i}`, ok: true, output: "" });
    });
  }
  return out;
}

export class AgyHistory implements SessionHistory {
  private listed: ListedSession[] = [];
  private listedAt = 0;
  private listing: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: AgyHistoryOptions) {
    this.now = opts.now ?? Date.now;
  }

  private transcript(sessionId: string): string | undefined {
    if (!ID_RE.test(sessionId)) return undefined;
    return join((this.opts.home ?? agyHome)(), "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  }

  private stat(sessionId: string): { size: number; mtimeMs: number } | undefined {
    const file = this.transcript(sessionId);
    if (!file) return undefined;
    try {
      const st = statSync(file);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async prime(): Promise<void> {
    if (this.now() - this.listedAt < LIST_TTL_MS) return;
    this.listing ??= this.opts
      .listSessions()
      .then(
        (list) => {
          this.listed = list.filter((s) => ID_RE.test(s.sessionId));
          this.listedAt = this.now();
        },
        (err: unknown) => this.opts.log?.(`antigravity: sessions not listed (${(err as Error).message})`),
      )
      .finally(() => (this.listing = undefined));
    await this.listing;
  }

  private view(s: ListedSession): LocalSession {
    const st = this.stat(s.sessionId);
    const updatedAt = Math.max(s.updatedAt, st?.mtimeMs ?? 0);
    return { sessionId: s.sessionId, dir: s.cwd, title: s.title, updatedAt, messages: 0, entrypoint: "", busy: this.now() - updatedAt < BUSY_MS };
  }

  list(q: SessionQuery): SessionPage {
    const words = q.query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.listed
      .filter((s) => s.cwd !== "" && (q.dir === "" || s.cwd === q.dir || s.cwd.startsWith(`${q.dir.replace(/\/$/, "")}/`)))
      .filter((s) => words.every((w) => `${s.title}\n${s.cwd}`.toLowerCase().includes(w)))
      .map((s) => this.view(s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const dirs = new Map<string, number>();
    for (const s of all) dirs.set(s.dir, (dirs.get(s.dir) ?? 0) + 1);
    return { sessions: all.slice(q.offset, q.offset + q.limit), total: all.length, dirs: [...dirs].map(([dir, sessions]) => ({ dir, sessions })) };
  }

  find(sessionId: string): LocalSession | undefined {
    const s = this.listed.find((x) => x.sessionId === sessionId);
    return s ? this.view(s) : undefined;
  }

  end(sessionId: string): number | undefined {
    return this.stat(sessionId)?.size;
  }

  read(sessionId: string, from: number | "recent"): HistoryRead | undefined {
    const file = this.transcript(sessionId);
    const st = this.stat(sessionId);
    if (!file || !st) return undefined;
    let start = from === "recent" ? Math.max(0, st.size - RECENT_BYTES) : Math.min(from, st.size);
    const fd = openSync(file, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(Math.min(st.size - start, READ_MAX_BYTES));
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    // Whole lines only: a cut start skips to the next line; a line still being written waits.
    if (start > 0 && from === "recent") {
      const nl = text.indexOf("\n");
      text = nl < 0 ? "" : text.slice(nl + 1);
      start += nl + 1;
    }
    const last = text.lastIndexOf("\n");
    const whole = last < 0 ? "" : text.slice(0, last + 1);
    const end = start + Buffer.byteLength(whole, "utf8");
    return { entries: entriesOf(sessionId, whole), end };
  }

  /**
   * The session's brain/<id> folder and conversations/<id>.db (with the
   * SQLite -wal and -shm beside it), each only when it is there as a plain
   * file or folder, never a link. Without them agy no longer lists the session.
   * The databases come first: when the trash stops at one that is held open,
   * the transcript in brain/<id> has not moved yet.
   */
  sessionFiles(sessionId: string): string[] {
    if (!ID_RE.test(sessionId)) return [];
    const home = (this.opts.home ?? agyHome)();
    const plain = (path: string, dir: boolean) => {
      try {
        const st = lstatSync(path);
        return !st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile());
      } catch {
        return false;
      }
    };
    const db = join(home, "conversations", `${sessionId}.db`);
    return [...[db, `${db}-wal`, `${db}-shm`].filter((file) => plain(file, false)), ...(plain(join(home, "brain", sessionId), true) ? [join(home, "brain", sessionId)] : [])];
  }

  async liveness(sessionId: string): Promise<Liveness> {
    const st = this.stat(sessionId);
    if (!st) return { state: "unknown", via: "transcript" };
    return { state: this.now() - st.mtimeMs < 10_000 ? "busy" : "idle", since: st.mtimeMs, via: "transcript" };
  }
}

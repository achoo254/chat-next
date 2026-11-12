// Token usage from Claude Code's own transcripts on this machine: every
// <claude folder>/projects/<folder>/<session>.jsonl and the subagents' files
// under <folder>/<session>/subagents/. Only numbers and names are taken from
// a reply record (ids, time, model, working directory, token counts, the
// names of the tools it used; for the Skill tool, the skill's name): never a
// message, a tool's input or its result.
//
// Files reach hundreds of megabytes, so they are read in chunks without
// blocking the event loop; only lines naming an assistant record are looked
// into, and then only for those fields (usage-json.ts steps over the rest
// without decoding it). A line longer than LINE_CAP is skipped without being
// kept.
import { type Dirent, lstatSync, realpathSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import type { UsageFile, UsageLineStats, UsageRead, UsageSource, UsageTurn } from "../types.ts";
import { JsonCursor } from "./usage-json.ts";

/** Longest line taken; longer ones (a giant tool output) are skipped and counted. */
export const LINE_CAP = 8 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const MARK = Buffer.from('"type":"assistant"');
/** Claude's own placeholder replies (no API call behind them). */
const SYNTHETIC_MODEL = "<synthetic>";
/** How deep the subagents' folder goes (workflows nest one level more). */
const SUBAGENT_DEPTH = 4;
const NAME_MAX = 200;
/** Reply content Claude Code writes today; anything else is counted as unknown. */
const KNOWN_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use", "mcp_tool_use"]);
const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
/** Server tools answer in the same reply with blocks named after them. */
const RESULT_BLOCK = /_tool_result$/;
const TYPE_NAME = /^[a-z_]{1,40}$/;

export type ClaudeUsageOptions = {
  /** Claude folders of the machine (its own, then each profile's). */
  homes: () => string[];
};

async function dirEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isJsonl = (e: Dirent) => e.isFile() && e.name.endsWith(".jsonl");

/** A name or id kept from a record: a string without control characters, cut short. */
function cleanName(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, NAME_MAX) || undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

const emptyStats = (): UsageLineStats => ({ records: 0, withUsage: 0, parseErrors: 0, overCap: 0, unknownTypes: {} });

type Block = { type: string; name?: string; skill?: string };
type Message = { id?: string; model?: string; usage?: Record<string, number>; blocks: Block[] };
/** The fields of a record the scan uses; nothing else of it is decoded. */
type Picked = { type?: string; requestId?: string; timestamp?: string; sessionId?: string; cwd?: string; agentId?: string; message?: Message };

const RECORD_KEYS = new Set(["type", "requestId", "timestamp", "sessionId", "cwd", "agentId"]);
const USAGE_KEYS = new Set(["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]);

function stringAt(c: JsonCursor): string | undefined {
  return c.peek() === '"' ? c.string() : undefined;
}

function pickBlock(c: JsonCursor): Block | undefined {
  if (c.peek() !== "{") return undefined;
  const block: Block = { type: "" };
  c.object((key) => {
    if (key === "type") block.type = stringAt(c) ?? "";
    else if (key === "name") {
      const name = stringAt(c);
      if (name !== undefined) block.name = name;
    } else if (key === "input" && c.peek() === "{") {
      // Only the Skill tool's `skill` is read; it is kept only for that tool.
      c.object((k) => {
        if (k !== "skill") return;
        const skill = stringAt(c);
        if (skill !== undefined) block.skill = skill;
      });
    }
  });
  return block;
}

function pickMessage(c: JsonCursor): Message {
  const m: Message = { blocks: [] };
  c.object((key) => {
    if (key === "id" || key === "model") {
      const v = stringAt(c);
      if (v !== undefined) m[key] = v;
    } else if (key === "usage" && c.peek() === "{") {
      const usage: Record<string, number> = {};
      c.object((k) => {
        if (!USAGE_KEYS.has(k)) return;
        const v = c.scalar();
        if (typeof v === "number") usage[k] = v;
      });
      m.usage = usage;
    } else if (key === "content" && c.peek() === "[") {
      c.array(() => {
        const block = pickBlock(c);
        if (block) m.blocks.push(block);
      });
    }
  });
  return m;
}

function pickRecord(line: Buffer): Picked {
  const c = new JsonCursor(line);
  const p: Picked = {};
  c.object((key) => {
    if (RECORD_KEYS.has(key)) {
      const v = stringAt(c);
      if (v !== undefined) p[key as keyof Omit<Picked, "message">] = v;
    } else if (key === "message" && c.peek() === "{") {
      p.message = pickMessage(c);
    }
  });
  return p;
}

/** The usage call of one line, when it is a reply of Claude with token counts. */
export function parseUsageLine(line: Buffer, subagent: boolean, stats: UsageLineStats): UsageTurn | undefined {
  if (line.indexOf(MARK) < 0) return undefined;
  let r: Picked;
  try {
    r = pickRecord(line);
  } catch {
    stats.parseErrors++;
    return undefined;
  }
  if (r.type !== "assistant") return undefined;
  stats.records++;
  const msg = r.message;
  const usage = msg?.usage;
  const id = cleanName(msg?.id);
  if (!msg || !usage || !id) return undefined;
  stats.withUsage++;
  const tools: string[] = [];
  for (const b of msg.blocks) {
    if (!KNOWN_BLOCKS.has(b.type) && !RESULT_BLOCK.test(b.type)) {
      const name = TYPE_NAME.test(b.type) ? b.type : "other";
      stats.unknownTypes[name] = (stats.unknownTypes[name] ?? 0) + 1;
    }
    if (!TOOL_BLOCKS.has(b.type)) continue;
    const name = cleanName(b.name);
    if (!name) continue;
    const skill = name === "Skill" ? cleanName(b.skill) : undefined;
    tools.push(skill ? `Skill:${skill}` : name);
  }
  const model = cleanName(msg.model) ?? "";
  if (model === SYNTHETIC_MODEL) return undefined;
  const at = r.timestamp ? Date.parse(r.timestamp) : Number.NaN;
  const sessionId = cleanName(r.sessionId);
  if (!Number.isFinite(at) || !sessionId) return undefined;
  const requestId = cleanName(r.requestId);
  const turn: UsageTurn = {
    key: requestId ? `${id}|${requestId}` : id,
    sessionId,
    subagent,
    at,
    model,
    cwd: r.cwd ?? "",
    tools,
  };
  const agentId = subagent ? cleanName(r.agentId) : undefined;
  if (agentId) turn.agentId = agentId;
  const input = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  if (input !== undefined) turn.inputTokens = input;
  if (cacheRead !== undefined) turn.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) turn.cacheWriteTokens = cacheWrite;
  if (output !== undefined) turn.outputTokens = output;
  return turn;
}

/**
 * Calls `onLine` with every whole line of `path` from byte `from` on and
 * returns the byte after the last one; a line still being written (no
 * newline yet) is left for the next read. Lines over `cap` bytes are skipped
 * without being kept and counted in `stats.overCap`. The line passed may be
 * a view of the reader's buffer: valid only during the call. A line within
 * one chunk is never copied (most lines are not replies and are only looked
 * at), so a scan of gigabytes makes little garbage.
 */
export async function readLines(path: string, from: number, cap: number, stats: UsageLineStats, onLine: (line: Buffer) => void): Promise<number> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = from;
    let lineStart = from;
    /** Earlier pieces of a line that started in an earlier chunk (copied: the buffer is reused). */
    let parts: Buffer[] = [];
    let length = 0;
    let skipping = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead <= 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        const stop = nl < 0 || nl >= bytesRead ? bytesRead : nl;
        if (!skipping) {
          length += stop - start;
          if (length > cap) {
            skipping = true;
            parts = [];
          } else if (stop === bytesRead && stop > start) {
            parts.push(Buffer.from(buf.subarray(start, stop)));
          }
        }
        if (stop === bytesRead) break;
        if (skipping) stats.overCap++;
        else if (parts.length === 0) onLine(buf.subarray(start, stop));
        else onLine(Buffer.concat([...parts, buf.subarray(start, stop)]));
        parts = [];
        length = 0;
        skipping = false;
        lineStart = pos + nl + 1;
        start = nl + 1;
      }
      pos += bytesRead;
    }
    return lineStart;
  } finally {
    await fh.close();
  }
}

export class ClaudeUsage implements UsageSource {
  /** Files of the last listing that are a subagent's. */
  private subagentFiles = new Set<string>();

  constructor(private readonly opts: ClaudeUsageOptions) {}

  async files(): Promise<UsageFile[]> {
    const out: UsageFile[] = [];
    const sub = new Set<string>();
    const roots = new Set<string>();
    for (const home of this.opts.homes()) {
      let root: string;
      try {
        // Profiles link their projects folder to the machine's own: each real folder once.
        root = realpathSync.native(join(home, "projects"));
      } catch {
        continue;
      }
      if (roots.has(root)) continue;
      roots.add(root);
      for (const folder of await dirEntries(root)) {
        if (!folder.isDirectory()) continue;
        const dir = join(root, folder.name);
        for (const e of await dirEntries(dir)) {
          if (isJsonl(e)) this.add(out, join(dir, e.name));
          else if (e.isDirectory()) {
            const before = out.length;
            await this.walkSubagents(out, join(dir, e.name, "subagents"), SUBAGENT_DEPTH);
            for (const f of out.slice(before)) sub.add(f.path);
          }
        }
      }
    }
    this.subagentFiles = sub;
    return out;
  }

  private async walkSubagents(out: UsageFile[], dir: string, depth: number): Promise<void> {
    if (depth <= 0 || !this.plainDir(dir)) return;
    for (const e of await dirEntries(dir)) {
      const p = join(dir, e.name);
      if (isJsonl(e)) this.add(out, p);
      else if (e.isDirectory()) await this.walkSubagents(out, p, depth - 1);
    }
  }

  private plainDir(dir: string): boolean {
    try {
      const st = lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** A regular file, never a link. */
  private add(out: UsageFile[], path: string): void {
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return;
      out.push({ path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // gone since the listing
    }
  }

  async read(file: UsageFile, from: number): Promise<UsageRead> {
    const subagent = this.subagentFiles.has(file.path) || file.path.includes(`${sep}subagents${sep}`);
    const stats = emptyStats();
    const turns: UsageTurn[] = [];
    const end = await readLines(file.path, from, LINE_CAP, stats, (line) => {
      const turn = parseUsageLine(line, subagent, stats);
      if (turn) turns.push(turn);
    });
    return { turns, end, stats };
  }
}

// Claude Code's own transcript of a session: one JSON record per line in
// <claude folder>/projects/<folder>/<session id>.jsonl, appended by whatever
// runs the session (a terminal, an IDE, Claude Desktop, tunelo through the
// Agent SDK). Files reach hundreds of megabytes, so they are read in chunks
// and only as far as needed; a line too long to keep is skipped.
//
// The record shapes are Claude Code's, not a published format: anything
// unknown is skipped rather than failed on.
import { closeSync, openSync, readSync } from "node:fs";
import type { HistoryEntry, ProviderEvent } from "../types.ts";
import { MessageMapper } from "./message-mapper.ts";

const CHUNK = 1024 * 1024;

/**
 * Calls `fn` with each complete line in [from, to) of the open file: its
 * first `keep` bytes and whether that is the whole line. With `align`, a
 * `from` inside a line starts at the next one. `fn` returning false stops.
 * Returns the position after the last complete line looked at.
 */
export function scanLines(
  fd: number,
  from: number,
  to: number,
  keep: number,
  fn: (head: Buffer, whole: boolean) => unknown,
  align = false,
): number {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = from;
  let lineStart = from;
  let parts: Buffer[] = [];
  let kept = 0;
  let length = 0;
  let skipping = align && from > 0;
  while (pos < to) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, to - pos), pos);
    if (n <= 0) break;
    const view = buf.subarray(0, n);
    let start = 0;
    for (;;) {
      const nl = view.indexOf(0x0a, start);
      const stop = nl < 0 ? n : nl;
      const take = skipping ? 0 : Math.min(stop - start, keep - kept);
      if (take > 0) {
        parts.push(Buffer.from(view.subarray(start, start + take)));
        kept += take;
      }
      length += stop - start;
      if (nl < 0) break;
      if (!skipping) {
        const head = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
        if (fn(head, length <= keep) === false) return pos + nl + 1;
      }
      skipping = false;
      parts = [];
      kept = 0;
      length = 0;
      lineStart = pos + nl + 1;
      start = nl + 1;
    }
    pos += n;
  }
  return lineStart;
}

/** Opens the file for the duration of `fn`. */
export function withFile<T>(file: string, fn: (fd: number) => T): T {
  const fd = openSync(file, "r");
  try {
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

export type TranscriptRecord = {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  entrypoint?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  origin?: { kind?: unknown } | null;
  subtype?: unknown;
  compactMetadata?: { preTokens?: unknown } | null;
  apiBlockIndex?: unknown;
  message?: { id?: unknown; content?: unknown } | null;
  aiTitle?: unknown;
  customTitle?: unknown;
  summary?: unknown;
};

export function parseRecord(line: Buffer | string): TranscriptRecord | undefined {
  try {
    const value: unknown = JSON.parse(typeof line === "string" ? line : line.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as TranscriptRecord) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Output of the machine's own commands and notes Claude adds: never something the user typed. */
const NOT_TYPED = /^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder|task-notification|user-prompt-submit-hook)\b/;

/** What the user typed, as the terminal shows it: "/command args" for a slash command, "! cmd" for a shell line. */
export function cleanPrompt(raw: string): string | undefined {
  const s = raw.trim();
  const command = /<command-name>([^<]*)<\/command-name>/.exec(s);
  if (command) {
    const name = (command[1] ?? "").trim();
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1] ?? "").trim();
    if (!name) return undefined;
    return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return `! ${(bash[1] ?? "").trim()}`;
  if (s === "" || NOT_TYPED.test(s)) return undefined;
  return s;
}

/** The text of a user message the person typed; undefined for tool results, notes and anything Claude added. */
export function promptText(rec: TranscriptRecord): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) {
    return undefined;
  }
  const origin = rec.origin?.kind;
  if (typeof origin === "string" && origin !== "human") return undefined;
  const content = rec.message?.content;
  if (typeof content === "string") return cleanPrompt(content);
  if (!Array.isArray(content)) return undefined;
  const blocks = content as { type?: unknown; text?: unknown }[];
  if (blocks.some((b) => b?.type === "tool_result")) return undefined;
  const text = cleanPrompt(blocks.map((b) => (b?.type === "text" ? str(b.text) : "")).join("\n"));
  const images = blocks.filter((b) => b?.type === "image").length;
  if (images === 0) return text;
  const marks = Array.from({ length: images }, () => "[image]").join(" ");
  return text ? `${text}\n${marks}` : marks;
}

/** One line of text, at most `max` characters, cut with "…". */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Turns transcript records into history entries with the ids a live session
 * gives the same things (`text:<message id>:<block index>`, tool ids), so an
 * entry seen live and read back here is one item.
 */
export class TranscriptReader {
  readonly entries: HistoryEntry[] = [];
  private at = 0;
  private readonly mapper: MessageMapper;

  constructor(dir: string) {
    this.mapper = new MessageMapper(dir, (e) => this.fromMapper(e));
  }

  private fromMapper(e: ProviderEvent): void {
    if (e.type === "tool-start" || e.type === "tool-end" || e.type === "diff" || e.type === "todo" || e.type === "subagent") {
      this.entries.push({ ...e, at: this.at });
    }
  }

  add(rec: TranscriptRecord): void {
    if (rec.isSidechain === true) return;
    this.at = Date.parse(str(rec.timestamp)) || this.at;
    if (rec.type === "user") {
      const text = promptText(rec);
      const uuid = str(rec.uuid);
      if (text !== undefined && uuid) {
        this.entries.push({ type: "user", id: `user:cc:${uuid}`, text, at: this.at });
        return;
      }
      if (rec.isMeta !== true) this.mapper.toolResults(rec.message?.content);
      return;
    }
    if (rec.type === "assistant") {
      const id = str(rec.message?.id);
      const content = rec.message?.content;
      if (!id || !Array.isArray(content)) return;
      (content as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }[]).forEach((block, i) => {
        if (block?.type === "text" && str(block.text).trim() !== "") {
          const index = typeof rec.apiBlockIndex === "number" ? String(rec.apiBlockIndex) : `${i}:${str(rec.uuid)}`;
          this.entries.push({ type: "text", blockId: `${id}:${index}`, role: "assistant", text: str(block.text), at: this.at });
        } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const input = typeof block.input === "object" && block.input !== null ? (block.input as Record<string, unknown>) : {};
          this.mapper.toolUse(block.id, block.name, input);
        }
      });
      return;
    }
    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      const tokens = rec.compactMetadata?.preTokens;
      this.entries.push({ type: "compaction", tokensBefore: typeof tokens === "number" ? tokens : 0, at: this.at });
    }
  }
}

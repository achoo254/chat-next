// Claude Code transcripts for tests, in the shape claude writes them to
// <claude folder>/projects/<folder>/<session id>.jsonl (records and key
// order as Claude Code 2.1 writes them). The content is made up.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The folder name claude gives a working directory under projects/. */
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export function transcriptFile(home: string, cwd: string, sessionId: string): string {
  const dir = join(home, "projects", projectFolder(cwd));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.jsonl`);
}

export class Transcript {
  readonly lines: string[] = [];
  private parent: string | null = null;
  private clock: number;
  private msg = 0;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    private readonly entrypoint = "cli",
    start = Date.parse("2026-11-01T08:00:00.000Z"),
  ) {
    this.clock = start;
  }

  private stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private common() {
    return { userType: "external", entrypoint: this.entrypoint, cwd: this.cwd, sessionId: this.sessionId, version: "2.1.319", gitBranch: "main" };
  }

  private push(record: object): this {
    this.lines.push(JSON.stringify(record));
    return this;
  }

  /** Records claude writes first, before any message. */
  opening(): this {
    this.push({ type: "permission-mode", permissionMode: "default", sessionId: this.sessionId });
    return this.push({ type: "file-history-snapshot", messageId: randomUUID(), snapshot: { messageId: randomUUID(), trackedFileBackups: {}, timestamp: this.stamp() }, isSnapshotUpdate: false });
  }

  user(content: string | object[], extra: Record<string, unknown> = {}): this {
    const uuid = randomUUID();
    const rec = {
      parentUuid: this.parent,
      isSidechain: false,
      promptId: randomUUID(),
      type: "user",
      message: { role: "user", content },
      uuid,
      timestamp: this.stamp(),
      permissionMode: "default",
      ...extra,
      ...this.common(),
    };
    this.parent = uuid;
    return this.push(rec);
  }

  /** A note claude adds as a user message (a skill's text, a reminder). */
  meta(text: string): this {
    return this.user(text, { isMeta: true });
  }

  /** One assistant message; claude writes one record per content block. */
  assistant(blocks: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object } | { type: "thinking"; thinking: string })[]): string {
    const id = `msg_${String(++this.msg).padStart(4, "0")}`;
    blocks.forEach((block, index) => {
      const uuid = randomUUID();
      this.push({
        parentUuid: this.parent,
        isSidechain: false,
        message: { model: "claude-opus-4-1", id, type: "message", role: "assistant", content: [block], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
        apiBlockIndex: index,
        requestId: `req_${this.msg}`,
        type: "assistant",
        uuid,
        timestamp: this.stamp(),
        ...this.common(),
      });
      this.parent = uuid;
    });
    return id;
  }

  toolResult(toolUseId: string, content: string, isError = false): this {
    const uuid = randomUUID();
    const rec = {
      parentUuid: this.parent,
      isSidechain: false,
      promptId: randomUUID(),
      type: "user",
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }] },
      uuid,
      timestamp: this.stamp(),
      toolUseResult: { stdout: content },
      ...this.common(),
    };
    this.parent = uuid;
    return this.push(rec);
  }

  aiTitle(title: string): this {
    return this.push({ type: "ai-title", aiTitle: title, sessionId: this.sessionId });
  }

  customTitle(title: string): this {
    return this.push({ type: "custom-title", customTitle: title, sessionId: this.sessionId });
  }

  /** Big records that are not messages (a request body kept for caching). */
  blob(bytes: number): this {
    return this.push({ type: "api-request-blob", sessionId: this.sessionId, hash: randomUUID(), message: { role: "user", content: [{ type: "text", text: "x".repeat(bytes) }] } });
  }

  write(home: string): string {
    const file = transcriptFile(home, this.cwd, this.sessionId);
    writeFileSync(file, this.lines.map((l) => `${l}\n`).join(""));
    return file;
  }

  /** Appends what was added after `from` lines (a later turn from a terminal). */
  appendFrom(home: string, from: number): string {
    const file = transcriptFile(home, this.cwd, this.sessionId);
    appendFileSync(file, this.lines.slice(from).map((l) => `${l}\n`).join(""));
    return file;
  }
}

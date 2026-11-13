// One ACP session as a ProviderSession: the AI's `session/update`
// notifications become provider events, `session/prompt` runs one turn at a
// time, and `session/request_permission` goes to the user through askUser.
// Several sessions may share one ACP process; AcpRouter hands each
// notification and prompt to the session it names.
import { Channel } from "../../util/channel.ts";
import type { ImageInput, ProviderEvent, ProviderSession, SlashCommand, ToolKind } from "../types.ts";
import type { AcpClient } from "./acp-client.ts";

/** A tool call as ACP reports it (`tool_call`, `tool_call_update`, a permission request's `toolCall`). */
export type AcpToolCall = {
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: { output?: unknown; exit_code?: unknown } | null;
  locations?: { path?: string }[];
  content?: { type?: string; path?: string; oldText?: string | null; newText?: string; content?: { type?: string; text?: string } }[];
};

type AcpUpdate = AcpToolCall & {
  sessionUpdate?: string;
  content?: unknown;
  used?: number;
  size?: number;
  currentModeId?: string;
  availableCommands?: { name?: string; description?: string; input?: { hint?: string } | null }[];
};

export type AcpPermissionOption = { optionId: string; name?: string; kind?: string };
export type AcpPermissionParams = { sessionId?: string; toolCall?: AcpToolCall; options?: AcpPermissionOption[] };
export type AcpPermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

type SessionHandlers = { update: (u: AcpUpdate) => void; permission: (p: AcpPermissionParams) => Promise<AcpPermissionOutcome> };

/** Hands each notification and permission request of one ACP process to the session it names. */
export class AcpRouter {
  private readonly sessions = new Map<string, SessionHandlers>();

  constructor(
    readonly client: AcpClient,
    log: (line: string) => void,
  ) {
    client.onNotification("session/update", (params) => {
      const p = params as { sessionId?: string; update?: AcpUpdate } | null;
      const s = p?.sessionId ? this.sessions.get(p.sessionId) : undefined;
      if (s && p?.update) s.update(p.update);
    });
    client.onRequest("session/request_permission", async (params) => {
      const p = params as AcpPermissionParams | null;
      const s = p?.sessionId ? this.sessions.get(p.sessionId) : undefined;
      if (!s || !p) {
        log("acp: a permission request for no open session was refused");
        return { outcome: { outcome: "cancelled" } };
      }
      return s.permission(p);
    });
  }

  add(sessionId: string, handlers: SessionHandlers): void {
    this.sessions.set(sessionId, handlers);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** What the adapter decides for its AI. */
export type AcpSessionDeps = {
  router: AcpRouter;
  sessionId: string;
  /** How a tool call shows: its kind, name, one-line summary, input (as JSON). */
  describe: (call: AcpToolCall) => { kind: ToolKind; name: string; summary: string; input: string };
  /** A file edit of a tool call as a unified diff; undefined when it has none. */
  diff?: (call: AcpToolCall) => { path: string; unified: string; added: number; removed: number } | undefined;
  /** The answer to one permission request (the adapter asks the user). */
  permission: (p: AcpPermissionParams, signal: AbortSignal) => Promise<AcpPermissionOutcome>;
  /** The model the session runs, for a turn's stats. */
  model: () => string;
  /** The mode the session started in. */
  mode: string;
  log: (line: string) => void;
};

type PromptBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const isDone = (status: string | undefined) => status === "completed" || status === "failed";

export class AcpSession implements ProviderSession {
  private readonly channel = new Channel<ProviderEvent>();
  readonly events: AsyncIterable<ProviderEvent> = this.channel;
  private readonly queue: PromptBlock[][] = [];
  private running = false;
  private turn = 0;
  private block: { id: string; role: "assistant" | "thinking"; text: string } | undefined;
  private blocks = 0;
  private readonly started = new Set<string>();
  private readonly ended = new Set<string>();
  /** Permission requests waiting on the user; they end with the turn or the session. */
  private readonly asking = new Set<AbortController>();
  private closed = false;

  constructor(private readonly deps: AcpSessionDeps) {
    deps.router.add(deps.sessionId, {
      update: (u) => this.update(u),
      permission: (p) => this.permission(p),
    });
    this.emit({ type: "session", sessionId: deps.sessionId });
    this.emit({ type: "info", permissionMode: deps.mode });
  }

  private get client(): AcpClient {
    return this.deps.router.client;
  }

  emit(e: ProviderEvent): void {
    this.channel.push(e);
  }

  async send(text: string, images: readonly ImageInput[] = []): Promise<void> {
    const prompt: PromptBlock[] = [];
    if (text) prompt.push({ type: "text", text });
    for (const img of images) prompt.push({ type: "image", mimeType: img.mediaType, data: Buffer.from(img.data).toString("base64") });
    if (prompt.length === 0) return;
    this.queue.push(prompt);
    if (!this.running) void this.next();
  }

  /** Runs the queued prompts one turn at a time. */
  private async next(): Promise<void> {
    const prompt = this.queue.shift();
    if (!prompt || this.closed) return;
    this.running = true;
    this.turn += 1;
    const startedAt = Date.now();
    try {
      // A turn may take minutes: it waits as long as the AI works.
      const r = await this.client.request<{ stopReason?: string; usage?: Record<string, unknown> }>("session/prompt", { sessionId: this.deps.sessionId, prompt }, 0);
      this.flushText();
      const state = r?.stopReason === "end_turn" || r?.stopReason === "max_tokens" ? "completed" : r?.stopReason === "cancelled" ? "interrupted" : "failed";
      if (state === "failed") this.emit({ type: "error", message: `the turn stopped: ${String(r?.stopReason ?? "unknown")}` });
      const u = r?.usage ?? {};
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      this.emit({
        type: "turn-end",
        state,
        durationMs: Date.now() - startedAt,
        stats: {
          model: this.deps.model(),
          inputTokens: n("inputTokens"),
          outputTokens: n("outputTokens"),
          cacheReadTokens: n("cachedReadTokens"),
          cacheWriteTokens: n("cachedWriteTokens"),
          numTurns: 1,
          apiMsTotal: 0,
          costUsdTotal: 0,
        },
      });
    } catch (err) {
      this.flushText();
      this.emit({ type: "error", message: (err as Error).message.slice(0, 500) });
      this.emit({ type: "turn-end", state: "failed", durationMs: Date.now() - startedAt });
    } finally {
      this.endAsking();
      this.running = false;
    }
    void this.next();
  }

  async interrupt(): Promise<void> {
    this.queue.length = 0;
    this.endAsking();
    this.client.notify("session/cancel", { sessionId: this.deps.sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.endAsking();
    if (this.running) this.client.notify("session/cancel", { sessionId: this.deps.sessionId });
    await this.client.request("session/close", { sessionId: this.deps.sessionId }, 10_000).catch(() => undefined);
    this.deps.router.remove(this.deps.sessionId);
    this.channel.close();
  }

  async setModel(model: string): Promise<void> {
    await this.client.request("session/set_model", { sessionId: this.deps.sessionId, modelId: model });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.client.request("session/set_mode", { sessionId: this.deps.sessionId, modeId: mode });
  }

  /** The process under the session ended: the session is over (the core opens it again, resumed). */
  lost(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.endAsking();
    this.deps.router.remove(this.deps.sessionId);
    this.emit({ type: "error", message: why });
    if (this.running) this.emit({ type: "turn-end", state: "failed", durationMs: 0 });
    this.channel.close();
  }

  private endAsking(): void {
    for (const a of this.asking) a.abort();
    this.asking.clear();
  }

  private async permission(p: AcpPermissionParams): Promise<AcpPermissionOutcome> {
    const abort = new AbortController();
    this.asking.add(abort);
    try {
      this.flushText();
      if (p.toolCall) this.toolStarted(p.toolCall);
      return await this.deps.permission(p, abort.signal);
    } catch {
      return { outcome: { outcome: "cancelled" } };
    } finally {
      this.asking.delete(abort);
    }
  }

  private text(role: "assistant" | "thinking", content: unknown): void {
    const c = content as { type?: string; text?: string } | null;
    if (c?.type !== "text" || typeof c.text !== "string" || c.text === "") return;
    if (this.block && this.block.role !== role) this.flushText();
    this.block ??= { id: `${this.deps.sessionId}:${this.turn}:${this.blocks++}`, role, text: "" };
    this.block.text += c.text;
    this.emit({ type: "text-delta", blockId: this.block.id, role, text: c.text });
  }

  private flushText(): void {
    const b = this.block;
    if (!b) return;
    this.block = undefined;
    this.emit({ type: "text", blockId: b.id, role: b.role, text: b.text });
  }

  private toolStarted(call: AcpToolCall): void {
    const id = call.toolCallId;
    if (!id || this.started.has(id)) return;
    this.started.add(id);
    this.emit({ type: "tool-start", toolId: id, ...this.deps.describe(call) });
    const diff = this.deps.diff?.(call);
    if (diff) this.emit({ type: "diff", toolId: id, ...diff });
  }

  private toolEnded(call: AcpToolCall): void {
    const id = call.toolCallId;
    if (!id || this.ended.has(id) || !isDone(call.status)) return;
    this.toolStarted(call);
    this.ended.add(id);
    this.emit({ type: "tool-end", toolId: id, ok: call.status === "completed", output: toolOutput(call) });
  }

  private update(u: AcpUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return this.text("assistant", u.content);
      case "agent_thought_chunk":
        return this.text("thinking", u.content);
      case "tool_call":
      case "tool_call_update":
        this.flushText();
        if (isDone(u.status)) return this.toolEnded(u);
        // A pending call waits for a permission answer: it shows once asked, or once it runs.
        if (u.status === "in_progress") this.toolStarted(u);
        return;
      case "usage_update":
        if (typeof u.used === "number" && typeof u.size === "number") this.emit({ type: "usage", contextTokens: u.used, contextWindow: u.size });
        return;
      case "current_mode_update":
        if (u.currentModeId) this.emit({ type: "info", permissionMode: u.currentModeId });
        return;
      case "available_commands_update":
        this.emit({ type: "info", commands: commandsOf(u.availableCommands ?? []) });
        return;
      case "user_message_chunk":
      case "session_info_update":
      case "config_option_update":
      case "plan":
        return;
      default:
        this.deps.log(`acp: update ${String(u.sessionUpdate).slice(0, 60)} skipped`);
    }
  }
}

/** The AI's slash commands, as devices offer them. */
export function commandsOf(list: { name?: string; description?: string; input?: { hint?: string } | null }[]): SlashCommand[] {
  return list
    .filter((c): c is { name: string; description?: string; input?: { hint?: string } | null } => typeof c.name === "string" && c.name !== "")
    .map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: c.input?.hint ?? "", builtin: true }));
}

/** What a finished tool call answered, as text. */
export function toolOutput(call: AcpToolCall): string {
  const raw = call.rawOutput?.output;
  if (typeof raw === "string") return raw;
  const texts = (Array.isArray(call.content) ? call.content : []).flatMap((c) => (c.type === "content" && c.content?.type === "text" && typeof c.content.text === "string" ? [c.content.text] : []));
  return texts.join("\n");
}

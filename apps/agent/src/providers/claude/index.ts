// Claude Code adapter: drives the `claude` binary the user installed and
// logged into, through the Agent SDK. It never reads credentials and never
// calls the Anthropic API itself.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AccountInfo as SdkAccountInfo,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv, readAccount } from "../../profiles/account.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import { Channel } from "../../util/channel.ts";
import type {
  AccountInfo,
  AgentProvider,
  AskUser,
  Detected,
  DetectOptions,
  ProviderCapabilities,
  ProviderEvent,
  ProviderInfo,
  ProviderSession,
  Question,
  SessionPolicy,
  TodoEntry,
} from "../types.ts";
import { resultText, toolDiff, toolKind, toolPaths, toolSummary } from "./tool-map.ts";

const run = promisify(execFile);

/** `claude` versions this agent was tested with (major.minor). */
const TESTED = ["2.1"];

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  interrupt: true,
  resume: true,
  sessionAllow: true,
  questions: true,
  todo: true,
  contextUsage: true,
  compaction: true,
  diff: true,
  images: false,
  models: [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
    { id: "haiku", name: "Haiku" },
  ],
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  // bypassPermissions and dontAsk are left out: a device may only return to
  // bypass when the machine's own settings start sessions in it.
  permissionModes: ["default", "acceptEdits", "plan", "auto"],
};

/** The CLI's account report, without any token source. */
export function toAccount(a: SdkAccountInfo): AccountInfo | undefined {
  if (!a.email && !a.organization && !a.subscriptionType) return undefined;
  return { email: a.email ?? "", organization: a.organization ?? "", plan: a.subscriptionType ?? "" };
}

/** The user's own `claude`: PATH first, then the native installer's location. */
export async function findClaude(): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["claude"]);
    const first = stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  } catch {
    // not on PATH (services often start with a minimal PATH)
  }
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return existsSync(local) ? local : null;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export function createClaudeProvider(deps: { query?: QueryFn; findBinary?: () => Promise<string | null> } = {}): AgentProvider {
  const queryFn: QueryFn = deps.query ?? ((p) => sdkQuery(p));
  const findBinary = deps.findBinary ?? findClaude;

  return {
    id: "claude",
    name: "Claude Code",
    capabilities: CLAUDE_CAPABILITIES,

    async detect(opts: DetectOptions = {}): Promise<Detected> {
      const bin = await findBinary();
      if (!bin) return { installed: false, loginState: "unknown" };
      let version: string | undefined;
      try {
        version = (await run(bin, ["--version"], { timeout: 15_000 })).stdout.trim().split(" ")[0];
      } catch {
        return { installed: false, loginState: "unknown" };
      }
      // The CLI's own status report (exit 1 when signed out); the agent never opens credential files.
      const account = await readAccount(bin, opts.accountDir);
      const loginState: Detected["loginState"] = account === null ? "unknown" : account.loggedIn ? "ok" : "needs-login";
      const minor = version?.split(".").slice(0, 2).join(".");
      const out: Detected = { installed: true, loginState, untestedVersion: !minor || !TESTED.includes(minor) };
      if (version) out.version = version;
      return out;
    },

    async start({ policy, resumeId, askUser }) {
      const bin = await findBinary();
      if (!bin) throw new Error("claude is not installed");
      return startSession(queryFn, bin, policy, askUser, resumeId);
    },
  };
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
}

function startSession(queryFn: QueryFn, bin: string, policy: SessionPolicy, askUser: AskUser, resumeId?: string): ProviderSession {
  const inbox = new Channel<SDKUserMessage>();
  const events = new Channel<ProviderEvent>();
  let interrupted = false;
  let turnStart = 0;
  let turnOpen = false;
  let closed = false;

  const canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = ((input.questions as Question[] | undefined) ?? []).map((q) => ({
        question: q.question,
        header: q.header ?? "",
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
        multiSelect: Boolean(q.multiSelect),
      }));
      const ans = await askUser({ kind: "question", toolId: opts.toolUseID ?? "", questions }, opts.signal);
      if ("cancelled" in ans) return { behavior: "deny", message: "The user dismissed the question." };
      const answers: Record<string, string> = {};
      questions.forEach((q, i) => (answers[q.question] = (ans.answers[i] ?? []).join(", ")));
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    const paths = [...toolPaths(input), ...(opts.blockedPath ? [opts.blockedPath] : [])];
    const command = typeof input.command === "string" ? input.command : "";
    const sensitive = paths.some(policy.isSensitive) || (command !== "" && mentionsSensitive(command, policy.isSensitive, { cwd: policy.dir }));
    const req = {
      kind: "approval" as const,
      toolId: opts.toolUseID ?? "",
      toolKind: toolKind(toolName),
      name: toolName,
      summary: toolSummary(toolName, input, policy.dir),
      input: JSON.stringify(input).slice(0, 4000),
      sensitive,
      ...(opts.decisionReason ? { reason: opts.decisionReason } : {}),
    };
    const { decision } = await askUser(req, opts.signal);
    if (decision === "deny") return { behavior: "deny", message: "The user denied this from their device." };
    if (decision === "allow-session" && !sensitive) {
      // Only allow rules for this session: a remote "allow for the session"
      // must never switch the permission mode or add directories.
      const suggested = (opts.suggestions ?? []).filter((s) => s.type === "addRules" && s.behavior === "allow");
      const rules: PermissionUpdate[] = suggested.length
        ? suggested.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate)
        : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
      return { behavior: "allow", updatedInput: input, updatedPermissions: rules };
    }
    return { behavior: "allow", updatedInput: input };
  };

  const options: Options = {
    pathToClaudeCodeExecutable: bin,
    cwd: policy.dir,
    settingSources: policy.projectSettings ? ["user", "project", "local"] : ["user"],
    strictMcpConfig: true,
    mcpServers: policy.mcpServers as NonNullable<Options["mcpServers"]>,
    // Without a mode picked on a device, the session follows the machine's own
    // Claude settings (permissions.defaultMode and allow/deny rules).
    includePartialMessages: true,
    canUseTool,
  };
  // A profile picked on the machine: its own sign-in, the shared projects.
  if (policy.accountDir) options.env = claudeEnv(policy.accountDir);
  if (policy.model) options.model = policy.model;
  if (policy.effort) options.effort = policy.effort as EffortLevel;
  if (policy.permissionMode) options.permissionMode = policy.permissionMode as PermissionMode;
  if (policy.allowBypass) options.allowDangerouslySkipPermissions = true;
  if (resumeId) options.resume = resumeId;

  const q = queryFn({ prompt: inbox, options });
  const mapper = new MessageMapper(policy.dir, (e) => events.push(e));
  let hidden: string[] = [];

  void (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "result") {
          turnOpen = false;
          const state = interrupted ? "interrupted" : msg.subtype === "success" && !msg.is_error ? "completed" : "failed";
          interrupted = false;
          await pushUsage(q, events);
          await pushInfo(q, events);
          events.push({ type: "turn-end", state, durationMs: Math.round(performance.now() - turnStart) });
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          hidden = msg.terminal_slash_commands ?? [];
          events.push({ type: "info", permissionMode: msg.permissionMode, effort: msg.effort ?? "" });
          void q.accountInfo().then(
            (a) => {
              const account = toAccount(a);
              if (account) events.push({ type: "info", account });
            },
            () => undefined,
          );
          void q.supportedCommands().then(
            (list) => events.push({ type: "info", commands: toCommands(list, hidden) }),
            () => undefined,
          );
        } else if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
          events.push({ type: "info", permissionMode: msg.permissionMode });
        } else if (msg.type === "system" && msg.subtype === "commands_changed") {
          events.push({ type: "info", commands: toCommands(msg.commands, hidden) });
        }
        mapper.map(msg);
      }
    } catch (err) {
      // After an interrupted turn the SDK ends the stream by throwing.
      if (!interrupted && !closed) events.push({ type: "error", message: (err as Error).message.slice(0, 500) });
    } finally {
      if (turnOpen) {
        events.push({ type: "turn-end", state: interrupted || closed ? "interrupted" : "failed", durationMs: 0 });
      }
      events.close();
    }
  })();

  return {
    events,
    async send(text) {
      if (closed) throw new Error("session closed");
      turnStart = performance.now();
      turnOpen = true;
      inbox.push(userMessage(text));
    },
    async interrupt() {
      if (closed || !turnOpen) return;
      interrupted = true;
      try {
        await q.interrupt();
      } catch {
        // the session ended meanwhile
      }
    },
    async setModel(model) {
      if (closed) return;
      await q.setModel(model);
    },
    async setEffort(effort) {
      if (closed) return;
      // null drops the session override, back to the user's own settings.
      await q.applyFlagSettings({ effortLevel: effort === "" ? null : (effort as EffortLevel) });
      events.push({ type: "info", effort });
    },
    async setPermissionMode(mode) {
      if (closed) return;
      await q.setPermissionMode(mode as PermissionMode);
      events.push({ type: "info", permissionMode: mode });
    },
    async close() {
      if (closed) return;
      closed = true;
      inbox.close();
      try {
        q.close();
      } catch {
        // already gone
      }
    },
  };
}

const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

type Usage = Awaited<ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>>;
type RateLimits = ProviderInfo["rateLimits"];

/** The 5-hour and weekly windows of a usage report; undefined when it has neither. */
function rateLimitsOf(u: Usage): RateLimits {
  const r = u.rate_limits;
  const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined) =>
    w && w.utilization !== null ? { utilization: Math.round(w.utilization), resetsAt: ts(w.resets_at) } : undefined;
  const fiveHour = win(r?.five_hour);
  const sevenDay = win(r?.seven_day);
  return fiveHour || sevenDay ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } : undefined;
}

/** Plan usage, lines changed and the command list, after each turn. */
async function pushInfo(q: Query, events: Channel<ProviderEvent>) {
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const rateLimits = rateLimitsOf(u);
    events.push({
      type: "info",
      linesAdded: u.session.total_lines_added,
      linesRemoved: u.session.total_lines_removed,
      ...(rateLimits ? { rateLimits } : {}),
    });
  } catch {
    // experimental API missing or changed on this CLI version
  }
}

/**
 * Plan usage of an account without sending a message: a session with no
 * prompt starts, reports usage and closes. null when unknown (signed out,
 * or the experimental API is missing on this claude).
 */
export async function probeUsage(bin: string, accountDir: string | undefined, queryFn: QueryFn = (p) => sdkQuery(p)): Promise<NonNullable<RateLimits> | null> {
  const inbox = new Channel<SDKUserMessage>();
  const options: Options = { pathToClaudeCodeExecutable: bin, cwd: homedir(), settingSources: [], strictMcpConfig: true, mcpServers: {} };
  if (accountDir) options.env = claudeEnv(accountDir);
  const q = queryFn({ prompt: inbox, options });
  try {
    await q.initializationResult();
    return rateLimitsOf(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })) ?? null;
  } catch {
    return null;
  } finally {
    inbox.close();
    try {
      q.close();
    } catch {
      // already gone
    }
  }
}

export function toCommands(list: { name: string; description: string; argumentHint: string; builtin?: boolean }[], hide: string[] = []) {
  return list
    .filter((c) => !hide.includes(c.name))
    .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint, builtin: Boolean(c.builtin) }));
}

async function pushUsage(q: Query, events: Channel<ProviderEvent>) {
  try {
    const u = await q.getContextUsage({ detail: "summary" });
    events.push({ type: "usage", contextTokens: u.totalTokens, contextWindow: u.maxTokens });
  } catch {
    // not available on this CLI version
  }
}


/** Maps SDK messages of the top-level conversation onto ProviderEvents. */
export class MessageMapper {
  private messageId = "";
  private streamed = new Set<string>();
  private blocks = new Map<number, { id: string; role: "assistant" | "thinking"; text: string }>();
  private subagents = new Set<string>();
  private hidden = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly emit: (e: ProviderEvent) => void,
  ) {}

  map(msg: SDKMessage): void {
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return; // inside a subagent
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.emit({ type: "session", sessionId: msg.session_id });
        else if (msg.subtype === "compact_boundary") this.emit({ type: "compaction", tokensBefore: msg.compact_metadata.pre_tokens });
        return;
      case "stream_event":
        this.stream(msg.event);
        return;
      case "assistant":
        this.assistant(msg);
        return;
      case "user":
        this.toolResults(msg.message.content);
        return;
      default:
        return;
    }
  }

  private stream(ev: Extract<SDKMessage, { type: "stream_event" }>["event"]) {
    if (ev.type === "message_start") {
      this.messageId = ev.message.id;
      this.streamed.add(ev.message.id);
      this.blocks.clear();
    } else if (ev.type === "content_block_start") {
      const t = ev.content_block.type;
      if (t === "text" || t === "thinking") {
        this.blocks.set(ev.index, { id: `${this.messageId}:${ev.index}`, role: t === "text" ? "assistant" : "thinking", text: "" });
      }
    } else if (ev.type === "content_block_delta") {
      const b = this.blocks.get(ev.index);
      if (!b) return;
      const d = ev.delta;
      const text = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : "";
      if (!text) return;
      b.text += text;
      this.emit({ type: "text-delta", blockId: b.id, role: b.role, text });
    } else if (ev.type === "content_block_stop") {
      const b = this.blocks.get(ev.index);
      if (b) this.emit({ type: "text", blockId: b.id, role: b.role, text: b.text });
      this.blocks.delete(ev.index);
    }
  }

  private assistant(msg: Extract<SDKMessage, { type: "assistant" }>) {
    if (msg.error === "authentication_failed" || msg.error === "oauth_org_not_allowed") {
      this.emit({ type: "error", message: "Claude needs to sign in again on this machine.", needsLogin: true });
    }
    const streamed = this.streamed.has(msg.message.id);
    msg.message.content.forEach((block, i) => {
      if (block.type === "text" && !streamed) {
        this.emit({ type: "text", blockId: `${msg.message.id}:${i}:${msg.uuid}`, role: "assistant", text: block.text });
      } else if (block.type === "tool_use") {
        this.toolUse(block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
      }
    });
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>) {
    if (name === "AskUserQuestion") {
      this.hidden.add(id);
      return;
    }
    if (name === "TodoWrite") {
      this.hidden.add(id);
      const todos = (input.todos as { content?: string; status?: string }[] | undefined) ?? [];
      const entries: TodoEntry[] = todos.map((t) => ({
        text: t.content ?? "",
        state: t.status === "completed" ? "done" : t.status === "in_progress" ? "in-progress" : "pending",
      }));
      this.emit({ type: "todo", entries });
      return;
    }
    const kind = toolKind(name);
    if (kind === "subagent") {
      this.subagents.add(id);
      this.emit({ type: "subagent", toolId: id, description: toolSummary(name, input, this.dir), done: false });
      return;
    }
    this.emit({
      type: "tool-start",
      toolId: id,
      kind,
      name,
      summary: toolSummary(name, input, this.dir),
      input: JSON.stringify(input),
    });
    const diff = toolDiff(name, input, this.dir);
    if (diff) this.emit({ type: "diff", toolId: id, ...diff });
  }

  private toolResults(content: unknown) {
    if (!Array.isArray(content)) return;
    for (const b of content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      if (this.hidden.has(b.tool_use_id)) continue;
      if (this.subagents.has(b.tool_use_id)) {
        this.emit({ type: "subagent", toolId: b.tool_use_id, description: "", done: true });
        continue;
      }
      this.emit({ type: "tool-end", toolId: b.tool_use_id, ok: !b.is_error, output: resultText(b.content) });
    }
  }
}

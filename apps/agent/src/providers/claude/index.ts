// Claude Code adapter: drives the `claude` binary the user installed and
// logged into, through the Agent SDK. It never reads credentials and never
// calls the Anthropic API itself.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AccountInfo as SdkAccountInfo,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { SESSION_MCP_SERVER, isWriteTool, needsApproval } from "../../mcp/groups.ts";
import { type SessionMcp, TICKET_ENV } from "../../mcp/session-tickets.ts";
import { redactDeep } from "../../mcp/redact.ts";
import type { SessionSecretHooks } from "../../sign-in-secrets/secret-env.ts";
import { envName, envNamesIn } from "../../sign-in-secrets/secret-names.ts";
import { claudeEnv, readAccount } from "../../profiles/account.ts";
import { defaultClaudeHome } from "../../profiles/paths.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import { selfCommand } from "../../service.ts";
import { Channel } from "../../util/channel.ts";
import type {
  AccountInfo,
  AgentProvider,
  AskUser,
  CommandsRequest,
  Detected,
  DetectOptions,
  ImageInput,
  ProviderCapabilities,
  ProviderEvent,
  ProviderInfo,
  ProviderSession,
  Question,
  SessionPolicy,
  SlashCommand,
  TerminalCommand,
  TerminalLaunch,
  TurnStats,
} from "../types.ts";
import { LocalSessions } from "./local-sessions.ts";
import { MessageMapper } from "./message-mapper.ts";
import { claudeWriter } from "./one-shot-writer.ts";
import { ClaudeUsage } from "./usage-scan.ts";
import { toolKind, toolPaths, toolSummary } from "./tool-map.ts";

export { MessageMapper };

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
  images: true,
  models: [
    { id: "opus", name: "Opus" },
    { id: "sonnet", name: "Sonnet" },
    { id: "haiku", name: "Haiku" },
  ],
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  // bypassPermissions and dontAsk are left out: a device may only return to
  // bypass when the machine's own settings start sessions in it.
  permissionModes: ["default", "acceptEdits", "plan", "auto"],
  sessionMcp: true,
};

/**
 * The "model" of the account folder's settings.json (what a session that
 * picks none runs with); undefined without one, or when it is not a short
 * plain name. Reads only that setting, never a credential.
 */
export function settingsModel(home: string): string | undefined {
  try {
    const model: unknown = (JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { model?: unknown }).model;
    return typeof model === "string" && /^[\w.:[\]-]{1,80}$/.test(model.trim()) ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

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

export function createClaudeProvider(
  deps: {
    query?: QueryFn;
    findBinary?: () => Promise<string | null>;
    /** The machine's Claude folders whose sessions are listed (its own, then each profile's). */
    homes?: () => string[];
  } = {},
): AgentProvider {
  const queryFn: QueryFn = deps.query ?? ((p) => sdkQuery(p));
  const findBinary = deps.findBinary ?? findClaude;
  const homes = deps.homes ?? (() => [defaultClaudeHome()]);
  const history = new LocalSessions({ homes });

  return {
    id: "claude",
    name: "Claude Code",
    capabilities: CLAUDE_CAPABILITIES,
    history,
    usage: new ClaudeUsage({ homes }),
    writer: claudeWriter(findBinary, CLAUDE_CAPABILITIES.models.map((m) => m.id)),

    async listCommands(req) {
      const bin = await findBinary();
      return bin ? probeCommands(bin, req, queryFn) : [];
    },

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
      const defaultModel = settingsModel(opts.accountDir ?? defaultClaudeHome());
      if (defaultModel) out.defaultModel = defaultModel;
      return out;
    },

    async start({ policy, resumeId, askUser }) {
      const bin = await findBinary();
      if (!bin) throw new Error("claude is not installed");
      return startSession(queryFn, bin, policy, askUser, resumeId);
    },

    terminal: {
      async command(req) {
        const bin = await findBinary();
        return bin ? terminalCommand(bin, req, randomUUID) : undefined;
      },
    },
  };
}

/** Claude's session ids (UUIDs): nothing else becomes an argument. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `claude` for a thread in the terminal, with what the chat view would use:
 * its session (resumed, or a new one with an id picked here), model,
 * permission mode and account. Only values from Claude's own lists become
 * arguments. Setting sources stay the CLI's own (user, project, local): the
 * folder's skills, commands and settings load as in any terminal, after the
 * CLI's own folder trust prompt.
 */
export function terminalCommand(bin: string, req: TerminalLaunch, newId: () => string): TerminalCommand {
  const args: string[] = [];
  let sessionId: string | undefined;
  if (req.resumeId !== undefined) {
    if (!SESSION_ID.test(req.resumeId)) throw new Error("not a Claude session id");
    args.push("--resume", req.resumeId);
  } else {
    sessionId = newId();
    args.push("--session-id", sessionId);
  }
  if (req.model && CLAUDE_CAPABILITIES.models.some((m) => m.id === req.model)) args.push("--model", req.model);
  if (req.permissionMode && CLAUDE_CAPABILITIES.permissionModes.includes(req.permissionMode)) args.push("--permission-mode", req.permissionMode);
  return { file: bin, args, env: req.accountDir ? { CLAUDE_CONFIG_DIR: req.accountDir } : {}, ...(sessionId ? { sessionId } : {}) };
}

/**
 * tunelo's own MCP in a session: `tunelo mcp` over stdio, with the
 * session's ticket. It holds no token; the service adds them.
 */
export function sessionMcpServer(mcp: SessionMcp): McpServerConfig {
  const [command = process.execPath, ...args] = selfCommand("mcp");
  return { type: "stdio", command, args, env: { [TICKET_ENV]: mcp.ticket, TUNELO_HOME: mcp.configDir } };
}

/** How much of a tool's input an approval card shows. */
const CARD_INPUT_CHARS = 4000;

/**
 * The machine's MCP servers without any that runs `tunelo mcp` under
 * another name: the session has tunelo's own, whose writes are guarded.
 */
export function withoutTuneloMcp(servers: Record<string, unknown>): NonNullable<Options["mcpServers"]> {
  const runsTunelo = (config: unknown): boolean => {
    const { command, args } = (config ?? {}) as { command?: unknown; args?: unknown };
    if (typeof command !== "string" || !Array.isArray(args) || !args.includes("mcp")) return false;
    // Either separator: a config may name a Windows path.
    const name = (command.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
    return name === "tunelo" || command === process.execPath;
  };
  return Object.fromEntries(Object.entries(servers).filter(([, config]) => !runsTunelo(config))) as NonNullable<Options["mcpServers"]>;
}

const WRITE_APPROVAL_REASON = "It acts as you in Chat, Localman or on the internet: tunelo asks you every time.";

/**
 * PreToolUse: a write tool of tunelo's MCP always goes to the device for
 * approval, even under an allow rule or in auto mode, unless the session
 * runs in bypassPermissions (which only the machine's own settings start).
 * A two-step tool is asked about on the call that acts (with its
 * confirm_token), not on the dry run before it.
 */
export const writeApprovalHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (input.permission_mode === "bypassPermissions") return {};
  if (!needsApproval(input.tool_name, input.tool_input)) return {};
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: WRITE_APPROVAL_REASON },
  };
};

/** Tools whose own card on the device is the question to the user: no approval card before them. */
const ASKS_ON_DEVICE = new Set(["request_secret", "request_takeover"].map((tool) => `mcp__${SESSION_MCP_SERVER}__${tool}`));

/** request_secret and request_takeover ask the user on the device itself: no approval card before them. */
export const secretRequestHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || !ASKS_ON_DEVICE.has(input.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
};

/**
 * After every tool: what happened in the tunelo browser that Claude should
 * know (a page asked for a passkey nobody at the machine can give), once.
 */
export function browserNoticeHook(take: () => string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    const notices = take();
    if (notices.length === 0) return {};
    return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: notices.join("\n") } };
  };
}

const commandOf = (input: unknown): string => {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
};

/**
 * PreToolUse of Bash: a command that names `$TUNELO_SECRET_<NAME>` goes to
 * the device for approval (unless the session runs in bypassPermissions,
 * where it gets its secrets at once); names the session was not given are
 * pointed out to Claude.
 */
export function secretCommandHook(secrets: SessionSecretHooks): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const command = commandOf(input.tool_input);
    const { given, missing } = secrets.namesIn(command);
    if (given.length === 0 && missing.length === 0) return {};
    const note = missing.length
      ? { additionalContext: `${missing.map(envName).join(", ")} ${missing.length > 1 ? "are" : "is"} not set: get the secret with request_secret first.` }
      : {};
    if (given.length > 0 && input.permission_mode !== "bypassPermissions") {
      // No reason in words: the device says it in the user's language, from the command itself.
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", ...note } };
    }
    if (given.length > 0) await secrets.beforeCommand(input.tool_use_id, command);
    return missing.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...note } } : {};
  };
}

/**
 * After every tool: a command's secrets leave its environment file, and no
 * secret value reaches Claude (or its transcript) in a tool's output.
 */
export function secretOutputHook(secrets: SessionSecretHooks | undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name === "PostToolUseFailure") {
      secrets?.afterCommand(input.tool_use_id);
      return {};
    }
    if (input.hook_event_name !== "PostToolUse") return {};
    secrets?.afterCommand(input.tool_use_id);
    const output = redactDeep(input.tool_response);
    if (output === input.tool_response) return {};
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: output } };
  };
}

/** A permission rule as Claude writes it: `Tool` or `Tool(content)`, parentheses in the content escaped. */
export function ruleString(rule: { toolName: string; ruleContent?: string }): string {
  if (!rule.ruleContent) return rule.toolName;
  return `${rule.toolName}(${rule.ruleContent.replace(/\\/g, "\\\\").replace(/[()]/g, (c) => `\\${c}`)})`;
}

/**
 * A session allow rule tunelo may hand back to claude: never one for tunelo's
 * own MCP as a whole or for its write tools (those are asked about every
 * time), never a wildcard tool name.
 */
export function replayableRule(rule: string): boolean {
  const tool = rule.split("(")[0] ?? "";
  if (tool === "" || tool.includes("*")) return false;
  const ownServer = `mcp__${SESSION_MCP_SERVER}`;
  if (tool === ownServer || tool === `${ownServer}__`) return false;
  return !isWriteTool(tool);
}

/** What Claude reads as the tool's answer: like the terminal's "No, and tell Claude what to do differently". */
export function denialText(message: string | undefined): string {
  const said = message?.trim();
  if (!said) return "The user denied this from their device.";
  return `The user denied this from their device and said:\n${said}`;
}

/** A user turn: the images first (as Claude reads them best), then the text. */
export function userMessage(text: string, images: readonly ImageInput[] = []): SDKUserMessage {
  if (images.length === 0) return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
  const content = [
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: Buffer.from(img.data).toString("base64") },
    })),
    ...(text.trim() === "" ? [] : [{ type: "text" as const, text }]),
  ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage;
}

function startSession(queryFn: QueryFn, bin: string, policy: SessionPolicy, askUser: AskUser, resumeId?: string): ProviderSession {
  const inbox = new Channel<SDKUserMessage>();
  const events = new Channel<ProviderEvent>();
  // No sign-in secret value goes to the devices or the journal.
  const emit = (e: ProviderEvent) => events.push(redactDeep(e));
  const secrets = policy.sessionMcp?.secrets;
  const browserNotices = policy.sessionMcp?.browserNotices;
  const notices = browserNotices ? [browserNoticeHook(browserNotices)] : [];
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
    // A write of tunelo's MCP: the card names what it does, and the service runs it only once approved here.
    const write = policy.sessionMcp && needsApproval(toolName, input) ? policy.sessionMcp : undefined;
    const summary = (write && (await write.describeWrite(toolName, input).catch(() => undefined))) || toolSummary(toolName, input, policy.dir);
    const full = JSON.stringify(input);
    const cut = full.length > CARD_INPUT_CHARS ? `The input shown is cut: ${full.length} characters in all.` : "";
    // A command reading a sign-in secret: the device words why it asks (from $TUNELO_SECRET_* in the input).
    const usesSecret = toolName === "Bash" && envNamesIn(command).length > 0;
    const reason = [usesSecret ? "" : (opts.decisionReason ?? ""), cut].filter(Boolean).join(" ");
    const req = {
      kind: "approval" as const,
      toolId: opts.toolUseID ?? "",
      toolKind: toolKind(toolName),
      name: toolName,
      summary,
      input: full.slice(0, CARD_INPUT_CHARS),
      sensitive,
      ...(reason ? { reason } : {}),
      // Named with their sites, so the card shows where each one belongs.
      ...(usesSecret ? { secrets: secrets ? secrets.sitesIn(command) : envNamesIn(command).map((name) => ({ name, origin: "" })) } : {}),
    };
    const answer = await askUser(req, opts.signal);
    if (answer.decision === "deny") return { behavior: "deny", message: denialText(answer.message) };
    const { decision } = answer;
    write?.approveWrite(toolName, input);
    // Approved: the secrets the command names go where its shell loads them, until it ends.
    if (secrets && toolName === "Bash" && opts.toolUseID) await secrets.beforeCommand(opts.toolUseID, command);
    // A write tool of tunelo's MCP is asked about every time: no rule for the session.
    // A command reading a sign-in secret is asked about every time: an older device's "allow for the session" counts once.
    if (decision === "allow-session" && !sensitive && !isWriteTool(toolName) && !usesSecret) {
      // Only allow rules for this session: a remote "allow for the session"
      // must never switch the permission mode or add directories.
      const suggested = (opts.suggestions ?? []).filter((s) => s.type === "addRules" && s.behavior === "allow");
      const rules: PermissionUpdate[] = suggested.length
        ? suggested.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate)
        : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
      // Kept by tunelo with the thread: a session opened again gets them back (allowedTools).
      const kept = rules.flatMap((u) => (u.type === "addRules" ? u.rules.map(ruleString) : [])).filter(replayableRule);
      if (kept.length) emit({ type: "session-rules", rules: kept });
      return { behavior: "allow", updatedInput: input, updatedPermissions: rules };
    }
    return { behavior: "allow", updatedInput: input };
  };

  const options: Options = {
    pathToClaudeCodeExecutable: bin,
    cwd: policy.dir,
    settingSources: policy.projectSettings ? ["user", "project", "local"] : ["user"],
    strictMcpConfig: true,
    mcpServers: policy.sessionMcp
      ? { ...withoutTuneloMcp(policy.mcpServers), [SESSION_MCP_SERVER]: sessionMcpServer(policy.sessionMcp) }
      : (policy.mcpServers as NonNullable<Options["mcpServers"]>),
    // Also guards a `tunelo` MCP the machine's own config adds.
    hooks: {
      PreToolUse: [
        { matcher: `^mcp__${SESSION_MCP_SERVER}__`, hooks: [writeApprovalHook, secretRequestHook] },
        ...(secrets ? [{ matcher: "^Bash$", hooks: [secretCommandHook(secrets)] }] : []),
      ],
      PostToolUse: [{ hooks: [secretOutputHook(secrets), ...notices] }],
      PostToolUseFailure: [{ hooks: [secretOutputHook(secrets), ...notices] }],
    },
    // Without a mode picked on a device, the session follows the machine's own
    // Claude settings (permissions.defaultMode and allow/deny rules).
    includePartialMessages: true,
    canUseTool,
  };
  // A profile picked on the machine: its own sign-in, the shared projects.
  if (policy.accountDir) options.env = claudeEnv(policy.accountDir);
  // Claude Code runs this before every Bash command: the secrets a running command may read (secret-env.ts).
  if (secrets) options.env = { ...(options.env ?? claudeEnv(undefined)), CLAUDE_ENV_FILE: secrets.loader };
  if (policy.model) options.model = policy.model;
  if (policy.effort) options.effort = policy.effort as EffortLevel;
  if (policy.permissionMode) options.permissionMode = policy.permissionMode as PermissionMode;
  if (policy.allowBypass) options.allowDangerouslySkipPermissions = true;
  if (resumeId) options.resume = resumeId;
  // "Allow for the session" given before this process: the same allow rules, from tunelo's own record.
  const sessionRules = (policy.sessionRules ?? []).filter(replayableRule);
  if (sessionRules.length) options.allowedTools = sessionRules;

  const q = queryFn({ prompt: inbox, options });
  const mapper = new MessageMapper(policy.dir, emit);
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
          emit({ type: "turn-end", state, durationMs: Math.round(performance.now() - turnStart), stats: turnStats(msg, mapper.model) });
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          hidden = msg.terminal_slash_commands ?? [];
          emit({ type: "info", permissionMode: msg.permissionMode, effort: msg.effort ?? "" });
          void q.accountInfo().then(
            (a) => {
              const account = toAccount(a);
              if (account) emit({ type: "info", account });
            },
            () => undefined,
          );
          void q.supportedCommands().then(
            (list) => emit({ type: "info", commands: toCommands(list, hidden) }),
            () => undefined,
          );
        } else if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
          emit({ type: "info", permissionMode: msg.permissionMode });
        } else if (msg.type === "system" && msg.subtype === "commands_changed") {
          emit({ type: "info", commands: toCommands(msg.commands, hidden) });
        }
        mapper.map(msg);
      }
    } catch (err) {
      // After an interrupted turn the SDK ends the stream by throwing.
      if (!interrupted && !closed) emit({ type: "error", message: (err as Error).message.slice(0, 500) });
    } finally {
      if (turnOpen) {
        emit({ type: "turn-end", state: interrupted || closed ? "interrupted" : "failed", durationMs: 0 });
      }
      events.close();
    }
  })();

  return {
    events,
    async send(text, images) {
      if (closed) throw new Error("session closed");
      turnStart = performance.now();
      turnOpen = true;
      inbox.push(userMessage(text, images));
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
      emit({ type: "info", effort });
    },
    async setPermissionMode(mode) {
      if (closed) return;
      await q.setPermissionMode(mode as PermissionMode);
      emit({ type: "info", permissionMode: mode });
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

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * The turn's numbers from its result: tokens and round trips of this turn
 * (its own conversation), API time and cost as the session's running totals
 * (in streaming input they add up over the session).
 */
export function turnStats(msg: ResultMessage, model: string): TurnStats {
  const u = msg.usage;
  return {
    model,
    inputTokens: count(u?.input_tokens),
    outputTokens: count(u?.output_tokens),
    cacheReadTokens: count(u?.cache_read_input_tokens),
    cacheWriteTokens: count(u?.cache_creation_input_tokens),
    numTurns: count(msg.num_turns),
    apiMsTotal: count(msg.duration_api_ms),
    costUsdTotal: count(msg.total_cost_usd),
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
 * the experimental API missing on this claude, or no answer within
 * `timeoutMs`); the claude it started is stopped in every case.
 */
export async function probeUsage(
  bin: string,
  accountDir: string | undefined,
  queryFn: QueryFn = (p) => sdkQuery(p),
  timeoutMs = 15_000,
): Promise<NonNullable<RateLimits> | null> {
  const inbox = new Channel<SDKUserMessage>();
  const abort = new AbortController();
  const options: Options = { pathToClaudeCodeExecutable: bin, cwd: homedir(), settingSources: [], strictMcpConfig: true, mcpServers: {}, abortController: abort };
  if (accountDir) options.env = claudeEnv(accountDir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let q: Query | undefined;
  try {
    q = queryFn({ prompt: inbox, options });
    const started = q;
    const read = (async () => {
      await started.initializationResult();
      return rateLimitsOf(await started.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })) ?? null;
    })().catch(() => null);
    return await Promise.race([read, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    inbox.close();
    abort.abort();
    try {
      q?.close();
    } catch {
      // already gone
    }
  }
}

/**
 * The slash commands and skills a session in `req.dir` offers, from a session
 * that starts with no prompt, reports them and closes: no message is sent and
 * no turn runs. The setting sources are a session's own (the folder's skills
 * only with projectSettings). Empty when unknown within `timeoutMs`; the
 * claude it started is stopped in every case.
 */
export async function probeCommands(bin: string, req: CommandsRequest, queryFn: QueryFn = (p) => sdkQuery(p), timeoutMs = 15_000): Promise<SlashCommand[]> {
  const inbox = new Channel<SDKUserMessage>();
  const abort = new AbortController();
  const options: Options = {
    pathToClaudeCodeExecutable: bin,
    cwd: req.dir,
    settingSources: req.projectSettings ? ["user", "project", "local"] : ["user"],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    abortController: abort,
  };
  if (req.accountDir) options.env = claudeEnv(req.accountDir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SlashCommand[]>((resolve) => {
    timer = setTimeout(() => resolve([]), timeoutMs);
  });
  let q: Query | undefined;
  try {
    q = queryFn({ prompt: inbox, options });
    const read = q.supportedCommands().then(
      (list) => toCommands(list),
      () => [],
    );
    return await Promise.race([read, timeout]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    inbox.close();
    abort.abort();
    try {
      q?.close();
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

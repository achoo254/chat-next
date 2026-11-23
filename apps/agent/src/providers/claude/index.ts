// Claude Code adapter: drives the `claude` binary the user installed and
// logged into, through the Agent SDK. It never reads credentials and never
// calls the Anthropic API itself.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  type Settings,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { SESSION_MCP_SERVER, isWriteTool, needsApproval } from "../../mcp/groups.ts";
import { TERMINAL_ADVISOR_MCP_SERVER } from "../../mcp/session-mcp-server.ts";
import type { SessionMcp } from "../../mcp/session-tickets.ts";
import { loopbackNoProxy, sessionMcpHttp, sessionMcpLaunch } from "../../mcp/session-mcp-launch.ts";
import { redactDeep } from "../../mcp/redact.ts";
import { ADVISOR_OFF_REFUSAL } from "../../advisor/advisor-tools.ts";
import { ADVISOR_GIT_ONLY, ADVISOR_ONLY_TOOLS, CLAUDE_ADVISOR_DISALLOWED, CLAUDE_ADVISOR_TOOLS, advisorGuard, claudeOwnTool } from "../../advisor/advisor-guard.ts";
import { hideSecretShapes } from "../../advisor/scrub-git-output.ts";
import type { SessionSecretHooks } from "../../sign-in-secrets/secret-env.ts";
import { envName, envNamesIn } from "../../sign-in-secrets/secret-names.ts";
import type { AccountsStore } from "../../accounts/store.ts";
import type { AuditLog } from "../../safety/audit-log.ts";
import { claudeEnv, readAccount } from "./accounts/account.ts";
import { CLAUDE_PROVIDER_ID, defaultClaudeHome, profilesRoot } from "./accounts/paths.ts";
import { ClaudeProfiles } from "./accounts/service.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import { macFolderAfterRestart, macFolderBeforeCall, macFolderRefusedByUser } from "../../safety/mac-folders.ts";
import { claudeSandboxOn, sandboxedProgram } from "../../safety/mac-sandbox.ts";
import { Channel } from "../../util/channel.ts";
import type {
  AccountInfo,
  AgentProvider,
  AskUser,
  CommandsRequest,
  Detected,
  DetectOptions,
  ImageInput,
  SessionNote,
  ProviderCapabilities,
  ProviderEvent,
  ProviderInfo,
  ProviderSession,
  Question,
  SessionObserver,
  SessionPolicy,
  SlashCommand,
  TerminalCommand,
  TerminalLaunch,
  TurnStats,
} from "../types.ts";
import { LocalSessions } from "./local-sessions.ts";
import type { ProcessStartLookup } from "./process-start.ts";
import { MessageMapper } from "./message-mapper.ts";
import { claudeWriter } from "./one-shot-writer.ts";
import { ClaudeUsage } from "./usage-scan.ts";
import { toolKind, toolPaths, toolSummary } from "./tool-map.ts";
import { MIN_CLAUDE_VERSION, versionAtLeast } from "../../observatory/install/observatory-install-checks.ts";
import {
  ADVISOR_LABEL,
  type CliSettings,
  OBSERVED_ADVISOR_EVENTS,
  OBSERVED_SDK_EVENTS,
  ObservedSessionLifecycle,
  withObservatoryHookGroups,
  withObservedHooks,
} from "./observatory-session-hooks.ts";

export { MessageMapper };

const run = promisify(execFile);

/** Claude's mode that skips every prompt: a device may only return to it when the machine starts there. */
const BYPASS_MODE = "bypassPermissions";

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
  bypassModeId: BYPASS_MODE,
  sessionMcp: true,
  sessionNotes: true,
  // Every tool call reaches tunelo's PreToolUse hook and canUseTool, in any mode.
  advisorSession: true,
  // The CLI takes --mcp-config and a UserPromptSubmit hook (terminalCommand).
  terminalAdvisor: true,
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

/** The machine's Claude folder and the home of every Claude profile under tunelo's config folder `configDir`. */
export function claudeHomesIn(configDir: string): string[] {
  const homes = [defaultClaudeHome()];
  try {
    for (const entry of readdirSync(profilesRoot(configDir), { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(join(profilesRoot(configDir), entry.name, "home"));
    }
  } catch {
    // no profiles yet
  }
  return homes;
}

/** What Claude's accounts need from the machine (see AccountsFacet). */
export type ClaudeAccountsDeps = {
  configDir: string;
  store: AccountsStore;
  audit: AuditLog;
  /** A session of this AI is open with this account (it may not be removed then). */
  inUse: (id: string) => boolean;
  /** Usage just read for an account, for the sessions' status line. */
  onUsage: (id: string, usage: NonNullable<RateLimits>) => void;
  log: (line: string) => void;
};

export function createClaudeProvider(
  deps: {
    query?: QueryFn;
    findBinary?: () => Promise<string | null>;
    /** The machine's Claude folders whose sessions are listed; its own, then each account's when `accounts` is given. */
    homes?: () => string[];
    /** Several Claude accounts on the machine; without it, only the machine's own sign-in. */
    accounts?: ClaudeAccountsDeps;
    /** When a running process started, as the system tells (LocalSessionsOptions.processStart); tests replace it. */
    processStart?: ProcessStartLookup;
    /** Observatory for the working sessions (sessions and terminals; never the probes or the writer); undefined while it is off. */
    observer?: () => SessionObserver | undefined;
  } = {},
): AgentProvider {
  const queryFn: QueryFn = deps.query ?? ((p) => sdkQuery(p));
  const findBinary = deps.findBinary ?? findClaude;
  const a = deps.accounts;
  const accounts = a
    ? new ClaudeProfiles({
        configDir: a.configDir,
        store: a.store,
        audit: a.audit,
        findBinary,
        probeUsage: (bin, dir) => probeUsage(bin, dir, queryFn),
        inUse: a.inUse,
        onUsage: a.onUsage,
        log: a.log,
      })
    : undefined;
  const homes = deps.homes ?? (accounts ? () => accounts.claudeHomes() : () => [defaultClaudeHome()]);
  const history = new LocalSessions({ homes, ...(deps.processStart ? { processStart: deps.processStart } : {}) });
  // Whether the installed claude runs hooks in exec form (Observatory's terminal hooks), by binary, as `--version` told.
  const execHooks = new Map<string, boolean>();
  const runsExecHooks = async (bin: string): Promise<boolean> => {
    const known = execHooks.get(bin);
    if (known !== undefined) return known;
    const version = await run(bin, ["--version"], { timeout: 15_000 }).then(
      (r) => r.stdout,
      () => undefined,
    );
    if (version === undefined) return false;
    execHooks.set(bin, versionAtLeast(version, MIN_CLAUDE_VERSION));
    return execHooks.get(bin) === true;
  };

  return {
    id: CLAUDE_PROVIDER_ID,
    name: "Claude Code",
    capabilities: CLAUDE_CAPABILITIES,
    ...(accounts ? { accounts } : {}),
    shellEnv: (account) => (account ? { CLAUDE_CONFIG_DIR: account.dir } : {}),
    // Claude Code's IDE extensions leave <claude folder>/ide/<port>.lock; ~/.claude too when CLAUDE_CONFIG_DIR moved it.
    ideLockDirs: () => [...new Set([...homes(), join(homedir(), ".claude")])].map((h) => join(h, "ide")),
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
      const account = await readAccount(bin, opts.account?.dir);
      const loginState: Detected["loginState"] = account === null ? "unknown" : account.loggedIn ? "ok" : "needs-login";
      const minor = version?.split(".").slice(0, 2).join(".");
      const out: Detected = { installed: true, loginState, untestedVersion: !minor || !TESTED.includes(minor) };
      if (version) {
        out.version = version;
        execHooks.set(bin, versionAtLeast(version, MIN_CLAUDE_VERSION));
      }
      const defaultModel = settingsModel(opts.account?.dir ?? defaultClaudeHome());
      if (defaultModel) out.defaultModel = defaultModel;
      return out;
    },

    async start({ policy, resumeId, askUser }) {
      const bin = await findBinary();
      if (!bin) throw new Error("claude is not installed");
      return startSession(queryFn, bin, policy, askUser, resumeId, deps.observer?.());
    },

    terminal: {
      async command(req) {
        const bin = await findBinary();
        if (!bin) return undefined;
        const observer = deps.observer?.();
        if (!observer) return terminalCommand(bin, req, randomUUID);
        const home = req.account?.dir ?? defaultClaudeHome();
        const observatory: TerminalObservatory = {
          hookCommand: (await runsExecHooks(bin)) ? withoutFailing(() => observer.hookCommand(home)) : undefined,
          otelEnv: withoutFailing(() => observer.otelEnv(home)),
          settingsFile: (json) => observer.privateSettingsFile(json),
        };
        return terminalCommand(bin, req, randomUUID, process.platform, observatory);
      },
    },
  };
}

/** The settings files a session loads that may turn on Claude Code's own sandbox. */
function claudeSettingsFiles(policy: SessionPolicy): string[] {
  const home = policy.account?.dir ?? defaultClaudeHome();
  const files = [join(home, "settings.json")];
  if (policy.projectSettings) files.push(join(policy.dir, ".claude", "settings.json"), join(policy.dir, ".claude", "settings.local.json"));
  return files;
}

/** What Observatory gives a session, or nothing when it fails: Observatory never keeps a session from opening. */
function withoutFailing<T>(give: () => T): T | undefined {
  try {
    return give();
  } catch {
    return undefined;
  }
}

/** Claude's session ids (UUIDs): nothing else becomes an argument. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Stop hook that does nothing, for the terminal's CLI: with any Stop hook,
 * claude records the end of each turn in the transcript (a stop_hook_summary
 * record), so the session reads idle the moment a turn ends rather than a
 * minute after its last write (local-sessions.ts). --settings adds this to
 * the user's own settings and hooks; "exit 0" runs in any shell claude uses.
 */
const TURN_END_HOOK = { hooks: [{ type: "command", command: "exit 0" }] };
export const TURN_END_SETTINGS = JSON.stringify({ hooks: { Stop: [TURN_END_HOOK] } });

/** How long the CLI waits for Advisor's note, or for the check as a turn ends, before going on without it (the commands themselves give up sooner). */
const NOTE_HOOK_TIMEOUT_S = 5;

/** advisor_weigh as the CLI in a terminal lists it: tunelo's MCP there is named apart from a "tunelo" the user added. */
const TERMINAL_ADVISOR_TOOL = { server: TERMINAL_ADVISOR_MCP_SERVER, fullName: `mcp__${TERMINAL_ADVISOR_MCP_SERVER}__advisor_weigh` };

/**
 * One argument for the shell the CLI runs a hook's command in (`sh -c` on
 * macOS and Linux, Git Bash on Windows): single-quoted, so nothing in it is
 * expanded. Where the CLI falls back to PowerShell (Windows without Git
 * Bash) the line does not parse and the hook fails with exit 1, which never
 * holds a message back (only exit 2 does).
 */
export function shellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * --settings and --mcp-config for automatic Advisor in the terminal (see
 * TerminalLaunch.advisor): the turn-end hook plus a UserPromptSubmit hook
 * that prints Advisor's note with each message, a Stop hook that holds a turn
 * which never asked for next steps (`tunelo advisor stop`), advisor_weigh allowed
 * without a prompt, and tunelo's MCP with the thread's ticket (advisor_weigh
 * only) under its own name (TERMINAL_ADVISOR_MCP_SERVER), so a "tunelo" MCP
 * the user added keeps working beside it. No key goes into either: the
 * ticket names the thread, the service holds the key. On macOS and Linux the
 * hook names tunelo's config folder (TUNELO_HOME), so a service running on
 * another folder than the default is the one asked; on Windows it does not
 * (Git Bash's own environment syntax is not relied on there).
 */
function advisorSettings(advisor: NonNullable<TerminalLaunch["advisor"]>, platform: NodeJS.Platform): CliSettings {
  if (advisor.noteCommand.length === 0 || advisor.stopCommand.length === 0) throw new Error("no command for Advisor's note");
  const home = platform === "win32" ? "" : `TUNELO_HOME=${shellArg(advisor.configDir)} `;
  return {
    hooks: {
      // The turn-end hook marks each turn's end; the second holds a turn that never asked for next steps, once.
      Stop: [TURN_END_HOOK, { hooks: [{ type: "command", command: home + advisor.stopCommand.map(shellArg).join(" "), timeout: NOTE_HOOK_TIMEOUT_S }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: home + advisor.noteCommand.map(shellArg).join(" "), timeout: NOTE_HOOK_TIMEOUT_S }] }],
    },
    permissions: { allow: [TERMINAL_ADVISOR_TOOL.fullName] },
  };
}

/**
 * --mcp-config for automatic Advisor in the terminal: tunelo's MCP with the thread's ticket, advisor_weigh only.
 * The service's own endpoint when the launch may use it (the ticket then rides in the environment, and the
 * terminal process adds loopback to NO_PROXY), else `tunelo mcp`.
 */
function advisorMcp(advisor: NonNullable<TerminalLaunch["advisor"]>): { args: string[]; env: Record<string, string> } {
  const http = sessionMcpHttp(advisor);
  const mcp = http?.config ?? { type: "stdio", ...sessionMcpLaunch({ ticket: advisor.ticket, configDir: advisor.configDir, advisorWeighOnly: true }) };
  return { args: ["--mcp-config", JSON.stringify({ mcpServers: { [TERMINAL_ADVISOR_MCP_SERVER]: mcp } })], env: http?.env ?? {} };
}

/** Observatory's part in a terminal's CLI (SessionObserver): its hooks' argv and OTel environment, each unset when not added. */
export type TerminalObservatory = {
  hookCommand: readonly string[] | undefined;
  otelEnv: Record<string, string> | undefined;
  /** Writes settings holding the receiver's token to a private file; its path. */
  settingsFile: (json: string) => string;
};

/**
 * The --settings value: the settings as JSON, or, when they hold the OTel
 * environment (the receiver's token), the path of a private file holding them,
 * so the token is never on a command line. A file that cannot be written
 * leaves the environment out: the CLI starts all the same.
 */
function settingsValue(settings: CliSettings, observatory: TerminalObservatory | undefined): string {
  const withHooks = observatory?.hookCommand ? withObservatoryHookGroups(settings, observatory.hookCommand) : settings;
  if (observatory?.otelEnv) {
    try {
      return observatory.settingsFile(JSON.stringify({ ...withHooks, env: observatory.otelEnv }));
    } catch {
      // without telemetry this time
    }
  }
  return JSON.stringify(withHooks);
}

/**
 * `claude` for a thread in the terminal, with what the chat view would use:
 * its session (resumed, or a new one with an id picked here), model,
 * effort, permission mode and account, and the hook that marks each turn's end
 * (TURN_END_SETTINGS); with `req.advisor`, automatic Advisor's hook, tool and
 * MCP in the same --settings, then --mcp-config (advisorSettings); with
 * `observatory`, Observatory's hooks and environment in that same --settings
 * (settingsValue): never a second --settings. Only values from Claude's own
 * lists become arguments.
 * Setting sources stay the CLI's own (user, project, local): the folder's
 * skills, commands and settings load as in any terminal, after the CLI's own
 * folder trust prompt.
 */
export function terminalCommand(
  bin: string,
  req: TerminalLaunch,
  newId: () => string,
  platform: NodeJS.Platform = process.platform,
  observatory?: TerminalObservatory,
): TerminalCommand {
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
  if (req.effort && CLAUDE_CAPABILITIES.effortLevels.includes(req.effort)) args.push("--effort", req.effort);
  if (req.permissionMode && CLAUDE_CAPABILITIES.permissionModes.includes(req.permissionMode)) args.push("--permission-mode", req.permissionMode);
  const settings: CliSettings = req.advisor ? advisorSettings(req.advisor, platform) : { hooks: { Stop: [TURN_END_HOOK] } };
  args.push("--settings", settingsValue(settings, observatory));
  const advisor = req.advisor ? advisorMcp(req.advisor) : undefined;
  if (advisor) args.push(...advisor.args);
  return {
    file: bin,
    args,
    env: { ...(req.account ? { CLAUDE_CONFIG_DIR: req.account.dir } : {}), ...advisor?.env },
    ...(sessionId ? { sessionId } : {}),
    ...(req.advisor ? { advisorTool: TERMINAL_ADVISOR_TOOL } : {}),
  };
}

/**
 * tunelo's own MCP in a session: the service's endpoint over HTTP when it
 * serves one (the ticket in claude's environment, see sessionMcpEnv), else
 * `tunelo mcp` over stdio with the session's ticket. It holds no token; the
 * service adds them.
 */
export function sessionMcpServer(mcp: SessionMcp): McpServerConfig {
  return sessionMcpHttp(mcp)?.config ?? { type: "stdio", ...sessionMcpLaunch(mcp) };
}

/**
 * What claude's environment needs for sessionMcpServer: the ticket its HTTP
 * config names and loopback in NO_PROXY (a proxy would carry the ticket);
 * nothing for stdio.
 */
export function sessionMcpEnv(mcp: SessionMcp | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const http = mcp ? sessionMcpHttp(mcp) : undefined;
  return http ? { ...http.env, ...loopbackNoProxy(base) } : {};
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
  if (input.permission_mode === BYPASS_MODE) return {};
  if (!needsApproval(tuneloTool(input.tool_name), input.tool_input)) return {};
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: WRITE_APPROVAL_REASON },
  };
};

const MAC_FOLDER_REASON = "It names a folder macOS protects that tunelo may not enter yet: tunelo asks you first.";

/**
 * PreToolUse, every tool and every mode: a call naming a folder macOS
 * protects that tunelo may not enter yet goes to the device as a card
 * (canUseTool), so it never runs into a macOS prompt nobody at the machine
 * answers, and the turn goes on whatever the answer.
 */
export function macFolderHook(policy: Pick<SessionPolicy, "dir" | "macFolders">): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !policy.macFolders) return {};
    if (policy.macFolders.ungrantedIn(JSON.stringify(input.tool_input ?? {}), policy.dir) === undefined) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: MAC_FOLDER_REASON } };
  };
}

const TUNELO_PREFIX = `mcp__${SESSION_MCP_SERVER}__`;

/** A Claude tool name as tunelo's MCP serves it (`mcp__tunelo__chat_send_message` → `chat_send_message`); "" for any other tool. */
export function tuneloTool(claudeName: string): string {
  return claudeName.startsWith(TUNELO_PREFIX) ? claudeName.slice(TUNELO_PREFIX.length) : "";
}

/** Tools whose own card on the device is the question to the user: no approval card before them. */
const ASKS_ON_DEVICE = new Set(["request_secret", "request_takeover"].map((tool) => `mcp__${SESSION_MCP_SERVER}__${tool}`));

/** request_secret and request_takeover ask the user on the device itself: no approval card before them. */
export const secretRequestHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || !ASKS_ON_DEVICE.has(input.tool_name)) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
};

const ADVISOR_WEIGH = `mcp__${SESSION_MCP_SERVER}__advisor_weigh`;

/**
 * advisor_weigh goes on without an approval card while Advisor may be asked
 * in the session (it only weighs options; what it sends is checked and shown
 * in the transcript), and is refused at once while it may not (tunelo would
 * refuse it anyway): no card either way.
 */
export function advisorWeighHook(allowed: () => boolean): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== ADVISOR_WEIGH) return {};
    if (!allowed()) {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_OFF_REFUSAL } };
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  };
}

/**
 * The turn is about to end (Claude's Stop hook): while automatic Advisor was on
 * all along and next steps were never asked, Claude goes on once with the
 * reminder. `stop_hook_active` says Claude is already continuing because a Stop
 * hook held it, so the turn then ends whatever happens: no loop.
 */
export function advisorStopHook(reason: () => string | undefined): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "Stop" || input.stop_hook_active) return {};
    const why = reason();
    return why === undefined ? {} : { decision: "block", reason: why };
  };
}

/** advisor_git and advisor_grep outside an Advisor thread's session: refused at once, no card (tunelo would refuse them anyway). */
export const advisorGitHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || !ADVISOR_ONLY_TOOLS.includes(tuneloTool(input.tool_name))) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ADVISOR_GIT_ONLY } };
};

/** The paths a Claude tool call names, for Advisor's guard: a Glob pattern that leaves the folder counts as one. */
export function guardPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths = toolPaths(input);
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (toolName === "Glob" && (pattern.startsWith("/") || pattern.startsWith("~") || /(^|[\\/])\.\.([\\/]|$)/.test(pattern))) paths.push(pattern.startsWith("~") ? "/" : pattern);
  return paths;
}

/** Whether Advisor's guard lets this call of an Advisor session go on; the refusal Claude reads otherwise. */
export function advisorRefusal(toolName: string, input: Record<string, unknown>, policy: Pick<SessionPolicy, "dir" | "isSensitive">): string | undefined {
  // Grep prints lines only in "content" mode (its default lists file names); its file filter reads as a path.
  const grep = toolName === "Grep";
  const glob = grep && typeof input.glob === "string" ? [input.glob] : [];
  return advisorGuard(
    { kind: toolKind(toolName), own: claudeOwnTool(toolName), paths: guardPaths(toolName, input), globs: glob, contentSearch: grep && input.output_mode === "content" },
    policy,
  );
}

/**
 * PreToolUse of every tool in an Advisor thread's session: tunelo's own
 * read-only list decides, in any permission mode (a hook's deny holds even
 * where Claude would not ask), and an allowed call never reaches a card.
 */
export function advisorSessionHook(policy: Pick<SessionPolicy, "dir" | "isSensitive">): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
    const why = advisorRefusal(input.tool_name, toolInput, policy);
    if (why) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  };
}

/** After every tool of an Advisor thread's session: nothing shaped like a secret reaches Claude in what it read or found. */
export const advisorOutputHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  const output = scrubDeep(input.tool_response);
  if (output === input.tool_response) return {};
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: output } };
};

/** `value` with hideSecretShapes applied to every string (plain objects and arrays walked); the same value when nothing changed. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return hideSecretShapes(value);
  if (Array.isArray(value)) {
    const next = value.map(scrubDeep);
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    const next = entries.map(([k, v]) => [k, scrubDeep(v)] as const);
    return next.some(([, v], i) => v !== entries[i]?.[1]) ? Object.fromEntries(next) : value;
  }
  return value;
}

/**
 * What tunelo tells Claude beside each message (Advisor's instructions), as
 * context of that prompt: never the user's words, so the journal, Claude's
 * own transcript and a command like /compact stay as the user wrote them.
 * Notes wait in the order their messages were sent. A prompt takes the note
 * of the waiting message with exactly its text (notes of messages before it
 * are dropped: those never reached Claude with a hook); a prompt that
 * matches none takes none. A note dropped or no longer holding was never
 * delivered, so the core sends it again with the next message.
 */
export class PromptNotes {
  private waiting: { text: string; note: SessionNote }[] = [];

  add(text: string, note: SessionNote): void {
    this.waiting.push({ text, note });
  }

  /** The turn was stopped: messages still waiting never reach Claude as they were. */
  clear(): void {
    this.waiting = [];
  }

  readonly hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "UserPromptSubmit" || this.waiting.length === 0) return {};
    if (input.prompt.trimStart().startsWith("/")) return {};
    const at = this.waiting.findIndex((w) => w.text === input.prompt);
    if (at < 0) return {};
    const taken = this.waiting[at];
    this.waiting = this.waiting.slice(at + 1);
    const text = taken?.note.take();
    if (!taken || !text) return {};
    taken.note.delivered();
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
  };
}

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
    if (given.length > 0 && input.permission_mode !== BYPASS_MODE) {
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
  return !isWriteTool(tuneloTool(tool));
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

function startSession(queryFn: QueryFn, bin: string, policy: SessionPolicy, askUser: AskUser, resumeId?: string, observer?: SessionObserver): ProviderSession {
  const inbox = new Channel<SDKUserMessage>();
  const events = new Channel<ProviderEvent>();
  // No sign-in secret value goes to the devices or the journal.
  const emit = (e: ProviderEvent) => events.push(redactDeep(e));
  const secrets = policy.sessionMcp?.secrets;
  const browserNotices = policy.sessionMcp?.browserNotices;
  const notices = browserNotices ? [browserNoticeHook(browserNotices)] : [];
  const advisorAllowed = policy.sessionMcp?.advisorAllowed;
  const advisorStop = policy.sessionMcp?.advisorStop;
  const advisorHooks = [...(advisorAllowed ? [advisorWeighHook(advisorAllowed)] : []), advisorGitHook];
  const advisorSession = policy.advisorSession === true;
  const promptNotes = new PromptNotes();
  let interrupted = false;
  let turnStart = 0;
  let turnOpen = false;
  let closed = false;
  // macOS: claude runs in tunelo's sandbox, kept out of the protected folders not granted yet (safety/mac-sandbox.ts).
  const fences = policy.macFolders && !claudeSandboxOn(claudeSettingsFiles(policy)) ? policy.macFolders.aiFences() : { deny: [], allow: [] };
  const program = policy.macFolders ? sandboxedProgram(fences, bin, policy.macFolders.sandboxDir) : bin;

  const canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
    // An Advisor session never asks the user: tunelo's read-only list answers.
    if (advisorSession) {
      const why = advisorRefusal(toolName, input, policy);
      return why ? { behavior: "deny", message: why } : { behavior: "allow", updatedInput: input };
    }
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
    // A folder macOS protects that tunelo may not enter yet: the card says so, and allowing it asks macOS first.
    const macFolder = policy.macFolders?.ungrantedIn(`${JSON.stringify(input)} ${opts.blockedPath ?? ""}`, policy.dir);
    const sensitive = paths.some(policy.isSensitive) || (command !== "" && mentionsSensitive(command, policy.isSensitive, { cwd: policy.dir }));
    // A write of tunelo's MCP: the card names what it does, and the service runs it only once approved here.
    const ownTool = tuneloTool(toolName);
    const write = policy.sessionMcp && needsApproval(ownTool, input) ? policy.sessionMcp : undefined;
    const summary = (write && (await write.describeWrite(ownTool, input).catch(() => undefined))) || toolSummary(toolName, input, policy.dir);
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
      ...(macFolder !== undefined ? { macFolder } : {}),
    };
    const answer = await askUser(req, opts.signal);
    if (answer.decision === "deny") {
      return { behavior: "deny", message: macFolder !== undefined && !answer.message ? macFolderRefusedByUser(macFolder) : denialText(answer.message) };
    }
    if (macFolder !== undefined && policy.macFolders) {
      const refused = await macFolderBeforeCall(policy.macFolders, macFolder);
      if (refused !== undefined) return { behavior: "deny", message: refused };
      // Allowed now, but this claude started in a sandbox that keeps the folder out: the next session reaches it.
      if (program !== bin && fences.deny.includes(macFolder)) return { behavior: "deny", message: macFolderAfterRestart(macFolder) };
    }
    const { decision } = answer;
    write?.approveWrite(ownTool, input);
    // Approved: the secrets the command names go where its shell loads them, until it ends.
    if (secrets && toolName === "Bash" && opts.toolUseID) await secrets.beforeCommand(opts.toolUseID, command);
    // A write tool of tunelo's MCP is asked about every time: no rule for the session.
    // A command reading a sign-in secret is asked about every time: an older device's "allow for the session" counts once.
    if (decision === "allow-session" && !sensitive && macFolder === undefined && !isWriteTool(ownTool) && !usesSecret) {
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

  const options: Options = advisorSession
    ? {
        pathToClaudeCodeExecutable: program,
        cwd: policy.dir,
        // None of the user's or the folder's settings, hooks, rules or MCP servers: tunelo's own only.
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: policy.sessionMcp ? { [SESSION_MCP_SERVER]: sessionMcpServer(policy.sessionMcp) } : {},
        tools: [...CLAUDE_ADVISOR_TOOLS],
        disallowedTools: [...CLAUDE_ADVISOR_DISALLOWED],
        // Observed too, its records labelled internal: kept out of every total.
        hooks: withObservedHooks(
          {
            PreToolUse: [{ hooks: [advisorSessionHook(policy)] }],
            UserPromptSubmit: [{ hooks: [promptNotes.hook] }],
            PostToolUse: [{ hooks: [advisorOutputHook] }],
          },
          observer,
          OBSERVED_ADVISOR_EVENTS,
          ADVISOR_LABEL,
        ),
        permissionMode: "default",
        includePartialMessages: true,
        canUseTool,
      }
    : {
        pathToClaudeCodeExecutable: program,
        cwd: policy.dir,
        settingSources: policy.projectSettings ? ["user", "project", "local"] : ["user"],
        strictMcpConfig: true,
        mcpServers: policy.sessionMcp
          ? { ...withoutTuneloMcp(policy.mcpServers), [SESSION_MCP_SERVER]: sessionMcpServer(policy.sessionMcp) }
          : (policy.mcpServers as NonNullable<Options["mcpServers"]>),
        // Also guards a `tunelo` MCP the machine's own config adds. Observatory's callbacks go after tunelo's own.
        hooks: withObservedHooks(
          {
            PreToolUse: [
              { matcher: `^mcp__${SESSION_MCP_SERVER}__`, hooks: [writeApprovalHook, secretRequestHook, ...advisorHooks] },
              ...(secrets ? [{ matcher: "^Bash$", hooks: [secretCommandHook(secrets)] }] : []),
              { hooks: [macFolderHook(policy)] },
            ],
            UserPromptSubmit: [{ hooks: [promptNotes.hook] }],
            ...(advisorStop ? { Stop: [{ hooks: [advisorStopHook(advisorStop)] }] } : {}),
            PostToolUse: [{ hooks: [secretOutputHook(secrets), ...notices] }],
            PostToolUseFailure: [{ hooks: [secretOutputHook(secrets), ...notices] }],
          },
          observer,
          OBSERVED_SDK_EVENTS,
        ),
        // Without a mode picked on a device, the session follows the machine's own
        // Claude settings (permissions.defaultMode and allow/deny rules).
        includePartialMessages: true,
        canUseTool,
      };
  // A profile picked on the machine: its own sign-in, the shared projects. With Observatory on, the environment is always
  // given (the service's own, or the profile's), with the OTel variables of the agent's receiver when it listens.
  const otelEnv = observer ? withoutFailing(() => observer.otelEnv(policy.account?.dir ?? defaultClaudeHome())) : undefined;
  if (policy.account || observer) options.env = claudeEnv(policy.account?.dir, otelEnv ?? {});
  // Claude Code runs this before every Bash command: the secrets a running command may read (secret-env.ts).
  if (secrets) options.env = { ...(options.env ?? claudeEnv(undefined)), CLAUDE_ENV_FILE: secrets.loader };
  // tunelo's MCP over HTTP: its config names the ticket, the environment holds it (never argv).
  const baseEnv = options.env ?? claudeEnv(undefined);
  const mcpEnv = sessionMcpEnv(policy.sessionMcp, baseEnv);
  if (Object.keys(mcpEnv).length > 0) options.env = { ...baseEnv, ...mcpEnv };
  if (policy.model) options.model = policy.model;
  if (policy.effort) options.effort = policy.effort as EffortLevel;
  // An Advisor session stays in Claude's default mode: no mode, bypass or rule from anywhere else.
  if (policy.permissionMode && !advisorSession) options.permissionMode = policy.permissionMode as PermissionMode;
  if (policy.allowBypass && !advisorSession) options.allowDangerouslySkipPermissions = true;
  if (resumeId) options.resume = resumeId;
  // "Allow for the session" given before this process: the same allow rules, from tunelo's own record.
  const sessionRules = advisorSession ? [] : (policy.sessionRules ?? []).filter(replayableRule);
  if (sessionRules.length) options.allowedTools = sessionRules;

  const q = queryFn({ prompt: inbox, options });
  const mapper = new MessageMapper(policy.dir, emit);
  let hidden: string[] = [];
  // Observatory: the callbacks never get SessionStart at startup nor SessionEnd at the end, so both are told from here.
  const lifecycle = observer ? new ObservedSessionLifecycle(observer, policy.dir, resumeId ? "resume" : "startup", advisorSession ? ADVISOR_LABEL : undefined) : undefined;

  void (async () => {
    try {
      for await (const msg of q) {
        if (lifecycle && typeof msg.session_id === "string") lifecycle.saw(msg.session_id, msg.type === "system" && msg.subtype === "init" ? { model: msg.model, permission_mode: msg.permissionMode } : undefined);
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
      lifecycle?.ended();
      events.close();
    }
  })();

  return {
    events,
    async send(text, images, note) {
      if (closed) throw new Error("session closed");
      turnStart = performance.now();
      turnOpen = true;
      if (note) promptNotes.add(text, note);
      inbox.push(userMessage(text, images));
    },
    async interrupt() {
      promptNotes.clear();
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
      if (closed || advisorSession) return;
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
 * Settings of the probes (usage, commands), above the user's (the command
 * line's level): no hook of any settings file or plugin runs, so a probe never
 * shows up as a session (Observatory's installed hooks among them).
 */
export const PROBE_SETTINGS = { disableAllHooks: true } as const satisfies Settings;

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
  const options: Options = {
    pathToClaudeCodeExecutable: bin,
    cwd: homedir(),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    settings: PROBE_SETTINGS,
    abortController: abort,
  };
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
    // The user's settings load (their skills and commands), but none of their hooks: Observatory's, once installed, would record the probe as a session.
    settings: PROBE_SETTINGS,
    abortController: abort,
  };
  if (req.account) options.env = claudeEnv(req.account.dir);
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

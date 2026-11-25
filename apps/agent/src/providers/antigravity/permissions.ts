// agy's permission requests as approval cards. agy offers allow-once and
// reject-once only; "allow for the session" is kept here, by tunelo, for the
// session and handed back as session rules when it opens again. agy never
// hears "always allow". A card touching a sensitive path is never allowed
// for the session (the core does not offer it).
//
// tunelo's own MCP (agy names its tools `mcp_tunelo_<tool>`): a write is
// asked about every time, with what it does on the card, and once allowed
// the service may run that exact call once (approveWrite). The arguments
// are agy's input without the `toolSummary` it adds. A tool whose own card
// on the device is the question (request_secret, request_takeover) goes on
// without a card here, and so does advisor_weigh: allowed while Advisor may
// be asked in the session, refused otherwise. When agy runs
// a tool of tunelo's MCP without asking at all, nothing here is needed.
import type { AcpPermissionOutcome, AcpPermissionParams } from "../acp/acp-session.ts";
import { SESSION_MCP_SERVER, isWriteTool, needsApproval } from "../../mcp/groups.ts";
import type { SessionMcp } from "../../mcp/session-tickets.ts";
import { type MacFolderGate, macFolderBeforeCall } from "../../safety/mac-folders.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import type { AskUser } from "../types.ts";
import { describe, toolKind, toolPaths } from "./tool-map.ts";
import { ADVISOR_ONLY_TOOLS, advisorGuard } from "../../advisor/advisor-guard.ts";

/**
 * What a search of agy shows, for Advisor's guard: only grep_search with
 * MatchPerLine false (file names) and find_by_name show no content; any
 * other search counts as printing lines (fail closed). Its Includes filters
 * read as globs.
 */
export function searchOf(call: NonNullable<AcpPermissionParams["toolCall"]>): { contentSearch: boolean; globs: string[] } {
  const input = typeof call.rawInput === "object" && call.rawInput !== null ? (call.rawInput as Record<string, unknown>) : {};
  const includes = Array.isArray(input.Includes) ? input.Includes.filter((g): g is string => typeof g === "string") : [];
  if (toolKind(call) !== "search") return { contentSearch: false, globs: includes };
  const namesOnly = call.name === "find_by_name" || (call.name === "grep_search" && input.MatchPerLine === false);
  return { contentSearch: !namesOnly, globs: includes };
}

/** Longest input shown on a card. */
const CARD_INPUT_CHARS = 4_000;

const OWN_PREFIX = `mcp_${SESSION_MCP_SERVER}_`;

/** Tools whose own card on the device is the question to the user. */
const ASKS_ON_DEVICE = new Set(["request_secret", "request_takeover"]);

/** The tool as tunelo's MCP serves it (`chat_send_message`); "" for any other tool. */
export function tuneloTool(agyName: string): string {
  return agyName.startsWith(OWN_PREFIX) ? agyName.slice(OWN_PREFIX.length) : "";
}

/** The arguments the MCP server gets: agy's input without the `toolSummary` it adds for its own display. */
export function mcpArguments(rawInput: unknown): Record<string, unknown> {
  const input = typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const { toolSummary: _summary, ...args } = input;
  return args;
}

/**
 * The session rule of a call: the tool with its command, or with the files
 * it touches (the same command or file goes again without asking; another
 * one asks).
 */
export function ruleOf(p: AcpPermissionParams, dir: string): string {
  const call = p.toolCall ?? {};
  const name = call.name ?? call.kind ?? "tool";
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const command = typeof input.CommandLine === "string" ? input.CommandLine : "";
  if (command) return `${name}:${command}`;
  const paths = toolPaths(call, dir);
  return paths.length > 0 ? `${name}:${paths.join("\n")}` : name;
}

function option(p: AcpPermissionParams, kinds: readonly string[], fallback: string): string {
  return (p.options ?? []).find((o) => o.kind !== undefined && kinds.includes(o.kind))?.optionId ?? fallback;
}

export type PermissionContext = {
  dir: string;
  askUser: AskUser;
  isSensitive: (path: string) => boolean;
  /** Rules the user allowed for this session (kept by the session; grows as the user allows more). */
  rules: Set<string>;
  /** A rule was added: the core keeps it with the thread. */
  onRule: (rule: string) => void;
  /** tunelo's own MCP of the session: its writes are described and approved here. */
  sessionMcp?: Pick<SessionMcp, "approveWrite" | "describeWrite" | "advisorAllowed">;
  /** An Advisor thread's session: Advisor's read-only list answers every request, never the user (advisor-guard.ts). */
  advisorSession?: boolean;
  /** macOS: a call naming a protected folder tunelo may not enter yet is asked about, and macOS asked once allowed. */
  macFolders?: MacFolderGate;
};

export async function answerPermission(p: AcpPermissionParams, ctx: PermissionContext, signal: AbortSignal): Promise<AcpPermissionOutcome> {
  // Once only: agy never hears "always" (tunelo keeps the session's rules itself).
  const allow = option(p, ["allow_once"], "allow");
  const reject = option(p, ["reject_once"], "deny");
  const call = p.toolCall ?? {};
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const command = typeof input.CommandLine === "string" ? input.CommandLine : "";
  const sensitive = toolPaths(call, ctx.dir).some(ctx.isSensitive) || (command !== "" && mentionsSensitive(command, ctx.isSensitive, { cwd: ctx.dir }));
  const own = tuneloTool(call.name ?? "");
  if (ctx.advisorSession) {
    const why = advisorGuard({ kind: toolKind(call), own, paths: toolPaths(call, ctx.dir), ...searchOf(call) }, ctx);
    return { outcome: { outcome: "selected", optionId: why ? reject : allow } };
  }
  // advisor_git and advisor_grep are only for an Advisor thread's session: refused at once elsewhere.
  if (ADVISOR_ONLY_TOOLS.includes(own)) return { outcome: { outcome: "selected", optionId: reject } };
  if (own !== "" && ASKS_ON_DEVICE.has(own)) return { outcome: { outcome: "selected", optionId: allow } };
  // advisor_weigh: allowed while Advisor may be asked in the session, refused at once otherwise (tunelo would refuse it anyway).
  const advisorAllowed = ctx.sessionMcp?.advisorAllowed;
  if (own === "advisor_weigh" && advisorAllowed) return { outcome: { outcome: "selected", optionId: advisorAllowed() ? allow : reject } };
  const args = mcpArguments(call.rawInput);
  const write = ctx.sessionMcp && own !== "" && needsApproval(own, args) ? ctx.sessionMcp : undefined;
  // A write tool of tunelo's MCP is asked about every time: no rule for the session lets it through.
  const ownWrite = own !== "" && isWriteTool(own);
  const rule = ruleOf(p, ctx.dir);
  // A folder macOS protects that tunelo may not enter yet: always a card, and allowing it asks macOS first.
  const macFolder = ctx.macFolders?.ungrantedIn(`${JSON.stringify(call.rawInput ?? {})} ${toolPaths(call, ctx.dir).join(" ")}`, ctx.dir);
  if (!sensitive && macFolder === undefined && !ownWrite && ctx.rules.has(rule)) return { outcome: { outcome: "selected", optionId: allow } };
  const shown = describe(call, ctx.dir);
  const card = write ? await write.describeWrite(own, args).catch(() => undefined) : undefined;
  const summary = card?.summary || shown.summary;
  const cut = shown.input.length > CARD_INPUT_CHARS ? `The input shown is cut: ${shown.input.length} characters in all.` : "";
  const answer = await ctx.askUser(
    {
      kind: "approval",
      toolId: call.toolCallId ?? "",
      toolKind: shown.kind,
      name: shown.name,
      summary,
      input: shown.input.slice(0, CARD_INPUT_CHARS),
      sensitive,
      ...(cut ? { reason: cut } : {}),
      ...(macFolder !== undefined ? { macFolder } : {}),
      ...(card ? { write: card.write } : {}),
    },
    signal,
  );
  if (answer.decision === "deny") return { outcome: { outcome: "selected", optionId: reject } };
  // macOS refused, or nobody answered its prompt in time: the call is refused and agy goes on.
  if (macFolder !== undefined && ctx.macFolders && (await macFolderBeforeCall(ctx.macFolders, macFolder)) !== undefined) {
    return { outcome: { outcome: "selected", optionId: reject } };
  }
  write?.approveWrite(own, args);
  if (answer.decision === "allow-session" && !sensitive && macFolder === undefined && !ownWrite) {
    ctx.rules.add(rule);
    ctx.onRule(rule);
  }
  return { outcome: { outcome: "selected", optionId: allow } };
}

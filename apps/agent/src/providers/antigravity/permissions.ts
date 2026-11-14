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
// without a card here.
import type { AcpPermissionOutcome, AcpPermissionParams } from "../acp/acp-session.ts";
import { SESSION_MCP_SERVER, isWriteTool, needsApproval } from "../../mcp/groups.ts";
import type { SessionMcp } from "../../mcp/session-tickets.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import type { AskUser } from "../types.ts";
import { describe, toolPaths } from "./tool-map.ts";

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
  sessionMcp?: Pick<SessionMcp, "approveWrite" | "describeWrite">;
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
  if (own !== "" && ASKS_ON_DEVICE.has(own)) return { outcome: { outcome: "selected", optionId: allow } };
  const args = mcpArguments(call.rawInput);
  const write = ctx.sessionMcp && own !== "" && needsApproval(own, args) ? ctx.sessionMcp : undefined;
  // A write tool of tunelo's MCP is asked about every time: no rule for the session lets it through.
  const ownWrite = own !== "" && isWriteTool(own);
  const rule = ruleOf(p, ctx.dir);
  if (!sensitive && !ownWrite && ctx.rules.has(rule)) return { outcome: { outcome: "selected", optionId: allow } };
  const shown = describe(call, ctx.dir);
  const summary = (write && (await write.describeWrite(own, args).catch(() => undefined))) || shown.summary;
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
    },
    signal,
  );
  if (answer.decision === "deny") return { outcome: { outcome: "selected", optionId: reject } };
  write?.approveWrite(own, args);
  if (answer.decision === "allow-session" && !sensitive && !ownWrite) {
    ctx.rules.add(rule);
    ctx.onRule(rule);
  }
  return { outcome: { outcome: "selected", optionId: allow } };
}

// agy's permission requests as approval cards. agy offers allow-once and
// reject-once only; "allow for the session" is kept here, by tunelo, for the
// session and handed back as session rules when it opens again. agy never
// hears "always allow". A card touching a sensitive path is never allowed
// for the session (the core does not offer it).
import type { AcpPermissionOutcome, AcpPermissionParams } from "../acp/acp-session.ts";
import { mentionsSensitive } from "../../safety/sensitive-paths.ts";
import type { AskUser } from "../types.ts";
import { describe, toolPaths } from "./tool-map.ts";

/** Longest input shown on a card. */
const CARD_INPUT_CHARS = 4_000;

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
};

export async function answerPermission(p: AcpPermissionParams, ctx: PermissionContext, signal: AbortSignal): Promise<AcpPermissionOutcome> {
  // Once only: agy never hears "always" (tunelo keeps the session's rules itself).
  const allow = option(p, ["allow_once"], "allow");
  const reject = option(p, ["reject_once"], "deny");
  const call = p.toolCall ?? {};
  const input = (call.rawInput ?? {}) as Record<string, unknown>;
  const command = typeof input.CommandLine === "string" ? input.CommandLine : "";
  const sensitive = toolPaths(call, ctx.dir).some(ctx.isSensitive) || (command !== "" && mentionsSensitive(command, ctx.isSensitive, { cwd: ctx.dir }));
  const rule = ruleOf(p, ctx.dir);
  if (!sensitive && ctx.rules.has(rule)) return { outcome: { outcome: "selected", optionId: allow } };
  const shown = describe(call, ctx.dir);
  const cut = shown.input.length > CARD_INPUT_CHARS ? `The input shown is cut: ${shown.input.length} characters in all.` : "";
  const answer = await ctx.askUser(
    {
      kind: "approval",
      toolId: call.toolCallId ?? "",
      toolKind: shown.kind,
      name: shown.name,
      summary: shown.summary,
      input: shown.input.slice(0, CARD_INPUT_CHARS),
      sensitive,
      ...(cut ? { reason: cut } : {}),
    },
    signal,
  );
  if (answer.decision === "deny") return { outcome: { outcome: "selected", optionId: reject } };
  if (answer.decision === "allow-session" && !sensitive) {
    ctx.rules.add(rule);
    ctx.onRule(rule);
  }
  return { outcome: { outcome: "selected", optionId: allow } };
}

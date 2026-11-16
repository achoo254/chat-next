// advisor_weigh: the AI asks Advisor how likely each of its options is right.
// A tool of tunelo's MCP offered only to a session tunelo opened (a ticket
// names its thread), run in the service: the request is checked
// (advisor-outbound.ts), sent with the user's key from the machine's own
// store (never the session's), and stopped when the turn is interrupted (the
// core holds the call). Refused when Advisor is off for the thread or no key
// is kept. The result is JSON both the AI and the core read: the core turns
// it into the transcript's AdvisorVerdictItem (advisorResultOf).
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolRegistrar } from "../mcp/groups.js";
import { outboundBody } from "./advisor-outbound.ts";
import { type Verdict, verdictOf } from "./advisor-verdict.ts";
import { type JevClientOptions, JevError, type JevFailure, type WeighBody, type WeighKind, weigh } from "./jev-client.ts";
import { registerAdvisorGitTool, registerAdvisorGrepTool } from "./advisor-git-tool.ts";
import type { GitRunner } from "../workspace/git-run.ts";

/** Not a group of groups.ts: it cannot be turned off, and only sessions with a ticket have it. */
export const ADVISOR_GROUP = "advisor";
export const ADVISOR_TOOLS = ["advisor_weigh", "advisor_git", "advisor_grep"] as const;

export const MAX_QUESTION_CHARS = 300;
export const MAX_OPTION_CHARS = 80;
export const MAX_CONTEXT_CHARS = 600;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;

export const ADVISOR_OFF_REFUSAL = "Advisor is off for this session; do not call advisor_weigh.";
const NO_KEY_REFUSAL = "Advisor has no key on this machine: go on without it and do not call advisor_weigh again this turn.";
const COMMAND_OPTION = 'Options must not start with "/" or "!": write them as plain words.';
const BLANK = "The question and every option need words.";
const NO_SESSION = "Advisor is only offered in a session tunelo opened.";
const NOT_ASKED = "Advisor could not weigh this now.";

/** What the machine lends the tool: the thread's state, the key, and the call the core can stop. */
export type AdvisorHooks = {
  /** Advisor may be asked in this thread now (its automatic Advisor is on). */
  allowed(threadId: string): boolean;
  /** The user's key, from the machine's own store; undefined when none is kept. */
  key(): Promise<string | undefined>;
  /** Runs `run` for the thread; its signal aborts when the thread's turn is interrupted or ends. */
  call<T>(threadId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  isSensitive(path: string): boolean;
  /** Where and how Jev is reached (tests). */
  jev?: JevClientOptions;
  /** The folder of an Advisor thread (ThreadKind ADVISOR); undefined for any other thread. Without it advisor_git refuses. */
  sessionDir?: (threadId: string) => string | undefined;
  /** git for advisor_git (the workspaces' runner). */
  git?: GitRunner;
};

/** Why a call gave no verdict (AdvisorVerdictItem.error). */
export type AdvisorErrorCode = JevFailure | "no_key" | "off" | "refused" | "invalid";

/** What a call of advisor_weigh came to, as its result carries it. */
export type AdvisorResult =
  | {
      advisor: "verdict";
      kind: WeighKind;
      verdict: Verdict;
      choice: string;
      confidence: number;
      options: { text: string; probability: number }[];
      sent: WeighBody;
      guidance: string;
    }
  | { advisor: "error"; error: AdvisorErrorCode; message: string; sent?: WeighBody };

const GUIDANCE: Record<WeighKind, Record<Verdict, string>> = {
  decision: {
    confident:
      "Follow the choice only if it is non-destructive and inside the user's request; otherwise ask the user, quoting these probabilities.",
    unsure: "Advisor is unsure: stop and ask the user, quoting the options and their probabilities.",
  },
  next_steps: {
    confident: "The user sees these next steps as suggestions. End your turn.",
    unsure: "The user sees these next steps as suggestions. End your turn.",
  },
  answer: {
    confident: "Answer the user with the choice and its probability.",
    unsure: "Answer the user with the options and their probabilities: Advisor is unsure.",
  },
};

const input = z.object({
  kind: z.enum(["decision", "next_steps", "answer"]).describe('"decision" when unsure what to do, "next_steps" before ending a turn, "answer" in an Advisor session'),
  question: z.string().min(1).max(MAX_QUESTION_CHARS).describe("One short abstract question"),
  options: z
    .array(z.string().trim().min(1).max(MAX_OPTION_CHARS))
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS)
    .describe('2-5 short options, plain words, never starting with "/" or "!"'),
  context: z.string().max(MAX_CONTEXT_CHARS).optional().describe("A short abstract summary: never keys, passwords, tokens, private paths, personal data or code"),
});

function result(value: AdvisorResult): CallToolResult {
  return { ...(value.advisor === "error" ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function refusal(error: AdvisorErrorCode, message: string, sent?: WeighBody): CallToolResult {
  return result({ advisor: "error", error, message, ...(sent ? { sent } : {}) });
}

/**
 * Registers advisor_weigh. `bound` is what it runs with and the thread it
 * runs for; absent where the tool is only listed (`tunelo mcp`).
 */
export function registerAdvisorTools(server: ToolRegistrar, bound?: { hooks: AdvisorHooks; threadId: string }): void {
  registerWeigh(server, bound);
  const { sessionDir, git } = bound?.hooks ?? {};
  const gitBound = bound && sessionDir && git ? { hooks: { sessionDir, git, isSensitive: (p: string) => bound.hooks.isSensitive(p) }, threadId: bound.threadId } : undefined;
  registerAdvisorGitTool(server, gitBound);
  registerAdvisorGrepTool(server, gitBound);
}

function registerWeigh(server: ToolRegistrar, bound?: { hooks: AdvisorHooks; threadId: string }): void {
  server.registerTool(
    "advisor_weigh",
    {
      title: "Ask Advisor to weigh options",
      description:
        "Advisor weighs 2-5 options for one question and returns how likely each is right, with a verdict: \"confident\" or \"unsure\". It never writes or runs anything. Send only a short abstract summary: a request that looks like it holds a key, password, token or private path is refused and nothing is sent.",
      inputSchema: input,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!bound) return refusal("off", NO_SESSION);
      const { hooks, threadId } = bound;
      if (!hooks.allowed(threadId)) return refusal("off", ADVISOR_OFF_REFUSAL);
      const options = args.options.map((o) => o.trim());
      if (args.question.trim() === "" || options.some((o) => o === "")) return refusal("invalid", BLANK);
      if (options.some((o) => o.startsWith("/") || o.startsWith("!"))) return refusal("invalid", COMMAND_OPTION);
      const out = outboundBody({ kind: args.kind, question: args.question.trim(), options, context: (args.context ?? "").trim() }, (p) => hooks.isSensitive(p));
      if (!out.ok) return refusal("refused", out.why);
      let key: string | undefined;
      try {
        key = await hooks.key();
      } catch {
        return refusal("unavailable", NOT_ASKED);
      }
      if (!key) return refusal("no_key", NO_KEY_REFUSAL);
      const held = key;
      const body = out.body;
      try {
        const answer = await hooks.call(threadId, (signal) => weigh(body, held, signal, hooks.jev));
        const verdict = verdictOf(answer);
        return result({
          advisor: "verdict",
          kind: body.kind,
          verdict,
          choice: body.options[answer.choice] ?? "",
          confidence: answer.confidence,
          options: body.options.map((text, i) => ({ text, probability: answer.probabilities[i] ?? 0 })),
          sent: body,
          guidance: GUIDANCE[body.kind][verdict],
        });
      } catch (err) {
        if (err instanceof JevError) return refusal(err.kind, err.message, body);
        return refusal("unavailable", NOT_ASKED, body);
      }
    },
  );
}

export { isAdvisorWeigh } from "./advisor-names.ts";

const KINDS: readonly string[] = ["decision", "next_steps", "answer"];

function asResult(value: unknown): AdvisorResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { advisor?: unknown; kind?: unknown; error?: unknown };
  if (v.advisor === "verdict" && typeof v.kind === "string" && KINDS.includes(v.kind)) return value as AdvisorResult;
  if (v.advisor === "error" && typeof v.error === "string") return value as AdvisorResult;
  return undefined;
}

/**
 * The result of an advisor_weigh call in the text an AI reports for it:
 * the JSON the tool returned, found even when the AI wraps it (in a JSON
 * string or a list of content blocks). Undefined when none is found.
 */
export function advisorResultOf(output: string, depth = 0): AdvisorResult | undefined {
  if (depth > 3) return undefined;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  const candidates = [output, ...(start >= 0 && end > start ? [output.slice(start, end + 1)] : [])];
  for (const text of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const found = asResult(parsed) ?? nested(parsed, depth);
    if (found) return found;
  }
  return undefined;
}

function nested(value: unknown, depth: number): AdvisorResult | undefined {
  if (typeof value === "string") return advisorResultOf(value, depth + 1);
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = nested(child, depth);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      const found = asResult(child) ?? nested(child, depth);
      if (found) return found;
    }
  }
  return undefined;
}

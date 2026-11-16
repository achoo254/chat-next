// Advisor's one call out: TypeSafe's Jev weighs the options of one question
// and says how likely each is right. The request carries the user's own key
// (BYOK) in its Authorization header and nothing else of theirs beyond the
// question, options and context advisor-outbound.ts let through. Every
// failure is one of a few fixed messages: never the key, never what the
// service answered.
import { z } from "zod";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** How long Advisor waits for an answer. */
export const JEV_TIMEOUT_MS = 8_000;
/** The id of the one question of each request. */
const QUESTION_ID = "q";

export type WeighKind = "decision" | "next_steps" | "answer";

/** What goes to Jev, as advisor-outbound.ts made it. */
export type WeighBody = { kind: WeighKind; question: string; options: string[]; context: string };

/** Jev's answer, in the order of the options asked. */
export type JevAnswer = { choice: number; probabilities: number[]; confidence: number };

export type JevFailure = "interrupted" | "timeout" | "unavailable" | "key_invalid";

const MESSAGES: Record<JevFailure, string> = {
  interrupted: "Advisor was stopped: the turn was interrupted.",
  timeout: "Advisor did not answer in time.",
  unavailable: "Advisor could not weigh this now.",
  key_invalid: "Advisor's key was refused: the user must set a valid key on the machine.",
};

/** A call that gave no answer. The message is fixed by `kind`: it never quotes the key or the service. */
export class JevError extends Error {
  constructor(readonly kind: JevFailure) {
    super(MESSAGES[kind]);
    this.name = "JevError";
  }
}

const ANSWER = z.object({
  answers: z.record(
    z.string(),
    z.object({
      choice: z.string(),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type JevClientOptions = {
  fetch?: typeof fetch;
  url?: string;
  timeoutMs?: number;
};

const optionId = (i: number): string => `o${i + 1}`;

/** The request body Jev takes for `body`: one choice question, an option id per option. */
export function jevRequest(body: WeighBody): Record<string, unknown> {
  const criteria = Object.fromEntries(body.options.map((text, i) => [optionId(i), text]));
  return {
    model: JEV_MODEL,
    state: { kind: body.kind, context: body.context },
    questions: { [QUESTION_ID]: { type: "choice", instructions: body.question, criteria } },
  };
}

/**
 * Asks Jev to weigh `body` with `key`. Gives up after the timeout or when
 * `signal` aborts (an interrupted turn); throws a JevError on any failure.
 */
export async function weigh(body: WeighBody, key: string, signal: AbortSignal, opts: JevClientOptions = {}): Promise<JevAnswer> {
  if (signal.aborted) throw new JevError("interrupted");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? JEV_TIMEOUT_MS);
  const both = AbortSignal.any([signal, timeout]);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(opts.url ?? JEV_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(jevRequest(body)),
      signal: both,
    });
  } catch {
    // Stopped by the turn, out of time, or the service could not be reached at all (DNS, a refused or dropped connection).
    throw new JevError(signal.aborted ? "interrupted" : timeout.aborted ? "timeout" : "unavailable");
  }
  if (!res.ok) {
    // The body is not read: let the connection go.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new JevError("key_invalid");
    throw new JevError(res.status === 429 || res.status >= 500 ? "timeout" : "unavailable");
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new JevError(signal.aborted ? "interrupted" : timeout.aborted ? "timeout" : "unavailable");
  }
  const parsed = ANSWER.safeParse(raw);
  const answer = parsed.success ? parsed.data.answers[QUESTION_ID] : undefined;
  const choice = answer ? body.options.findIndex((_, i) => optionId(i) === answer.choice) : -1;
  if (!answer || choice < 0) throw new JevError("unavailable");
  return {
    choice,
    probabilities: body.options.map((_, i) => answer.probabilities[optionId(i)] ?? 0),
    confidence: answer.confidence,
  };
}

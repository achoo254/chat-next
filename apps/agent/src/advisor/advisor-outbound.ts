// What may leave the machine for Advisor. The AI writes the question, the
// options and the context; before any of it goes out, every secret value
// tunelo holds and anything shaped like a JWT or a Bearer value is hidden
// (redact), and a request that still holds something shaped like a secret
// (the shared list of @achoo254/chat-remote-protocol) or names a sensitive
// path is refused whole: nothing is sent. What is returned is exactly the
// body that goes out, so the transcript card shows what Advisor read.
import { secretShapeIn } from "@achoo254/chat-remote-protocol";
import { redact, redactTokens } from "../mcp/redact.ts";
import { mentionsSensitive } from "../safety/sensitive-paths.ts";
import type { WeighBody } from "./jev-client.ts";

export type Outbound = { ok: true; body: WeighBody } | { ok: false; why: string };

export const REFUSED_SECRET =
  "Not sent to Advisor: the request looks like it holds a key, password, token or private path. Send only a short abstract summary.";

export function outboundBody(input: WeighBody, isSensitive: (path: string) => boolean): Outbound {
  // The refusal weighs the text with only the held secrets, JWTs and Bearer values hidden (redactTokens): a key
  // `redact` would also hide still refuses the whole request, as before. What goes out is redacted fully.
  for (const text of [input.question, ...input.options, input.context].map((t) => redactTokens(t))) {
    if (secretShapeIn(text) !== undefined || mentionsSensitive(text, isSensitive)) return { ok: false, why: REFUSED_SECRET };
  }
  const body: WeighBody = {
    kind: input.kind,
    question: redact(input.question),
    options: input.options.map((o) => redact(o)),
    context: redact(input.context),
  };
  return { ok: true, body };
}

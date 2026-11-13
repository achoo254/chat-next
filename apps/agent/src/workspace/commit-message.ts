// A commit message for what a workspace has staged, written by the AI a
// device names (there is no default AI: each adapter that can write one has a
// TextWriter). The AI reads the staged file list and patch only (secret files
// by name); it commits nothing, and nothing of it is logged.
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { AgentError } from "../core/agent-core.ts";
import type { AgentProvider, Detected } from "../providers/types.ts";
import { OPS_LIMITS, type StagedChanges } from "./git-ops.ts";

/** Longest the AI may take. */
export const WRITE_TIMEOUT_MS = 120_000;

export type CommitMessageDeps = {
  providers: readonly AgentProvider[];
  staged: (workspaceId: string) => Promise<StagedChanges>;
  detect: (provider: AgentProvider) => Promise<Detected>;
  /** The account folder picked on the machine; throws when the profiles cannot be read. */
  accountDir: () => string | undefined;
};

export type CommitMessageRequest = { workspaceId: string; provider: string; model: string };

export function commitMessagePrompt(staged: StagedChanges): string {
  return [
    "Write a git commit message for the staged changes below.",
    "Rules: the first line is an imperative summary of at most 72 characters (Conventional Commits style such as \"fix(scope): ...\" when it fits).",
    "Add a blank line and a short body only when the change needs explaining (why, not how), wrapped at 72 characters.",
    "No trailers, no sign-off, no mention of AI, no quotes or code fences around it. Write in the language of the existing code comments, English when unsure.",
    "Reply with the commit message only.",
    "",
    "Staged files:",
    staged.files,
    "",
    "Staged patch:",
    staged.patch,
  ].join("\n");
}

/** The AI's answer as a commit message: without a code fence or quotes around it. */
export function cleanMessage(answer: string): string {
  let text = answer.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) text = text.slice(1, -1).trim();
  return text.slice(0, OPS_LIMITS.messageChars);
}

export async function writeCommitMessage(deps: CommitMessageDeps, req: CommitMessageRequest): Promise<string> {
  const provider = deps.providers.find((p) => p.id === req.provider);
  if (!provider) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `unknown AI "${req.provider}"`, { reason: ErrorReason.UNKNOWN_AI, subject: req.provider.slice(0, 100) });
  const writer = provider.writer;
  if (!writer) throw new AgentError(ErrorCode.INVALID, `${provider.name} cannot write a commit message`, { reason: ErrorReason.UNSUPPORTED_REQUEST });
  let accountDir: string | undefined;
  try {
    accountDir = deps.accountDir();
  } catch (err) {
    const why = (err as Error).message;
    throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, why, { reason: ErrorReason.PROFILE_UNUSABLE, subject: why.slice(0, 300) });
  }
  const detected = await deps.detect(provider);
  if (!detected.installed) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `${provider.name} is not installed`, { reason: ErrorReason.AI_NOT_INSTALLED, subject: provider.name });
  if (detected.loginState === "needs-login") throw new AgentError(ErrorCode.NEEDS_LOGIN, `${provider.name} needs sign-in`, { reason: ErrorReason.AI_NEEDS_LOGIN, subject: provider.name });
  const staged = await deps.staged(req.workspaceId);
  let answer: string;
  try {
    answer = await writer.write({
      prompt: commitMessagePrompt(staged),
      ...(req.model !== "" ? { model: req.model } : {}),
      ...(accountDir ? { accountDir } : {}),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  } catch (err) {
    const why = (err as Error).message;
    throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, why, { reason: ErrorReason.AI_START_FAILED, subject: why.slice(0, 300) });
  }
  const message = cleanMessage(answer);
  if (message === "") throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `${provider.name} wrote nothing`, { reason: ErrorReason.AI_START_FAILED, subject: "empty answer" });
  return message;
}

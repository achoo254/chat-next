// Adapters this build ships with. A new AI = one more entry here plus its
// folder under providers/, after it passes the provider contract tests.
import { createClaudeProvider } from "./claude/index.ts";
import type { AgentProvider } from "./types.ts";

/** `claudeHomes`: the machine's Claude folders whose sessions are listed (its own when unset). */
export function builtinProviders(claudeHomes?: () => string[]): AgentProvider[] {
  return [createClaudeProvider(claudeHomes ? { homes: claudeHomes } : {})];
}

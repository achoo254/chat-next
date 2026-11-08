// Adapters this build ships with. A new AI = one more entry here plus its
// folder under providers/, after it passes the provider contract tests.
import { createClaudeProvider } from "./claude/index.ts";
import type { AgentProvider } from "./types.ts";

export function builtinProviders(): AgentProvider[] {
  return [createClaudeProvider()];
}

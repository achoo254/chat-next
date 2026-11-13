// Adapters this build ships with. A new AI = one more entry here plus its
// folder under providers/, after it passes the provider contract tests.
import { claudeHomesIn, createClaudeProvider } from "./claude/index.ts";
import type { AgentProvider } from "./types.ts";

export type ProviderSources = {
  /** tunelo's config folder, where the accounts of each AI live. */
  configDir: string;
  /** The machine's Claude folders whose sessions are listed; read from configDir when unset. */
  claudeHomes?: () => string[];
};

export function builtinProviders(src: ProviderSources): AgentProvider[] {
  return [createClaudeProvider({ homes: src.claudeHomes ?? (() => claudeHomesIn(src.configDir)) })];
}

/** The AI with this id among `providers`; undefined when there is none. */
export function providerById(providers: readonly AgentProvider[], id: string): AgentProvider | undefined {
  return providers.find((p) => p.id === id);
}

/** Every AI that keeps sessions tunelo can read. */
export function withHistory(providers: readonly AgentProvider[]): AgentProvider[] {
  return providers.filter((p) => p.history !== undefined);
}

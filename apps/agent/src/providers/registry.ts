// Adapters this build ships with. A new AI = one more entry here plus its
// folder under providers/, after it passes the provider contract tests.
import type { AccountsStore } from "../accounts/store.ts";
import type { AuditLog } from "../safety/audit-log.ts";
import { CLAUDE_PROVIDER_ID } from "./claude/accounts/paths.ts";
import { createAntigravityProvider } from "./antigravity/index.ts";
import { claudeHomesIn, createClaudeProvider } from "./claude/index.ts";
import type { AgentProvider, ProviderInfo } from "./types.ts";

/** What every AI's accounts need from the machine; each AI's calls name the AI. */
export type AccountsHost = {
  store: AccountsStore;
  audit: AuditLog;
  /** A session of `provider` is open with this account. */
  inUse: (provider: string, id: string) => boolean;
  /** Usage just read for an account of `provider`. */
  onUsage: (provider: string, id: string, usage: NonNullable<ProviderInfo["rateLimits"]>) => void;
  log: (line: string) => void;
};

export type ProviderSources = {
  /** tunelo's config folder, where the accounts of each AI live. */
  configDir: string;
  /** Several accounts of each AI that can keep them; without it, every AI uses its own sign-in only. */
  accounts?: AccountsHost;
};

export function builtinProviders(src: ProviderSources): AgentProvider[] {
  const a = src.accounts;
  const claude = createClaudeProvider(
    a
      ? {
          accounts: {
            configDir: src.configDir,
            store: a.store,
            audit: a.audit,
            inUse: (id) => a.inUse(CLAUDE_PROVIDER_ID, id),
            onUsage: (id, usage) => a.onUsage(CLAUDE_PROVIDER_ID, id, usage),
            log: a.log,
          },
        }
      : { homes: () => claudeHomesIn(src.configDir) },
  );
  const antigravity = createAntigravityProvider(a ? { log: a.log } : {});
  return [claude, antigravity];
}

/** The AI with this id among `providers`; undefined when there is none. */
export function providerById(providers: readonly AgentProvider[], id: string): AgentProvider | undefined {
  return providers.find((p) => p.id === id);
}

/** Every AI that keeps sessions tunelo can read. */
export function withHistory(providers: readonly AgentProvider[]): AgentProvider[] {
  return providers.filter((p) => p.history !== undefined);
}

/** Every AI that keeps several accounts on the machine. */
export function withAccounts(providers: readonly AgentProvider[]): AgentProvider[] {
  return providers.filter((p) => p.accounts !== undefined);
}

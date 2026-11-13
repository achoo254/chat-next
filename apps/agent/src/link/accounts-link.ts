// The accounts of every AI as devices get and change them (AccountList and
// the requests beside it): who each account is and its usage, never a
// credential. A sign-in code is handed to the AI's CLI and dropped, never
// kept or logged. Each request names its AI; an AI that keeps no accounts is
// refused.
import { AccountStatus, ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import type { AccountErrorKind } from "../accounts/errors.ts";
import { AgentError } from "../core/agent-core.ts";
import type { AccountsFacet, AccountsView, AgentProvider, AiAccountInfo } from "../providers/types.ts";

export const ACCOUNT_REASONS: Record<AccountErrorKind, ErrorReason> = {
  damaged: ErrorReason.ACCOUNTS_DAMAGED,
  "not-found": ErrorReason.ACCOUNT_NOT_FOUND,
  "default-permanent": ErrorReason.DEFAULT_ACCOUNT_PERMANENT,
  "in-use": ErrorReason.ACCOUNT_IN_USE,
  "sign-out-failed": ErrorReason.ACCOUNT_SIGN_OUT_FAILED,
  "cli-missing": ErrorReason.AI_CLI_MISSING,
  "switch-blocked": ErrorReason.ACCOUNT_SWITCH_BLOCKED,
};

const STATUS: Record<AiAccountInfo["status"], AccountStatus> = {
  ok: AccountStatus.OK,
  "needs-sign-in": AccountStatus.NEEDS_SIGN_IN,
  error: AccountStatus.ERROR,
};

const window = (w?: { utilization: number; resetsAt: number }) => (w ? { utilization: w.utilization, resetsAt: BigInt(w.resetsAt) } : undefined);

function accountBody(provider: string, selectedId: string, a: AiAccountInfo) {
  const u = a.usage;
  const fiveHour = window(u?.fiveHour);
  const sevenDay = window(u?.sevenDay);
  return {
    provider,
    id: a.id,
    label: a.label,
    email: a.email,
    organization: a.organization,
    plan: a.plan,
    status: STATUS[a.status],
    current: a.id === selectedId,
    loginExpiresAt: BigInt(a.loginExpiresAt),
    createdAt: BigInt(a.createdAt),
    usageUpdatedAt: BigInt(u?.updatedAt ?? 0),
    ...(u ? { usage: { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } } : {}),
  };
}

/** One AI's accounts as `read` gives them, or why they cannot be read. */
export type AccountsRead = { provider: AgentProvider; view: AccountsView } | { provider: AgentProvider; damaged: string };

/** Every AI's accounts, read with `read` (the facet's list() or view()); an AI whose accounts cannot be read is named in `damaged`. */
export async function readAccounts(providers: readonly AgentProvider[], read: (f: AccountsFacet) => AccountsView | Promise<AccountsView>): Promise<AccountsRead[]> {
  const out: AccountsRead[] = [];
  for (const provider of providers) {
    if (!provider.accounts) continue;
    try {
      out.push({ provider, view: await read(provider.accounts) });
    } catch (err) {
      out.push({ provider, damaged: (err as Error).message.slice(0, 300) });
    }
  }
  return out;
}

/** The AccountListResult of what readAccounts gave. */
export function accountListBody(reads: readonly AccountsRead[]) {
  const accounts = [];
  const selectedByProvider: Record<string, string> = {};
  const damaged: Record<string, string> = {};
  const actions = [];
  for (const r of reads) {
    const f = r.provider.accounts;
    actions.push({ provider: r.provider.id, signIn: Boolean(f?.signIn), captureCurrent: Boolean(f?.captureCurrent), usage: Boolean(f?.refreshUsage) });
    if ("damaged" in r) {
      damaged[r.provider.id] = r.damaged;
      continue;
    }
    selectedByProvider[r.provider.id] = r.view.selectedId;
    for (const a of r.view.accounts) accounts.push(accountBody(r.provider.id, r.view.selectedId, a));
  }
  return { accounts, selectedByProvider, damaged, actions };
}

/** The accounts of the AI a request names; refused when it names none, one the machine does not know, or one that keeps no accounts. */
export function accountsOf(providers: readonly AgentProvider[], id: string): AccountsFacet {
  if (id === "") throw new AgentError(ErrorCode.INVALID, "no AI named", { reason: ErrorReason.PROVIDER_REQUIRED });
  const provider = providers.find((p) => p.id === id);
  if (!provider) throw new AgentError(ErrorCode.PROVIDER_UNAVAILABLE, `unknown AI "${id}"`, { reason: ErrorReason.UNKNOWN_AI, subject: id.slice(0, 100) });
  if (!provider.accounts) throw new AgentError(ErrorCode.INVALID, `${provider.name} keeps no accounts on this machine`, { reason: ErrorReason.NO_ACCOUNTS, subject: provider.id });
  return provider.accounts;
}

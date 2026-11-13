// The machine's accounts of one AI as every AI Agent screen shows them. The
// machine announces every AI's accounts whole (MachineAccounts) whenever
// anything changes, from any device or its own terminal, so the status bar,
// the account menu and the machine's page follow without asking. Until it
// does, the list is asked once (AccountList) and kept from the answers of
// the requests made here. Every screen sees only the accounts of its own AI.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountStatus, type AccountActions, type AccountListResult, type AiAccount, type Frame, type MachineAccounts, type ThreadInfo } from "@achoo254/chat-proto/remote/remote";
import type { MachineLink } from "./link/machine-link.ts";

type FrameBody = Parameters<MachineLink["request"]>[0];

export function listOf(frame: Frame): AccountListResult | null {
	return frame.body.case === "accountListResult" ? frame.body.value : null;
}

/** The accounts of one AI and the one picked for it on the machine. */
export interface ProviderAccounts {
	readonly accounts: readonly AiAccount[];
	/** The picked account ("" for the AI's own sign-in). */
	readonly selectedId: string;
	/** What the AI offers on its accounts (adding one, keeping its current sign-in, reading usage). */
	readonly actions: AccountActions | undefined;
	/** Why its saved accounts cannot be read now (in English); "" when they can. */
	readonly damaged: string;
}

/** The accounts of `provider` in `list`; null when the list is unknown or the machine keeps no accounts for that AI. */
export function accountsOf(list: AccountListResult | null, provider: string): ProviderAccounts | null {
	if (list === null || provider === "") return null;
	const accounts = list.accounts.filter((a) => a.provider === provider);
	const actions = list.actions.find((a) => a.provider === provider);
	if (accounts.length === 0 && actions === undefined) return null;
	return { accounts, selectedId: list.selectedByProvider[provider] ?? "", actions, damaged: list.damaged[provider] ?? "" };
}

export interface Profiles {
	/** The AI (ProviderInfo.id) these accounts belong to; every request names it. */
	readonly provider: string;
	/** The AI's accounts and the machine's pick; null until known. */
	readonly list: ProviderAccounts | null;
	/** Sends an account request; its answer (an AccountListResult) replaces the list until the machine announces the next. */
	readonly request: (body: FrameBody) => Promise<void>;
	/** Asks the list again (a machine that does not announce it). */
	readonly reload: () => void;
}

/** Every AI's accounts on the machine, as announced or asked once, and the requests that change them. */
export interface AccountList {
	/** null until known. */
	readonly whole: AccountListResult | null;
	/** Sends an account request; its answer (an AccountListResult) replaces the list until the machine announces the next. */
	readonly request: (body: FrameBody) => Promise<void>;
	/** Asks the list again (a machine that does not announce it). */
	readonly reload: () => void;
}

/** `ask`: false for a screen without an AI to show, which needs no list. */
export function useAccountList(link: MachineLink, announced: MachineAccounts | null, online: boolean, ask = true): AccountList {
	const [asked, setAsked] = useState<AccountListResult | null>(null);
	const [round, setRound] = useState(0);
	useEffect(() => {
		// A machine that announces its accounts needs no question.
		if (!online || announced !== null || !ask) return;
		let live = true;
		link.request({ case: "accountList", value: {} }).then(
			(frame) => {
				const next = listOf(frame);
				if (live && next !== null) setAsked(next);
			},
			// Unknown on this machine (no accounts, or offline meanwhile): nothing to show.
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [link, online, announced, ask, round]);
	const request = useCallback(
		async (body: FrameBody) => {
			const next = listOf(await link.request(body));
			if (next !== null) setAsked(next);
		},
		[link],
	);
	const reload = useCallback(() => setRound((n) => n + 1), []);
	return { whole: announced?.accounts ?? asked, request, reload };
}

/** The accounts of one AI out of `all`. */
export function profilesOf(all: AccountList, provider: string): Profiles {
	return { provider, list: accountsOf(all.whole, provider), request: all.request, reload: all.reload };
}

export function useProfiles(link: MachineLink, announced: MachineAccounts | null, online: boolean, provider: string): Profiles {
	const all = useAccountList(link, announced, online, provider !== "");
	const { whole, request, reload } = all;
	const list = useMemo(() => accountsOf(whole, provider), [whole, provider]);
	return useMemo(() => ({ provider, list, request, reload }), [provider, list, request, reload]);
}

/** The account `id` ("" for the AI's own sign-in) in `list`. */
export function profileById(list: ProviderAccounts | null, id: string): AiAccount | undefined {
	return list?.accounts.find((p) => p.id === id);
}

/** The account a session runs with: as the machine announced it, else as the session reported it, else the machine's pick. */
export function sessionProfileId(announced: MachineAccounts | null, threadId: string, info: ThreadInfo | undefined, list: ProviderAccounts | null): string {
	const session = announced?.sessions.find((s) => s.threadId === threadId);
	if (session !== undefined) return session.accountId;
	if (info !== undefined && (info.accountId !== "" || info.account !== undefined)) return info.accountId;
	return list?.selectedId ?? "";
}

/** The session moves to the machine's account once its turn ends. */
export function switchPending(announced: MachineAccounts | null, threadId: string, info: ThreadInfo | undefined): boolean {
	return announced?.sessions.find((s) => s.threadId === threadId)?.switchPending ?? info?.accountSwitchPending ?? false;
}

/** The AI reports the account signed in. */
export function signedIn(profile: AiAccount): boolean {
	return profile.status === AccountStatus.OK;
}

/** An account can be picked for the machine: an added one must still be signed in. */
export function usable(profile: AiAccount): boolean {
	return profile.id === "" || signedIn(profile);
}

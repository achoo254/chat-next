// Leaving or deleting a group that Chat syncs with another app (Chat Bridge) also does it in
// that app, when the link is usable: one action in Chat, not a second one beside it. Telegram
// cannot undo either, so each keeps its guard rails: a recent sign-in, the group's name typed
// again, and for deleting a second confirmation after a wait. Chat's own part runs after the
// app's, so a refused or failed step in the app stops before anything is gone anywhere.
import type { Chat } from "@achoo254/chat-core";
import { useState } from "react";
import type { GroupDeleteToken } from "../settings/bridge-api.ts";
import { bridgeError } from "../settings/bridge-client.ts";
import { useBridgeCopy } from "../settings/use-bridge-copy.ts";
import { canActInApp, useBridgeLink } from "../settings/use-bridge-link.ts";

/** What stopped a step: the name typed does not match, a sign-in is needed again, or it failed. */
export type LifecycleProblem = "wrongName" | "reauth" | "failed";

export interface AppLifecycle {
	/** The app in words ("Telegram"). */
	readonly appName: string;
	readonly problem: LifecycleProblem | null;
	/** Leaves the group in the app; true when it is done. */
	readonly leave: (name: string) => Promise<boolean>;
	/** Asks the app for a delete code, usable after a wait. */
	readonly requestDelete: (name: string) => Promise<GroupDeleteToken | null>;
	/** Deletes the group in the app with the code; true when it is done. */
	readonly deleteGroup: (name: string, token: GroupDeleteToken) => Promise<boolean>;
}

/** The app's side of leaving or deleting `chat`; null when the chat has no usable link (Chat's part only). */
export function useAppLifecycle(chat: Chat | null | undefined): AppLifecycle | null {
	const t = useBridgeCopy();
	const { link } = useBridgeLink(chat?.id ?? 0, chat?.externalApp !== undefined);
	const [problem, setProblem] = useState<LifecycleProblem | null>(null);
	if (!canActInApp(link)) return null;
	const guarded = async <T,>(call: () => Promise<T>): Promise<T | null> => {
		setProblem(null);
		try {
			return await call();
		} catch (err) {
			const kind = bridgeError(err).kind;
			setProblem(kind === "confirmation_wrong" ? "wrongName" : kind === "reauth" ? "reauth" : "failed");
			return null;
		}
	};
	return {
		appName: t.apps[link.source] ?? t.appFallback(link.source),
		problem,
		leave: async (name) => (await guarded(() => link.api.leaveGroup(link.accountId, link.conversationId, name))) !== null,
		requestDelete: (name) => guarded(() => link.api.requestGroupDelete(link.accountId, link.conversationId, name)),
		deleteGroup: async (name, token) =>
			(await guarded(() => link.api.deleteGroup(link.accountId, link.conversationId, name, token.token))) !== null,
	};
}

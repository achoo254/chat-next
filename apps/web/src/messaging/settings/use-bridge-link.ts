// The link of a chat copied from another app (Chat Bridge): the account that syncs it, its
// conversation in that app and what the app supports for it. Shared by the group tools of the
// info panel and by the leave and delete dialogs, which act in the other app as well when the
// link is usable (an active account whose feature "lifecycle" sends from Chat).
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../data/services.tsx";
import type { BridgeApi, GroupDeleteToken } from "./bridge-api.ts";
import { bridgeClient } from "./bridge-client.ts";
import type { BridgeFeatureView } from "./bridge-features-model.ts";

export interface BridgeLink {
	readonly accountId: number;
	readonly conversationId: string;
	/** The app's id ("telegram"); its name in words comes from the copy. */
	readonly source: string;
	readonly features: readonly BridgeFeatureView[];
	readonly api: BridgeApi;
}

/** The link of `chatId`, null while unknown or when the chat has no active link; `reload` asks again. */
export function useBridgeLink(chatId: number, enabled = true): { link: BridgeLink | null; reload: () => void } {
	const { transport } = useServices();
	const [link, setLink] = useState<BridgeLink | null>(null);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const api = bridgeClient(transport);
		void (async () => {
			try {
				const status = await api.status();
				for (const account of status.accounts) {
					const chat = account.chats.find((c) => c.chatId === chatId);
					if (chat === undefined || account.status !== "active") continue;
					const features = await api.features(account.id, chat.conversationId);
					if (live) setLink({ accountId: account.id, conversationId: chat.conversationId, source: account.source, features, api });
					return;
				}
			} catch {
				// Nothing to act on in the other app; the chat's own actions still work.
			}
		})();
		return () => {
			live = false;
		};
	}, [transport, chatId, enabled, version]);
	const reload = useCallback(() => setVersion((v) => v + 1), []);
	return { link: enabled ? link : null, reload };
}

/** Whether the link lets Chat leave and delete the group in the other app. */
export function canActInApp(link: BridgeLink | null): link is BridgeLink {
	const lifecycle = link?.features.find((feature) => feature.feature === "lifecycle");
	return lifecycle !== undefined && lifecycle.canSend && (lifecycle.direction === "out" || lifecycle.direction === "both");
}

export type { GroupDeleteToken };

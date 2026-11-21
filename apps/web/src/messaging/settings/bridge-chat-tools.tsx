// What Chat can do to people and groups in the other app for one synced group (invite links
// of the app, adding a person, leaving and deleting the group), shown in the group's info
// panel since the one switch (ADR 0024) took the per-chat settings away. Each action keeps
// its own guard rails (the name typed again, a second confirmation that waits).
// Loaded only for a chat copied from another app.
import { useEffect, useState } from "react";
import { paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";
import type { BridgeError } from "./bridge-api.ts";
import { bridgeClient, bridgeError } from "./bridge-client.ts";
import { BridgeReauthBanner } from "./bridge-reauth-banner.tsx";
import type { BridgeFeatureView } from "./bridge-features-model.ts";
import { BridgePeople } from "./bridge-people.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import "./bridge-settings.css";

interface Linked {
	readonly accountId: number;
	readonly conversationId: string;
	readonly appName: string;
	readonly features: readonly BridgeFeatureView[];
}

export function BridgeChatTools({ chatId, title }: { chatId: number; title: string }) {
	const t = useBridgeCopy();
	const { transport, toasts } = useServices();
	const api = bridgeClient(transport);
	const [linked, setLinked] = useState<Linked | null>(null);
	const [version, setVersion] = useState(0);
	const [reauth, setReauth] = useState(false);
	const onError = (err: unknown): BridgeError => {
		const error = bridgeError(err);
		if (error.kind === "reauth") setReauth(true);
		else toasts.show(t.failed);
		return error;
	};
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const status = await api.status();
				for (const account of status.accounts) {
					const chat = account.chats.find((c) => c.chatId === chatId);
					if (chat === undefined || account.status !== "active") continue;
					const features = await api.features(account.id, chat.conversationId);
					if (live) {
						setLinked({ accountId: account.id, conversationId: chat.conversationId, appName: t.apps[account.source] ?? t.appFallback(account.source), features });
					}
					return;
				}
			} catch {
				// The info panel works without these tools; nothing to show.
			}
		})();
		return () => {
			live = false;
		};
	}, [chatId, version]); // eslint-disable-line react-hooks/exhaustive-deps
	if (linked === null) return null;
	return (
		<div className="info-sec br-chat-tools" data-id="bridge-chat-tools">
			<h3>{t.people.title}</h3>
			{reauth && <BridgeReauthBanner returnTo={paths.chat(chatId)} />}
			<BridgePeople
				accountId={linked.accountId}
				conversationId={linked.conversationId}
				chatTitle={title}
				appName={linked.appName}
				api={api}
				features={linked.features}
				disabled={false}
				onChanged={() => setVersion((v) => v + 1)}
				onError={onError}
			/>
		</div>
	);
}

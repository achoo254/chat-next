// What Chat can do to people in the other app for one synced group (invite links of the app,
// adding a person), shown in the group's info panel since the one switch (ADR 0024) took the
// per-chat settings away. Leaving and deleting the group are not here: the leave and delete
// dialogs of the chat do them in the app as well (ui/chat-dialogs.tsx). Loaded only for a
// chat copied from another app.
import { useState } from "react";
import { paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";
import type { BridgeError } from "./bridge-api.ts";
import { bridgeError } from "./bridge-client.ts";
import { BridgeReauthBanner } from "./bridge-reauth-banner.tsx";
import { BridgePeople } from "./bridge-people.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import { useBridgeLink } from "./use-bridge-link.ts";
import "./bridge-settings.css";

export function BridgeChatTools({ chatId, title }: { chatId: number; title: string }) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const { link, reload } = useBridgeLink(chatId);
	const [reauth, setReauth] = useState(false);
	const onError = (err: unknown): BridgeError => {
		const error = bridgeError(err);
		if (error.kind === "reauth") setReauth(true);
		// A wrong typed name is already told beside the field, so it gets no toast on top.
		else if (error.kind !== "confirmation_wrong") toasts.show(t.failed);
		return error;
	};
	if (link === null) return null;
	return (
		<div className="info-sec br-chat-tools" data-id="bridge-chat-tools">
			<h3>{t.people.title}</h3>
			{reauth && <BridgeReauthBanner returnTo={paths.chat(chatId)} />}
			<BridgePeople
				accountId={link.accountId}
				conversationId={link.conversationId}
				chatTitle={title}
				appName={t.apps[link.source] ?? t.appFallback(link.source)}
				api={link.api}
				features={link.features}
				disabled={false}
				onChanged={reload}
				onError={onError}
			/>
		</div>
	);
}

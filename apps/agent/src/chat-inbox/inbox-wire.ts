/** The chat inbox's subscriptions as devices get them (ChatInboxState). */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ChatInboxItemState, type ChatInboxStateSchema } from "@achoo254/chat-proto/remote/remote";
import type { InboxItemView, InboxState } from "./chat-inbox.ts";

const STATES: Readonly<Record<InboxState, ChatInboxItemState>> = {
	active: ChatInboxItemState.ACTIVE,
	hidden: ChatInboxItemState.HIDDEN,
	limited: ChatInboxItemState.LIMITED,
	error: ChatInboxItemState.ERROR,
	"signed-out": ChatInboxItemState.SIGNED_OUT,
};

export function chatInboxStateBody(items: readonly InboxItemView[]): MessageInitShape<typeof ChatInboxStateSchema> {
	return {
		items: items.map((i) => ({
			chatId: BigInt(i.chatId),
			title: i.title,
			app: i.app,
			enabled: i.enabled,
			perHourLimit: i.perHourLimit,
			state: STATES[i.state],
			deliveredLastHour: i.deliveredLastHour,
			missed: i.missed,
			lastDeliveryAt: BigInt(i.lastDeliveryAt),
		})),
	};
}

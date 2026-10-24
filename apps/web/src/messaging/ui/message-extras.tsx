// Lines few messages carry, loaded with the first message that shows one
// (message-item.tsx): service messages ("… đã ghim một tin"), the "Chuyển
// tiếp từ" header of a forwarded message and the "qua @bot" line.
import type { StoredMessage } from "@achoo254/chat-core";
import { useCopy } from "../copy/use-copy.ts";
import { actionText, messagePreview, namedUserIds } from "../data/format.ts";
import { useChat, useMessage, useUser } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { ChatAvatar } from "./parts.tsx";

export function SystemLine({ message, channel }: { message: StoredMessage; channel: boolean }) {
	const copy = useCopy();
	const pinnedSeq = message.action?.kind === "message_pinned" ? message.action.seq : 0;
	const pinned = useMessage(message.chatId, pinnedSeq);
	const nameOf = useNameOf([...namedUserIds(message), ...(pinned == null ? [] : namedUserIds(pinned))]);
	if (message.action === null) return null;
	const actorName = nameOf(message.fromId);
	const text =
		message.action.kind === "message_pinned"
			? copy.system.pinned(actorName, pinned == null ? "" : messagePreview(pinned, nameOf, copy, channel).slice(0, 60))
			: actionText(message.action, actorName, nameOf, copy, channel);
	return (
		<span className="system" data-seq={message.seq}>
			{text}
		</span>
	);
}

export function ForwardLine({ message }: { message: StoredMessage }) {
	"use no memo";
	const copy = useCopy();
	const forward = message.forward;
	const user = useUser(forward?.fromUserId ?? 0);
	const sourceChat = useChat(forward?.fromChatId ?? 0);
	if (forward === null) return null;
	const name = forward.fromName || user?.name || sourceChat?.title || copy.message.unknownUser;
	const id = forward.fromChatId !== 0 ? forward.fromChatId : forward.fromUserId;
	return (
		<span className="fwd">
			{copy.message.forwardedFrom} <ChatAvatar id={id} name={name} size="xs" /> <b>{name}</b>
		</span>
	);
}

/** "via @bot": the bot whose inline result the message is. */
export function ViaLine({ botId }: { botId: number }) {
	"use no memo";
	const copy = useCopy();
	const bot = useUser(botId);
	if (botId === 0 || bot === undefined || bot.username === "") return null;
	return (
		<span className="via-bot">
			{copy.message.viaBot} <b>@{bot.username}</b>
		</span>
	);
}

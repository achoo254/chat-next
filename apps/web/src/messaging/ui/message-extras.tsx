// Lines few messages carry, loaded with the first message that shows one
// (message-item.tsx): service messages ("… đã ghim một tin"), the "Chuyển
// tiếp từ" header of a forwarded message and the "qua @bot" line; also the
// link preview card under a message that has one.
import { Suspense, lazy } from "react";
import type { StoredMessage } from "@achoo254/chat-core";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useCopy } from "../copy/use-copy.ts";
import { actionText, messagePreview, namedUserIds } from "../data/format.ts";
import { useChat, useMessage, useUser } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { ChatAvatar } from "./parts.tsx";
import type { RichContext } from "./rich-text.tsx";

const LinkPhoto = lazy(() => import("../media/media-content.tsx").then((m) => ({ default: m.LinkPhoto })));

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
	const fromChat = forward.fromChatId !== 0;
	const id = fromChat ? forward.fromChatId : forward.fromUserId;
	const photoId = (fromChat ? sourceChat?.photoId : user?.photoId) ?? "";
	return (
		<span className="fwd">
			{copy.message.forwardedFrom}{" "}
			<ChatAvatar id={id} name={name} size="xs" photoId={photoId} {...(fromChat ? { chatPhotoOf: id } : { photoOf: id })} /> <b>{name}</b>
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

export function LinkPreviewCard({ preview, message, ctx }: { preview: LinkPreview; message: StoredMessage; ctx: RichContext }) {
	"use no memo";
	const photo = message.linkPreview?.photo !== undefined;
	return (
		<a
			className={photo ? "lp has-thumb" : "lp"}
			href={preview.url}
			target="_blank"
			rel="noopener noreferrer"
			onClick={(event) => {
				event.preventDefault();
				ctx.openLink(preview.url);
			}}
		>
			<span className="site">{preview.site}</span>
			<b>{preview.title}</b>
			{preview.description !== "" && <span className="desc">{preview.description}</span>}
			{photo && (
				<Suspense fallback={<span className="thumb" aria-hidden="true" />}>
					<LinkPhoto message={message} />
				</Suspense>
			)}
		</a>
	);
}

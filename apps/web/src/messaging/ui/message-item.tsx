// One message (mockups/chat.html#message-kinds, #rich-messages): sender,
// forward header, reply quote, formatted text, text-only link preview,
// reactions and the send state of your own messages.
import { memo, type ReactNode } from "react";
import type { Chat, PendingMessage, StoredMessage } from "@app/core";
import type { LinkPreview } from "../data/pending-backend.ts";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { actionText, clock, messagePreview, toneOf, userName } from "../data/format.ts";
import { useChat, useConnection, useItem, useMessage, useServices, useUser } from "../data/services.tsx";
import { LabelledIcon, useContextTrigger } from "./chat-row.tsx";
import { ChatAvatar } from "./parts.tsx";
import { linkOpener, mentionsSelf, RichText, type RichContext } from "./rich-text.tsx";
import { useIntent, useUi } from "./ui-context.tsx";

interface MessageItemProps {
	chatId: number;
	itemKey: string;
	chat: Chat | null;
	/** Read position of the other side, for the read ticks. */
	readOutboxMaxSeq: number;
	/** Keyboard roving focus: only one message is in the tab order. */
	tabbable: boolean;
}

export const MessageItem = memo(function MessageItem({ chatId, itemKey, chat, readOutboxMaxSeq, tabbable }: MessageItemProps) {
	const item = useItem(chatId, itemKey);
	if (item === undefined) return null;
	if (item.kind === "pending") {
		return <PendingBubble chatId={chatId} itemKey={itemKey} pending={item.pending} chat={chat} tabbable={tabbable} />;
	}
	if (item.message.action !== null) return <SystemLine message={item.message} channel={chat?.type === "channel"} />;
	return (
		<MessageBubble
			chatId={chatId}
			itemKey={itemKey}
			message={item.message}
			chat={chat}
			readOutboxMaxSeq={readOutboxMaxSeq}
			tabbable={tabbable}
		/>
	);
});

function SystemLine({ message, channel }: { message: StoredMessage; channel: boolean }) {
	const copy = useCopy();
	const { store } = useServices();
	const actor = useUser(message.fromId === store.selfId ? 0 : message.fromId);
	const pinnedSeq = message.action?.kind === "message_pinned" ? message.action.seq : 0;
	const pinned = useMessage(message.chatId, pinnedSeq);
	if (message.action === null) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	const actorName = userName(actor, store.selfId, copy, message.fromId);
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

/** Context menu on right click, long press or the keyboard (Enter, Shift+F10, Menu key). */
function useMenuTrigger(chatId: number, itemKey: string) {
	const ui = useUi();
	return useContextTrigger(() => ui.menu.set({ chatId, key: itemKey }), true);
}

/** `fromId`: the sender, named in the external link confirmation. */
function useRichContext(fromId: number): RichContext {
	const { self } = useServices();
	const ui = useUi();
	return {
		selfId: self.id,
		selfUsername: self.username,
		openLink: linkOpener((url, text) => ui.dialog.set({ kind: "link", url, text, fromId })),
	};
}

function Stamp({ date, edited, children }: { date: number; edited: boolean; children?: ReactNode }) {
	const copy = useCopy();
	const { locale } = useI18n();
	return (
		<span className="stamp">
			{edited ? `${copy.message.edited} ${clock(date, locale)}` : clock(date, locale)}
			{children}
		</span>
	);
}

function ReplyQuote({ chatId, seq }: { chatId: number; seq: number }) {
	const copy = useCopy();
	const { store } = useServices();
	const target = useMessage(chatId, seq);
	const channel = useChat(chatId)?.type === "channel";
	const author = useUser(target != null && target.fromId !== store.selfId ? target.fromId : 0);
	if (target === undefined) return <span className="reply">…</span>;
	if (target === null) {
		return <span className="reply">{copy.message.deleted}</span>;
	}
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	const name = target.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser);
	return (
		<button
			type="button"
			className={`reply s-${toneOf(target.fromId)}`}
			onClick={() => store.openWindow(chatId, seq)}
		>
			<b>{name}</b>
			<span className="q">{messagePreview(target, nameOf, copy, channel)}</span>
		</button>
	);
}

function ForwardLine({ message }: { message: StoredMessage }) {
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

function Reactions({ message }: { message: StoredMessage }) {
	const copy = useCopy();
	const { remote, backend, store, toasts } = useServices();
	if (message.reactions.length === 0) return null;
	const toggle = (emoji: string, chosen: boolean) => {
		remote.setReaction(message.chatId, message.seq, chosen ? "" : emoji).catch(() => toasts.show(copy.common.failed));
	};
	return (
		<div className="reactions">
			{message.reactions.map((reaction) => {
				const reactors = backend.reactors(message.chatId, message.seq, reaction.emoji);
				const names = reactors?.map((id) => userName(store.user(id), store.selfId, copy, id)).join(", ");
				return (
					<button
						key={reaction.emoji}
						type="button"
						className="reaction"
						aria-pressed={reaction.chosen}
						aria-label={
							names === undefined
								? copy.message.reaction(reaction.emoji, reaction.count)
								: copy.message.reactedBy(reaction.emoji, names)
						}
						onClick={() => toggle(reaction.emoji, reaction.chosen)}
					>
						<span aria-hidden="true">{reaction.emoji}</span>
						{reactors === null ? (
							<span aria-hidden="true">{reaction.count}</span>
						) : (
							<span className="r-avs" aria-hidden="true">
								{reactors.slice(0, 3).map((id) => (
									<ChatAvatar key={id} id={id} name={userName(store.user(id), store.selfId, copy, id)} size="xs" />
								))}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}

function LinkPreviewCard({ preview, ctx }: { preview: LinkPreview; ctx: RichContext }) {
	return (
		<a
			className="lp"
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
		</a>
	);
}

interface BubbleProps {
	chatId: number;
	itemKey: string;
	message: StoredMessage;
	chat: Chat | null;
	readOutboxMaxSeq: number;
	tabbable: boolean;
	/** Rendered again inside the message menu: no handlers, no focus. */
	inert?: boolean;
}

export function MessageBubble({ chatId, itemKey, message, chat, readOutboxMaxSeq, tabbable, inert = false }: BubbleProps) {
	const copy = useCopy();
	const { store, self, backend } = useServices();
	const ui = useUi();
	const ctx = useRichContext(message.fromId);
	const intent = useIntent(chatId);
	const preview = backend.features.has("linkPreview") ? backend.linkPreview(message) : null;
	// With a preview card or reactions the time goes on its own line at the end (mock #rich-messages).
	const trailingStamp = preview !== null || message.reactions.length > 0;
	const trigger = useMenuTrigger(chatId, itemKey);
	const mine = message.fromId === store.selfId;
	const channel = chat?.type === "channel";
	const group = chat?.type === "group";
	const sender = useUser(mine || channel ? 0 : message.fromId);
	const senderName = channel ? (chat?.title ?? "") : (sender?.name ?? copy.message.unknownUser);
	const tone = toneOf(message.fromId);
	const atMe = !mine && mentionsSelf(message.text, message.entities, self.id, self.username);
	const unsupported = message.text === "" && message.mediaKind === null;
	const read = mine && readOutboxMaxSeq >= message.seq;

	const editing = !inert && intent?.mode === "edit" && intent.seq === message.seq;
	const classes = ["msg", mine ? "mine" : "", channel ? "post" : "", atMe ? "at-me" : "", editing ? "editing" : ""].filter(Boolean).join(" ");
	const stamp = (
		<Stamp date={message.editDate !== 0 ? message.editDate : message.date} edited={message.editDate !== 0}>
			{mine && !channel && (
				<LabelledIcon
					name={read ? "checks" : "check"}
					label={read ? copy.message.read : copy.message.sentTick}
					className={read ? "read" : undefined}
				/>
			)}
		</Stamp>
	);
	const showSender = !mine && (group || channel);
	return (
		<div
			className={classes}
			data-key={itemKey}
			data-seq={message.seq}
			tabIndex={inert ? undefined : tabbable ? 0 : -1}
			{...(inert ? {} : trigger)}
		>
			{group && !mine && (
				<button
					type="button"
					className="avatar-btn"
					aria-label={senderName}
					tabIndex={inert ? -1 : undefined}
					onClick={() => ui.dialog.set({ kind: "profile", userId: message.fromId })}
				>
					<ChatAvatar id={message.fromId} name={senderName} size="sm" bot={sender?.isBot === true} />
				</button>
			)}
			{unsupported ? (
				<div className="bubble unsupported">
					<Icon name="alert" />
					<div>
						<p>{copy.message.unsupportedTitle}</p>
						<small>{copy.message.unsupportedBody(senderName)}</small>
						<button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
							{copy.message.reload}
						</button>
					</div>
				</div>
			) : (
				<div className={message.integrationLabel !== "" ? "bubble integration" : "bubble"}>
					{message.integrationLabel !== "" && (
						<span className="int-label">
							<Icon name="webhook" />
							{copy.message.integration(message.integrationLabel)}
						</span>
					)}
					{showSender && message.integrationLabel === "" && <span className={`who s-${tone}`}>{senderName}</span>}
					<ForwardLine message={message} />
					{message.replyToSeq !== 0 && <ReplyQuote chatId={chatId} seq={message.replyToSeq} />}
					{message.mediaKind !== null && <p className="via">{copy.message.media}</p>}
					<RichText text={message.text} entities={message.entities} ctx={ctx} tail={trailingStamp ? undefined : stamp} />
					{preview !== null && <LinkPreviewCard preview={preview} ctx={ctx} />}
					<Reactions message={message} />
					{trailingStamp && <p>{stamp}</p>}
				</div>
			)}
		</div>
	);
}

interface PendingProps {
	chatId: number;
	itemKey: string;
	pending: PendingMessage;
	chat: Chat | null;
	tabbable: boolean;
	inert?: boolean;
}

export function PendingBubble({ chatId, itemKey, pending, chat, tabbable, inert = false }: PendingProps) {
	const copy = useCopy();
	const { source, toasts, self } = useServices();
	const connection = useConnection();
	const ctx = useRichContext(self.id);
	const trigger = useMenuTrigger(chatId, itemKey);
	const failed = pending.failure !== null;
	const waiting = connection === "offline" || connection === "waiting";
	const icon = failed ? "alert" : "clock";
	const label = failed ? copy.message.failed : waiting ? copy.message.queued : copy.message.sending;
	const stamp = (
		<Stamp date={pending.date} edited={false}>
			<LabelledIcon name={icon} label={label} className={failed ? "fail" : undefined} />
		</Stamp>
	);
	const bubble = (
		<div className="bubble">
			{pending.replyToSeq !== 0 && <ReplyQuote chatId={chatId} seq={pending.replyToSeq} />}
			<RichText text={pending.text} entities={pending.entities} ctx={ctx} tail={stamp} />
		</div>
	);
	return (
		<div
			className={chat?.type === "channel" ? "msg mine post" : "msg mine"}
			data-key={itemKey}
			tabIndex={inert ? undefined : tabbable ? 0 : -1}
			{...(inert ? {} : trigger)}
		>
			{failed ? (
				<div className="msg-stack">
					{bubble}
					{!inert && (
						<div className="failed-row">
							{copy.message.notSent}
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => {
									source.retryOutbox(pending.outboxId).catch(() => toasts.show(copy.common.failed));
								}}
							>
								{copy.message.resend}
							</button>
						</div>
					)}
				</div>
			) : (
				bubble
			)}
		</div>
	);
}

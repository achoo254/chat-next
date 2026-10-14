// One message (mockups/chat.html#message-kinds, #rich-messages,
// #context-menu): sender, forward header, reply quote, formatted text,
// text-only link preview, reactions and the send state of your own messages
// ("Đã gửi", "Đã xem"). Hovering shows quick actions (Thả cảm xúc · Trả lời ·
// Chuyển tiếp · …); a double click replies. Right click, a long press or the
// menu key on a reaction lists who reacted with it.
import { memo, type ReactNode } from "react";
import type { Chat, PendingMessage, StoredMessage } from "@app/core";
import type { LinkPreview } from "../data/pending-backend.ts";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { actionText, clock, messagePreview, namedUserIds, toneOf } from "../data/format.ts";
import { useChat, useConnection, useItem, useMessage, useServices, useUser } from "../data/services.tsx";
import { LabelledIcon, useContextTrigger, useNameOf } from "./chat-row.tsx";
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
	const nameOf = useNameOf(target == null ? [] : namedUserIds(target));
	if (target === undefined) return <span className="reply">…</span>;
	if (target === null) {
		return <span className="reply">{copy.message.deleted}</span>;
	}
	const name = nameOf(target.fromId);
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

/** One reaction chip: a click toggles yours; the context menu lists who reacted with it. */
function ReactionChip({ message, emoji, count, chosen }: { message: StoredMessage; emoji: string; count: number; chosen: boolean }) {
	const copy = useCopy();
	const { remote, toasts } = useServices();
	const ui = useUi();
	const trigger = useContextTrigger(() => ui.dialog.set({ kind: "reactors", chatId: message.chatId, seq: message.seq, emoji }), true);
	return (
		<button
			type="button"
			className="reaction"
			aria-pressed={chosen}
			aria-label={copy.message.reaction(emoji, count)}
			title={copy.message.whoReacted(emoji)}
			onClick={() => {
				remote.setReaction(message.chatId, message.seq, chosen ? "" : emoji).catch(() => toasts.show(copy.common.failed));
			}}
			{...trigger}
			// The message under the chip has its own menu: the chip's gestures stop here.
			onContextMenu={(event) => {
				event.stopPropagation();
				trigger.onContextMenu(event);
			}}
			onTouchStart={(event) => {
				event.stopPropagation();
				trigger.onTouchStart(event);
			}}
			onKeyDown={(event) => {
				// Enter and Space toggle the reaction; the menu keys list who reacted.
				if (event.key === "Enter") return;
				trigger.onKeyDown(event);
			}}
		>
			<span aria-hidden="true">{emoji}</span>
			<span aria-hidden="true">{count}</span>
		</button>
	);
}

function Reactions({ message }: { message: StoredMessage }) {
	if (message.reactions.length === 0) return null;
	return (
		<div className="reactions">
			{message.reactions.map((reaction) => (
				<ReactionChip key={reaction.emoji} message={message} emoji={reaction.emoji} count={reaction.count} chosen={reaction.chosen} />
			))}
		</div>
	);
}

/** Buttons that show when the pointer is over a message (#context-menu); the keyboard has the menu. */
function QuickActions({ chatId, itemKey, seq, label, canReply }: { chatId: number; itemKey: string; seq: number; label: string; canReply: boolean }) {
	const copy = useCopy();
	const ui = useUi();
	return (
		<div className="msg-actions" role="toolbar" aria-label={label}>
			<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.react} onClick={() => ui.menu.set({ chatId, key: itemKey, picker: true })}>
				<Icon name="smile" small />
			</button>
			{canReply && (
				<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.reply} onClick={() => ui.intents.cell(chatId).set({ mode: "reply", seq })}>
					<Icon name="reply" small />
				</button>
			)}
			<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.forward} onClick={() => ui.dialog.set({ kind: "forward", chatId, seq })}>
				<Icon name="forward" small />
			</button>
			<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.more} onClick={() => ui.menu.set({ chatId, key: itemKey })}>
				<Icon name="dots" small />
			</button>
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
	const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
	const canReply = !channel || admin;

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
			onDoubleClick={
				inert || !canReply
					? undefined
					: (event) => {
							if ((event.target as Element).closest("a, button, .spoiler") !== null) return;
							window.getSelection()?.removeAllRanges();
							ui.intents.cell(chatId).set({ mode: "reply", seq: message.seq });
						}
			}
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
					{!inert && (
						<QuickActions
							chatId={chatId}
							itemKey={itemKey}
							seq={message.seq}
							label={mine ? copy.message.quickActionsMine : copy.message.quickActions(senderName)}
							canReply={canReply}
						/>
					)}
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

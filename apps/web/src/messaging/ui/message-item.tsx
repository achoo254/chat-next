// One message (mockups/chat.html#message-kinds, #rich-messages,
// #context-menu): sender, forward header, reply quote, formatted text,
// text-only link preview, reactions and the send state of your own messages
// ("Đã gửi", "Đã xem"). Hovering shows quick actions (Thả cảm xúc · Trả lời ·
// Chuyển tiếp · …); a double click replies. Right click, a long press or the
// menu key on a reaction lists who reacted with it. Messages of incoming
// webhooks (mockups/integrations.html#alert-message, #alert-grouping) carry
// the "Tích hợp: <tên>" label, a Firing/Resolved chip when their first line
// starts with one, URL buttons, and "đã cập nhật" when edited in place. Bot
// messages carry callback buttons too (mockups/bots.html#inline-keyboard):
// the pressed one waits for the bot's answer while the others stay usable.
import { Suspense, lazy, memo, type ReactNode } from "react";
import type { Chat, MediaKind, PendingMessage, ReactionCount, StoredMessage } from "@app/core";
import type { LinkPreview } from "../data/pending-backend.ts";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { actionText, clock, integrationTone, isSavedChat, messagePreview, namedUserIds, toneOf } from "../data/format.ts";
import { useChat, useConnection, useItem, useMessage, useServices, useUser } from "../data/services.tsx";
import { LabelledIcon, useContextTrigger, useNameOf } from "./chat-row.tsx";
import { ChatAvatar } from "./parts.tsx";
import { splitAlert } from "./alert-text.ts";
import { pillContent } from "./reaction-pill.ts";
import { isAllowedLink, laterLinkOpener, linkOpener, mentionsSelf, RichText, type RichContext } from "./rich-text.tsx";
import { Cell, useCell, useIntent, useUi } from "./ui-context.tsx";
import { albumBox, boxStyle, isVisual, mediaBox } from "../media/box.ts";

// Photos, files, voice and uploads render with the media chunk, loaded the
// first time a chat shows one; until then their box is reserved (box.ts).
const mediaChunk = () => import("../media/media-content.tsx");
const MessageMedia = lazy(() => mediaChunk().then((m) => ({ default: m.MessageMedia })));
const AlbumMedia = lazy(() => mediaChunk().then((m) => ({ default: m.AlbumMedia })));
const PendingMediaView = lazy(() => mediaChunk().then((m) => ({ default: m.PendingMediaView })));
const PendingAlbumMedia = lazy(() => mediaChunk().then((m) => ({ default: m.PendingAlbumMedia })));
const LinkPhoto = lazy(() => mediaChunk().then((m) => ({ default: m.LinkPhoto })));

interface Shape {
	readonly kind: MediaKind;
	readonly width: number;
	readonly height: number;
}

/** The box a message's media will fill, shown while the media chunk loads. */
function MediaReserve({ shape, count, visual }: { shape: Shape; count: number; visual: boolean }) {
	if (count > 1 && visual) return <span className="media-box" style={boxStyle(albumBox(count))} />;
	if (count > 1) {
		return (
			<span className="media-slot">
				{Array.from({ length: count }, (_, index) => (
					<span key={index} className="media-box card" />
				))}
			</span>
		);
	}
	if (isVisual(shape)) return <span className="media-box" style={boxStyle(mediaBox(shape.width, shape.height))} />;
	return <span className="media-box card" />;
}

/** Keys of an album's messages joined by "," (the list passes a string so memo holds). */
function splitKeys(albumKeys: string): string[] {
	return albumKeys === "" ? [] : albumKeys.split(",");
}

/** Whether every message of an album is a photo or video (a grid) rather than files (a stack). */
function visualAlbum(items: readonly ({ readonly kind: MediaKind } | undefined)[]): boolean {
	return items.every((media) => media === undefined || isVisual(media));
}

interface MessageItemProps {
	chatId: number;
	itemKey: string;
	/** Albums: every message's key joined by "," (this item is the first); "" for a single message. */
	albumKeys?: string;
	chat: Chat | null;
	/** Read position of the other side, for the read ticks. */
	readOutboxMaxSeq: number;
	/** Keyboard roving focus: only one message is in the tab order. */
	tabbable: boolean;
}

export const MessageItem = memo(function MessageItem({ chatId, itemKey, albumKeys = "", chat, readOutboxMaxSeq, tabbable }: MessageItemProps) {
	const { store } = useServices();
	const keys = splitKeys(albumKeys);
	// An album's caption, reactions and menu belong to the message carrying the text (else the first).
	const captionKey =
		keys.find((key) => {
			const candidate = store.item(chatId, key);
			return candidate?.kind === "message" ? candidate.message.text !== "" : candidate?.kind === "pending" && candidate.pending.text !== "";
		}) ?? itemKey;
	const item = useItem(chatId, captionKey);
	if (item === undefined) return null;
	if (item.kind === "pending") {
		return <PendingBubble chatId={chatId} itemKey={captionKey} rowKey={itemKey} albumKeys={keys} pending={item.pending} chat={chat} tabbable={tabbable} />;
	}
	if (item.message.action !== null) return <SystemLine message={item.message} channel={chat?.type === "channel"} />;
	return (
		<MessageBubble
			chatId={chatId}
			itemKey={captionKey}
			rowKey={itemKey}
			albumKeys={keys}
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

/**
 * `edited`: "đã sửa" or "đã cập nhật" before the time; "" for none.
 * `silent`: the bell-off mark of a message posted without a notification
 * (mockups/integrations.html#alert-grouping), with this accessible name; "" for none.
 */
function Stamp({ date, edited, silent = "", children }: { date: number; edited: string; silent?: string; children?: ReactNode }) {
	const { locale } = useI18n();
	return (
		<span className="stamp">
			{silent !== "" && <LabelledIcon name="bell-off" label={silent} className="silent-mark" />}
			{edited !== "" ? `${edited} ${clock(date, locale)}` : clock(date, locale)}
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
	const name = target.integrationLabel !== "" ? target.integrationLabel : nameOf(target.fromId);
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

/** The faces of a pill: up to 3 latest people who reacted, newest first, "+N" for the rest. */
function ReactorAvatars({ ids, more }: { ids: readonly number[]; more: number }) {
	const { self } = useServices();
	const nameOf = useNameOf(ids);
	return (
		<span className="r-avs" aria-hidden="true">
			{ids.map((id) => (
				// Your own avatar shows your initials, not "Bạn".
				<ChatAvatar key={id} id={id} name={id === self.id ? self.name : nameOf(id)} size="xs" />
			))}
			{more > 0 && <span className="r-n">+{more}</span>}
		</span>
	);
}

/**
 * One reaction pill (Zalo placement, mockups/chat.html#rich-messages): a
 * click toggles yours; right click, a long press or the menu keys list who
 * reacted. Private chats and small groups show faces, others the count.
 */
function ReactionChip({ message, reaction, chat }: { message: StoredMessage; reaction: ReactionCount; chat: Chat | null }) {
	const copy = useCopy();
	const { remote, toasts, self } = useServices();
	const ui = useUi();
	const { emoji, count, chosen } = reaction;
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	const content = pillContent(chat, reaction, isSavedChat(chat, peer));
	const faces = content.kind === "avatars" ? content.ids : [];
	const nameOf = useNameOf(faces);
	const trigger = useContextTrigger(() => ui.dialog.set({ kind: "reactors", chatId: message.chatId, seq: message.seq, emoji }), true);
	const label =
		content.kind === "avatars"
			? copy.message.reactionBy(
					emoji,
					faces.map((id) => (id === self.id ? copy.message.youInList : nameOf(id))),
					count,
				)
			: copy.message.reaction(emoji, count, chosen);
	return (
		<button
			type="button"
			className="reaction"
			aria-pressed={chosen}
			aria-label={label}
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
			<span className="r-emoji" aria-hidden="true">
				{emoji}
			</span>
			{content.kind === "avatars" ? (
				<ReactorAvatars ids={content.ids} more={content.more} />
			) : (
				<span className="r-n" aria-hidden="true">
					{count}
				</span>
			)}
		</button>
	);
}

/** The pill group floats over the bubble's bottom edge (yours: bottom-left, others': bottom-right). */
function Reactions({ message, chat }: { message: StoredMessage; chat: Chat | null }) {
	const copy = useCopy();
	if (message.reactions.length === 0) return null;
	return (
		<div className="reactions" role="group" aria-label={copy.message.reactions} title={copy.message.reactionsHint}>
			{message.reactions.map((reaction) => (
				<ReactionChip key={reaction.emoji} message={message} reaction={reaction} chat={chat} />
			))}
		</div>
	);
}

/** Buttons that show when the pointer is over a message (#context-menu); the keyboard has the menu. */
function QuickActions({
	chatId,
	itemKey,
	seq,
	seqs,
	label,
	canReply,
}: {
	chatId: number;
	itemKey: string;
	seq: number;
	/** Every message of an album, forwarded together. */
	seqs: readonly number[];
	label: string;
	canReply: boolean;
}) {
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
			<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.forward} onClick={() => ui.dialog.set({ kind: "forward", chatId, seq, seqs })}>
				<Icon name="forward" small />
			</button>
			<button type="button" className="qa" tabIndex={-1} aria-label={copy.message.more} onClick={() => ui.menu.set({ chatId, key: itemKey })}>
				<Icon name="dots" small />
			</button>
		</div>
	);
}

/** A button as shown: a bot callback or an allowed link. */
type ShownButton =
	| { readonly kind: "callback"; readonly text: string; readonly data: string; readonly key: string }
	| { readonly kind: "url"; readonly text: string; readonly url: string; readonly key: string };

/** Callback buttons waiting for the bot's answer ("chatId:seq:row:column"), across the screen. */
const pressing = new Cell<ReadonlySet<string>>(new Set());

function setPressing(key: string, on: boolean): void {
	const next = new Set(pressing.get());
	if (on) next.add(key);
	else next.delete(key);
	pressing.set(next);
}

/**
 * Buttons under a message (webhooks and bots), row by row. Only links the
 * scheme allowlist accepts are shown; links off the tenant's sites ask
 * before opening, like links in the text. A bot's callback button sends its
 * data to the bot (PressInlineButton) and shows the answer as a toast, or a
 * dialog when the bot asks for one; no answer in 10 seconds reads "Bot không
 * phản hồi".
 */
function MessageButtons({ message, ctx }: { message: StoredMessage; ctx: RichContext }) {
	const copy = useCopy();
	const ui = useUi();
	const { bots, toasts } = useServices();
	const waiting = useCell(pressing);
	const { chatId, seq, fromId } = message;
	const rows = message.buttons
		.map((row, rowIndex) =>
			row.flatMap((button, column): ShownButton[] => {
				if (button.callbackData !== undefined) return [{ kind: "callback", text: button.text, data: button.callbackData, key: `${chatId}:${seq}:${rowIndex}:${column}` }];
				if (button.url !== null && isAllowedLink(button.url)) return [{ kind: "url", text: button.text, url: button.url, key: `${rowIndex}:${column}` }];
				return [];
			}),
		)
		.filter((row) => row.length > 0);
	if (rows.length === 0) return null;
	const openLater = laterLinkOpener((url) => ctx.openLink(url));
	const press = (key: string, data: string) => {
		if (pressing.get().has(key)) return;
		setPressing(key, true);
		bots
			.press(chatId, seq, data)
			.then(
				(answer) => {
					if (answer.timedOut) {
						toasts.show(copy.bot.notResponding);
						return;
					}
					if (answer.text !== "") {
						if (answer.showAlert) ui.dialog.set({ kind: "botAlert", botId: fromId, text: answer.text });
						else toasts.show(answer.text);
					}
					if (answer.url !== "") openLater(answer.url);
				},
				() => toasts.show(copy.common.failed),
			)
			.finally(() => setPressing(key, false));
	};
	return (
		<div className="keyboard">
			{rows.map((row, rowIndex) => (
				<div className="kb-row" key={rowIndex}>
					{row.map((button) =>
						button.kind === "callback" ? (
							<button
								key={button.key}
								type="button"
								aria-busy={waiting.has(button.key)}
								onClick={() => press(button.key, button.data)}
							>
								<span>{button.text}</span>
								{waiting.has(button.key) && <span className="sr-only">{copy.bot.waiting}</span>}
							</button>
						) : (
							<a
								key={button.key}
								href={button.url}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(event) => {
									if (button.url.startsWith("mailto:")) return;
									event.preventDefault();
									ctx.openLink(button.url, button.text);
								}}
							>
								<span>{button.text}</span>
								<Icon name="external" small />
								<span className="sr-only">{copy.message.opensExternal}</span>
							</a>
						),
					)}
				</div>
			))}
		</div>
	);
}

function LinkPreviewCard({ preview, message, ctx }: { preview: LinkPreview; message: StoredMessage; ctx: RichContext }) {
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

interface BubbleProps {
	chatId: number;
	itemKey: string;
	/** Key of the list row (an album's first message); the item key otherwise. */
	rowKey?: string;
	/** Keys of an album's messages; empty for a single message. */
	albumKeys?: readonly string[];
	message: StoredMessage;
	chat: Chat | null;
	readOutboxMaxSeq: number;
	tabbable: boolean;
	/** Rendered again inside the message menu: no handlers, no focus. */
	inert?: boolean;
}

/** The media of a message or album, in its reserved box until the media chunk is there. */
function MediaSlot({ chatId, message, albumKeys }: { chatId: number; message: StoredMessage; albumKeys: readonly string[] }) {
	const { store } = useServices();
	if (albumKeys.length > 1) {
		const shapes = albumKeys.map((key) => {
			const item = store.item(chatId, key);
			return item?.kind === "message" ? item.message.media : undefined;
		});
		const visual = visualAlbum(shapes);
		return (
			<Suspense fallback={<MediaReserve shape={message.media ?? { kind: "document", width: 0, height: 0 }} count={albumKeys.length} visual={visual} />}>
				<AlbumMedia chatId={chatId} keys={albumKeys} visual={visual} />
			</Suspense>
		);
	}
	const media = message.media;
	if (media === undefined) return null;
	return (
		<Suspense fallback={<MediaReserve shape={media} count={1} visual={isVisual(media)} />}>
			<MessageMedia message={message} />
		</Suspense>
	);
}

export function MessageBubble({ chatId, itemKey, rowKey = itemKey, albumKeys = [], message, chat, readOutboxMaxSeq, tabbable, inert = false }: BubbleProps) {
	const copy = useCopy();
	const { store, self, backend } = useServices();
	const ui = useUi();
	const ctx = useRichContext(message.fromId);
	const intent = useIntent(chatId);
	const preview = backend.features.has("linkPreview") ? backend.linkPreview(message) : null;
	const integration = message.integrationLabel !== "";
	const alert = integration ? splitAlert(message.text, message.entities) : null;
	// With a preview card or buttons the time goes on its own line at the end (mock #rich-messages);
	// reactions float over the bubble's edge and take no line.
	const trailingStamp = !message.recalled && (preview !== null || message.buttons.length > 0);
	const trigger = useMenuTrigger(chatId, itemKey);
	const mine = message.fromId === store.selfId;
	const channel = chat?.type === "channel";
	const group = chat?.type === "group";
	const sender = useUser(mine || channel ? 0 : message.fromId);
	const senderName = integration ? message.integrationLabel : channel ? (chat?.title ?? "") : (sender?.name ?? copy.message.unknownUser);
	const tone = toneOf(message.fromId);
	const atMe = !mine && mentionsSelf(message.text, message.entities, self.id, self.username);
	const recalled = message.recalled;
	const unsupported = !recalled && message.text === "" && message.mediaKind === null;
	const album = albumKeys.length > 1;
	const hasMedia = message.media !== undefined || album;
	const seqs = album
		? albumKeys.flatMap((key) => {
				const item = store.item(chatId, key);
				return item?.kind === "message" ? [item.message.seq] : [];
			})
		: [message.seq];
	const read = mine && readOutboxMaxSeq >= message.seq;
	const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
	// A recalled message keeps its place only: nothing to reply to, react to or forward.
	const canReply = (!channel || admin) && !message.recalled;

	const editing = !inert && intent?.mode === "edit" && intent.seq === message.seq;
	const classes = ["msg", mine ? "mine" : "", channel ? "post" : "", atMe ? "at-me" : "", editing ? "editing" : ""].filter(Boolean).join(" ");
	const edited = message.editDate !== 0 && !recalled;
	// Alerts edited in place by their webhook read "đã cập nhật", not "đã sửa".
	const stamp = (
		<Stamp
			date={edited ? message.editDate : message.date}
			edited={edited ? (integration ? copy.message.updated : copy.message.edited) : ""}
			silent={message.silent && !recalled ? copy.message.silent : ""}
		>
			{mine && !channel && !recalled && !isSavedChat(chat, null) && (
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
			data-key={rowKey}
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
			{group && integration && (
				<span className={`avatar sm av-${integrationTone(message.integrationLabel)}`} aria-hidden="true">
					<Icon name="webhook" small />
				</span>
			)}
			{group && !mine && !integration && (
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
			{recalled ? (
				<div className="bubble recalled">
					{showSender && <span className={`who s-${tone}`}>{senderName}</span>}
					<p>
						{copy.message.recalled}
						{stamp}
					</p>
				</div>
			) : unsupported ? (
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
				<div className={integration ? `bubble integration${alert === null ? "" : ` ${alert.status}`}` : hasMedia ? "bubble media" : "bubble"}>
					{integration && (
						<span className="int-label">
							<Icon name="webhook" />
							{copy.message.integration(message.integrationLabel)}
						</span>
					)}
					{showSender && !integration && (
						<span className={`who s-${tone}`}>
							{senderName}
							{sender?.isBot === true && <span className="tag">{copy.bot.tag}</span>}
						</span>
					)}
					<ForwardLine message={message} />
					{message.replyToSeq !== 0 && <ReplyQuote chatId={chatId} seq={message.replyToSeq} />}
					{message.mediaKind !== null && !hasMedia && <p className="via">{copy.message.media}</p>}
					{hasMedia && <MediaSlot chatId={chatId} message={message} albumKeys={albumKeys} />}
					{alert === null ? (
						<RichText text={message.text} entities={message.entities} ctx={ctx} tail={trailingStamp ? undefined : stamp} />
					) : (
						<>
							<div className="int-title">
								<span className={`sev ${alert.status}`}>{alert.status === "firing" ? copy.message.alertFiring : copy.message.alertResolved}</span>
								<RichText
									text={alert.title.text}
									entities={alert.title.entities}
									ctx={ctx}
									tail={trailingStamp || alert.body.text !== "" ? undefined : stamp}
								/>
							</div>
							{alert.body.text !== "" && (
								<RichText text={alert.body.text} entities={alert.body.entities} ctx={ctx} tail={trailingStamp ? undefined : stamp} />
							)}
						</>
					)}
					<MessageButtons message={message} ctx={ctx} />
					{preview !== null && <LinkPreviewCard preview={preview} message={message} ctx={ctx} />}
					{trailingStamp && <p>{stamp}</p>}
					{!inert && (
						<QuickActions
							chatId={chatId}
							itemKey={itemKey}
							seq={message.seq}
							seqs={seqs}
							label={mine ? copy.message.quickActionsMine : copy.message.quickActions(senderName)}
							canReply={canReply}
						/>
					)}
					<Reactions message={message} chat={chat} />
				</div>
			)}
		</div>
	);
}

interface PendingProps {
	chatId: number;
	itemKey: string;
	/** Key of the list row (an album's first message); the item key otherwise. */
	rowKey?: string;
	/** Keys of an album being sent; empty for a single message. */
	albumKeys?: readonly string[];
	pending: PendingMessage;
	chat: Chat | null;
	tabbable: boolean;
	inert?: boolean;
}

function PendingMediaSlot({ chatId, pending, albumKeys }: { chatId: number; pending: PendingMessage; albumKeys: readonly string[] }) {
	const { store } = useServices();
	if (albumKeys.length > 1) {
		const shapes = albumKeys.map((key) => {
			const item = store.item(chatId, key);
			return item?.kind === "pending" ? item.pending.media : undefined;
		});
		const visual = visualAlbum(shapes);
		return (
			<Suspense fallback={<MediaReserve shape={pending.media ?? { kind: "document", width: 0, height: 0 }} count={albumKeys.length} visual={visual} />}>
				<PendingAlbumMedia chatId={chatId} keys={albumKeys} visual={visual} />
			</Suspense>
		);
	}
	const media = pending.media;
	if (media === undefined) return null;
	return (
		<Suspense fallback={<MediaReserve shape={media} count={1} visual={isVisual(media)} />}>
			<PendingMediaView pending={pending} />
		</Suspense>
	);
}

export function PendingBubble({ chatId, itemKey, rowKey = itemKey, albumKeys = [], pending, chat, tabbable, inert = false }: PendingProps) {
	const copy = useCopy();
	const { source, toasts, self } = useServices();
	// Media sends show their upload state (progress, cancel, retry) on the file itself.
	const hasMedia = pending.media !== undefined || albumKeys.length > 1;
	const connection = useConnection();
	const ctx = useRichContext(self.id);
	const trigger = useMenuTrigger(chatId, itemKey);
	const failed = pending.failure !== null;
	const waiting = connection === "offline" || connection === "waiting";
	const icon = failed ? "alert" : "clock";
	const label = failed ? copy.message.failed : waiting ? copy.message.queued : copy.message.sending;
	const stamp = (
		<Stamp date={pending.date} edited="">
			<LabelledIcon name={icon} label={label} className={failed ? "fail" : undefined} />
		</Stamp>
	);
	const bubble = (
		<div className={hasMedia ? "bubble media" : "bubble"}>
			{pending.replyToSeq !== 0 && <ReplyQuote chatId={chatId} seq={pending.replyToSeq} />}
			{hasMedia && <PendingMediaSlot chatId={chatId} pending={pending} albumKeys={albumKeys} />}
			<RichText text={pending.text} entities={pending.entities} ctx={ctx} tail={stamp} />
		</div>
	);
	return (
		<div
			className={chat?.type === "channel" ? "msg mine post" : "msg mine"}
			data-key={rowKey}
			tabIndex={inert ? undefined : tabbable ? 0 : -1}
			{...(inert ? {} : trigger)}
		>
			{failed && !hasMedia ? (
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

// One row of the chat list (mockups/chat.html#app, #list-states,
// #topic-states). Subscribes to its own dialog, list entry, draft and the
// people its preview names, so a new message re-renders this row only. Right
// click, a long press, the menu key or the "…" button that shows on hover
// opens the row menu (#list-menu).
import { memo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent } from "react";
import type { DialogView, Message } from "@app/core";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { MessagingCopy } from "../copy/vi.ts";
import { chatKind, countLabel, dialogTitle, inlineThumbUrl, isSavedChat, listTime, messagePreview, namedUserIds, type ChatKind } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { useDialog, useDraft, useListEntry, useServices, useTopics, useUserNames } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";
import { useTypingText } from "./typing.ts";
import { useUi } from "./ui-context.tsx";

const LONG_PRESS_MS = 500;

/** Row heights: fixed per kind so the list can position rows absolutely. */
export const ROW_HEIGHT = 64;
export const TWO_LINE_ROW_HEIGHT = 84;

const KIND_ICONS: Partial<Record<ChatKind, IconName>> = {
	group: "users",
	forum: "hash",
	channel: "megaphone",
	bot: "robot",
};

function kindLabel(kind: ChatKind, copy: MessagingCopy): string {
	switch (kind) {
		case "group":
			return copy.list.typeGroup;
		case "forum":
			return copy.list.typeForum;
		case "channel":
			return copy.list.typeChannel;
		case "bot":
			return copy.list.typeBot;
		case "private":
			return "";
	}
}

/**
 * Context menu on right click, long press or the menu keys (Menu, Shift+F10;
 * `own` also Enter, and only for keys pressed on the element itself, as on a
 * message). The tap that ends a long press does not also click.
 */
export function useContextTrigger(open: (x: number, y: number) => void, own = false) {
	const press = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; opened: boolean }>({ timer: undefined, opened: false });
	const cancel = () => clearTimeout(press.current.timer);
	return {
		onContextMenu: (event: MouseEvent<HTMLElement>) => {
			event.preventDefault();
			open(event.clientX, event.clientY);
		},
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
			if (own && event.target !== event.currentTarget) return;
			if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey) && !(own && event.key === "Enter")) return;
			event.preventDefault();
			const rect = event.currentTarget.getBoundingClientRect();
			open(rect.left + rect.width / 2, rect.bottom);
		},
		onTouchStart: (event: TouchEvent<HTMLElement>) => {
			const touch = event.touches[0];
			cancel();
			press.current.opened = false;
			press.current.timer = setTimeout(() => {
				press.current.opened = true;
				open(touch?.clientX ?? 0, touch?.clientY ?? 0);
			}, LONG_PRESS_MS);
		},
		onTouchEnd: cancel,
		onTouchMove: cancel,
		onClickCapture: (event: MouseEvent<HTMLElement>) => {
			if (!press.current.opened) return;
			press.current.opened = false;
			event.preventDefault();
		},
	};
}

/** Decorative-by-default icon with an accessible name (mock: svg role="img"). */
export function LabelledIcon({ name, label, className }: { name: IconName; label: string; className?: string | undefined }) {
	return (
		<span role="img" aria-label={label} className={className}>
			<Icon name={name} small />
		</span>
	);
}

function TopicsLine({ topics }: { topics: readonly Topic[] }) {
	const recent = topics
		.filter((topic) => !topic.hidden && topic.lastMessage !== null)
		.sort((a, b) => (b.lastMessage?.date ?? 0) - (a.lastMessage?.date ?? 0))
		.slice(0, 4);
	return (
		<span className="topics-line">
			{recent.map((topic, index) => (
				<span key={topic.id}>
					{index > 0 && " · "}
					{topic.unreadCount > 0 ? <b>{topic.title}</b> : topic.title}
				</span>
			))}
		</span>
	);
}

interface PreviewProps {
	view: DialogView;
	kind: ChatKind;
	/** The user's chat with themselves: every message is theirs, so no "Bạn:". */
	saved: boolean;
	draft: string;
	topics: readonly Topic[] | null;
}

/** Names for previews and system lines: "Bạn" for yourself, "Người dùng" while unknown. */
export function useNameOf(ids: readonly number[]): (userId: number) => string {
	const copy = useCopy();
	const { store } = useServices();
	const names = useUserNames(ids);
	return (userId: number) => (userId === store.selfId ? copy.common.you : names.get(userId) || copy.message.unknownUser);
}

/**
 * The small square picture before a photo or video preview (mockups/chat.html
 * #list-states .pv-thumb), from the message's inline thumbnail; null without
 * one. Its alt names the kind only when a caption follows (otherwise the
 * preview text already says "Ảnh" or "Video").
 */
export function PreviewThumb({ message }: { message: Message }) {
	const copy = useCopy();
	const media = message.media;
	if (message.recalled || message.action !== null || media === undefined || media.inlineThumb.length === 0) return null;
	if (message.mediaKind !== "photo" && message.mediaKind !== "video") return null;
	return (
		<img
			className="pv-thumb"
			src={inlineThumbUrl(media.inlineThumb)}
			alt={message.text === "" ? "" : copy.message.mediaKind[message.mediaKind]}
		/>
	);
}

function Preview({ view, kind, saved, draft, topics }: PreviewProps) {
	const copy = useCopy();
	const { store } = useServices();
	const top = view.topMessage;
	const nameOf = useNameOf(top === null ? [] : namedUserIds(top));
	const typing = useTypingText(view.dialog.chatId, kind === "group" || kind === "forum");
	let line: ReactNode;
	if (typing !== "") {
		line = <span className="typing-text">{typing}</span>;
	} else if (draft !== "") {
		line = (
			<>
				<span className="draft">{copy.list.draft}</span> {draft.replace(/\s+/g, " ")}
			</>
		);
	} else if (top === null) {
		line = saved ? copy.list.savedEmpty : copy.list.noMessages;
	} else {
		const text = messagePreview(top, nameOf, copy, kind === "channel");
		const showFrom = top.action === null && !saved && (kind === "group" || kind === "forum" || top.fromId === store.selfId);
		const from = top.integrationLabel !== "" ? top.integrationLabel : nameOf(top.fromId);
		line = (
			<>
				{showFrom && (
					<>
						<span className="from">{from}:</span>{" "}
					</>
				)}
				<PreviewThumb message={top} />
				{text}
			</>
		);
	}
	if (topics !== null) {
		return (
			<span className="preview two-line">
				<TopicsLine topics={topics} />
				<span>{line}</span>
			</span>
		);
	}
	return <span className="preview">{line}</span>;
}

interface ChatRowProps {
	chatId: number;
	current: boolean;
	style?: CSSProperties;
	position: number;
	total: number;
}

export const ChatRow = memo(function ChatRow({ chatId, current, style, position, total }: ChatRowProps) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const ui = useUi();
	const view = useDialog(chatId);
	const entry = useListEntry(chatId);
	const draft = useDraft(chatId);
	const topics = useTopics(chatId, view?.chat?.forum === true);
	const trigger = useContextTrigger((x, y) => ui.listMenu.set({ chatId, x, y }));
	if (view === undefined) return null;
	const kind = chatKind(view.chat, view.peer, view.chat?.forum === true);
	const title = dialogTitle(view, copy);
	const saved = isSavedChat(view.chat, view.peer);
	const { dialog } = view;
	const top = view.topMessage;
	const muted = entry?.muted === true;
	const pinned = entry?.pinned === true;
	// Marked as unread with nothing unread: a dot instead of a count (#list-states).
	const marked = entry?.unread === true && dialog.unreadCount === 0 && dialog.unreadMentionsCount === 0;
	const ownLast = top !== null && top.fromId === store.selfId && top.action === null && !saved;
	const read = ownLast && dialog.readOutboxMaxSeq >= top.seq;
	const kindIcon = KIND_ICONS[kind];
	// The server counts the whole chat (every topic), up to 1000.
	const unread = dialog.unreadCount;
	return (
		<li className="chat-slot" style={style} aria-setsize={total} aria-posinset={position} {...trigger}>
			<Link to={paths.chat(chatId)} className="chat-row" current={current}>
				<ChatAvatar
					id={chatId}
					name={title}
					bot={kind === "bot"}
					saved={saved}
					photoOf={kind === "bot" ? (view.peer?.id ?? 0) : 0}
					photoId={view.peer?.photoId ?? ""}
				/>
				<span className="tx">
					<span className="name">
						{kindIcon !== undefined && (
							<LabelledIcon name={kindIcon} label={kindLabel(kind, copy)} className="type-ico" />
						)}
						<span className="title-text">{title}</span>
						{muted && <LabelledIcon name="bell-off" label={copy.list.muted} />}
					</span>
					<Preview view={view} kind={kind} saved={saved} draft={draft} topics={topics} />
				</span>
				<span className="meta">
					<span className="line">
						{pinned && <LabelledIcon name="pin" label={copy.list.pinned} />}
						{ownLast && <LabelledIcon name={read ? "checks" : "check"} label={read ? copy.list.read : copy.list.sent} className={read ? "read" : undefined} />}
						{top !== null && listTime(top.date, new Date(), locale, copy)}
					</span>
					{(unread > 0 || dialog.unreadMentionsCount > 0 || marked) && (
						<span className="line">
							{dialog.unreadMentionsCount > 0 && (
								<span className="badge at" role="img" aria-label={copy.list.mention}>
									@
								</span>
							)}
							{unread > 0 &&
								(muted ? (
									<span className="badge muted-badge" role="img" aria-label={copy.list.unreadMuted(unread)}>
										{countLabel(unread)}
									</span>
								) : (
									<span className="badge">{countLabel(unread)}</span>
								))}
							{marked && <span className={muted ? "badge dot muted-badge" : "badge dot"} role="img" aria-label={copy.list.markedUnread} />}
						</span>
					)}
				</span>
			</Link>
			<button
				type="button"
				className="row-more"
				aria-label={copy.list.rowActions(title)}
				aria-haspopup="menu"
				onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					ui.listMenu.set({ chatId, x: rect.left, y: rect.bottom });
				}}
			>
				<Icon name="dots" small />
			</button>
		</li>
	);
});

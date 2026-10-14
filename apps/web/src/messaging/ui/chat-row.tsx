// One row of the chat list (mockups/chat.html#app, #list-states,
// #topic-states). Subscribes to its own dialog, draft and sender, so a new
// message re-renders this row only.
import { memo, type CSSProperties, type ReactNode } from "react";
import type { DialogView } from "@app/core";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { MessagingCopy } from "../copy/vi.ts";
import { chatKind, dialogTitle, listTime, messagePreview, userName, type ChatKind } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { useDialog, useDraft, useServices, useTopics, useUser } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";

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
	draft: string;
	topics: readonly Topic[] | null;
}

function Preview({ view, kind, draft, topics }: PreviewProps) {
	const copy = useCopy();
	const { store } = useServices();
	const top = view.topMessage;
	const sender = useUser(top !== null && top.fromId !== store.selfId ? top.fromId : 0);
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	let line: ReactNode;
	if (draft !== "") {
		line = (
			<>
				<span className="draft">{copy.list.draft}</span> {draft.replace(/\s+/g, " ")}
			</>
		);
	} else if (top === null) {
		line = copy.list.noMessages;
	} else {
		const text = messagePreview(top, nameOf, copy);
		const showFrom = top.action === null && (kind === "group" || kind === "forum" || top.fromId === store.selfId);
		const from = top.fromId === store.selfId ? copy.common.you : (sender?.name ?? copy.message.unknownUser);
		line = showFrom ? (
			<>
				<span className="from">{from}:</span> {text}
			</>
		) : (
			text
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
	const { store, backend } = useServices();
	const view = useDialog(chatId);
	const draft = useDraft(chatId);
	const topics = useTopics(chatId, view?.chat?.forum === true);
	if (view === undefined) return null;
	const kind = chatKind(view.chat, view.peer, view.chat?.forum === true);
	const title = dialogTitle(view, copy);
	const { dialog } = view;
	const top = view.topMessage;
	const muted = backend.isMuted(chatId);
	const pinned = backend.isPinnedDialog(chatId);
	const ownLast = top !== null && top.fromId === store.selfId && top.action === null;
	const read = ownLast && dialog.readOutboxMaxSeq >= top.seq;
	const kindIcon = KIND_ICONS[kind];
	const unread = topics !== null ? topics.filter((t) => !t.muted).reduce((sum, t) => sum + t.unreadCount, 0) : dialog.unreadCount;
	return (
		<li className="chat-slot" style={style} aria-setsize={total} aria-posinset={position}>
			<Link to={paths.chat(chatId)} className="chat-row" current={current}>
				<ChatAvatar id={chatId} name={title} bot={kind === "bot"} />
				<span className="tx">
					<span className="name">
						{kindIcon !== undefined && (
							<LabelledIcon name={kindIcon} label={kindLabel(kind, copy)} className="type-ico" />
						)}
						<span className="title-text">{title}</span>
						{muted && <LabelledIcon name="bell-off" label={copy.list.muted} />}
					</span>
					<Preview view={view} kind={kind} draft={draft} topics={topics} />
				</span>
				<span className="meta">
					<span className="line">
						{pinned && <LabelledIcon name="pin" label={copy.list.pinned} />}
						{ownLast && <LabelledIcon name={read ? "checks" : "check"} label={read ? copy.list.read : copy.list.sent} className={read ? "read" : undefined} />}
						{top !== null && listTime(top.date, new Date(), locale, copy)}
					</span>
					{(unread > 0 || dialog.unreadMentionsCount > 0) && (
						<span className="line">
							{dialog.unreadMentionsCount > 0 && (
								<span className="badge at" role="img" aria-label={copy.list.mention}>
									@
								</span>
							)}
							{unread > 0 && <span className={muted ? "badge muted-badge" : "badge"}>{unread}</span>}
						</span>
					)}
				</span>
			</Link>
		</li>
	);
});

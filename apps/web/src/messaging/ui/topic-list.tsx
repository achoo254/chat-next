// Topic list of a group with topics (mockups/chat.html#topics,
// #topic-states). It replaces the chat list while the group is open; the
// back arrow returns to the chats. Admins pin, close and hide topics from the
// row menu and see hidden topics in their own section. The server pages the
// topics: the next page loads when the end of the list scrolls into view.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Chat } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { countLabel, listTime, shortDate } from "../data/format.ts";
import type { Topic, TopicChange } from "../data/pending-backend.ts";
import { useBackendValue, useServices, useUser } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { LabelledIcon } from "./chat-row.tsx";
import { ChatAvatar } from "./parts.tsx";
import { PopupMenu } from "./popup-menu.tsx";
import { sortTopics, TopicIco } from "./topic-ico.tsx";

function TopicPreview({ topic }: { topic: Topic }) {
	const copy = useCopy();
	const { store } = useServices();
	const last = topic.lastMessage;
	const author = useUser(last !== null && last.fromId !== store.selfId ? last.fromId : 0);
	if (last === null) return <span className="preview">{copy.list.noMessages}</span>;
	const name = last.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser);
	return (
		<span className="preview">
			<span className="from">{name}:</span> {last.text}
		</span>
	);
}

interface TopicMenuProps {
	topic: Topic;
	onAction: (change: TopicChange, done: string) => void;
	onClose: () => void;
}

function TopicMenu({ topic, onAction, onClose }: TopicMenuProps) {
	const copy = useCopy();
	return (
		<PopupMenu className="topic-menu" label={copy.topics.menu(topic.title)} onClose={onClose}>
			<button type="button" role="menuitem" onClick={() => onAction({ pinned: !topic.pinned }, copy.topics.pinnedDone)}>
				<Icon name="pin" />
				{topic.pinned ? copy.topics.unpin : copy.topics.pin}
			</button>
			{!topic.general && (
				<button
					type="button"
					role="menuitem"
					onClick={() =>
						onAction({ closed: !topic.closed }, topic.closed ? copy.topics.reopenedDone(topic.title) : copy.topics.closedDone)
					}
				>
					<Icon name="lock" />
					{topic.closed ? copy.topics.reopenTopic : copy.topics.close}
				</button>
			)}
			{!topic.general && (
				<button type="button" role="menuitem" onClick={() => onAction({ hidden: true }, copy.topics.hiddenDone)}>
					<Icon name="eye-off" />
					{copy.topics.hide}
				</button>
			)}
		</PopupMenu>
	);
}

interface TopicListProps {
	chat: Chat;
	title: string;
	topics: readonly Topic[];
	currentTopicId: number;
}

/** "Tải thêm chủ đề", also pressed for you when it scrolls into view. */
function MoreTopics({ chatId }: { chatId: number }) {
	const copy = useScreensCopy();
	const { backend } = useServices();
	const ref = useRef<HTMLButtonElement>(null);
	const more = useBackendValue((pending) => pending.hasMoreTopics(chatId));
	useEffect(() => {
		const element = ref.current;
		if (!more || element === null || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) backend.loadMoreTopics(chatId);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [backend, chatId, more]);
	if (!more) return null;
	return (
		<button ref={ref} type="button" className="see-all more-topics" onClick={() => backend.loadMoreTopics(chatId)}>
			{copy.topicList.more}
		</button>
	);
}

export function TopicListColumn({ chat, title, topics, currentTopicId }: TopicListProps) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { backend, toasts } = useServices();
	const [menuFor, setMenuFor] = useState(0);
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const sorted = sortTopics(topics);
	const visible = sorted.filter((topic) => !topic.hidden);
	const hidden = sorted.filter((topic) => topic.hidden);
	const nameOf = useNameOf(hidden.map((topic) => topic.changedBy));

	const change = (topic: Topic, update: TopicChange, done: string) => {
		setMenuFor(0);
		backend.setTopic(chat.id, topic.id, update).then(
			() => toasts.show(done),
			() => toasts.show(copy.common.failed),
		);
	};
	const openMenu = (topic: Topic) => (event: MouseEvent | KeyboardEvent) => {
		if (!admin) return;
		if ("key" in event && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		event.preventDefault();
		setMenuFor(topic.id);
	};

	return (
		<section className="list" aria-label={copy.topics.list(title)}>
			<div className="topic-head">
				<Link to={paths.home} className="icon-btn" aria-label={copy.topics.backToChats}>
					<Icon name="back" />
				</Link>
				<ChatAvatar id={chat.id} name={title} size="sm" />
				<div className="title">
					<strong>{title}</strong>
					<span>{copy.convo.members(chat.memberCount)}</span>
				</div>
			</div>
			<div className="chats topic-scroll">
				<ul className="topic-rows" aria-label={copy.topics.topicsLabel}>
					{visible.map((topic) => (
						<li key={topic.id}>
							<button
								type="button"
								className={topic.closed ? "chat-row topic-row closed" : "chat-row topic-row"}
								aria-current={topic.id === currentTopicId ? "true" : undefined}
								onClick={() => navigate(paths.topic(chat.id, topic.id))}
								onContextMenu={openMenu(topic)}
								onKeyDown={openMenu(topic)}
							>
								<TopicIco topic={topic} />
								<span className="tx">
									<span className="name">
										<span className="title-text">{topic.title}</span>
										{topic.closed && <LabelledIcon name="lock" label={copy.topics.closed} />}
										{topic.muted && <LabelledIcon name="bell-off" label={copy.list.muted} />}
									</span>
									<TopicPreview topic={topic} />
								</span>
								<span className="meta">
									<span className="line">
										{topic.pinned && <LabelledIcon name="pin" label={copy.list.pinned} />}
										{topic.lastMessage !== null && listTime(topic.lastMessage.date, new Date(), locale, copy)}
									</span>
									{(topic.unreadCount > 0 || topic.unreadMentions > 0) && (
										<span className="line">
											{topic.unreadMentions > 0 && (
												<span className="badge at" role="img" aria-label={copy.list.mention}>
													@
												</span>
											)}
											{topic.unreadCount > 0 && (
												<span className={topic.muted ? "badge muted-badge" : "badge"}>{countLabel(topic.unreadCount)}</span>
											)}
										</span>
									)}
								</span>
							</button>
							{menuFor === topic.id && (
								<TopicMenu topic={topic} onAction={(update, done) => change(topic, update, done)} onClose={() => setMenuFor(0)} />
							)}
						</li>
					))}
				</ul>
				<MoreTopics chatId={chat.id} />
				{admin && hidden.length > 0 && (
					<details className="hidden-topics">
						<summary>
							<Icon name="eye-off" small />
							{copy.topics.hiddenSummary(hidden.length)}
						</summary>
						<ul className="topic-rows">
							{hidden.map((topic) => (
								<li key={topic.id} className="chat-row">
									<TopicIco topic={{ ...topic, tone: "grey" }} />
									<span className="tx">
										<span className="name">
											<span className="title-text">{topic.title}</span>
										</span>
										{topic.changedBy !== 0 && (
											<span className="preview">
												{copy.topics.hiddenBy(nameOf(topic.changedBy), shortDate(topic.changedAt, locale))}
											</span>
										)}
									</span>
									<span className="meta">
										<button type="button" className="btn btn-sm" onClick={() => change(topic, { hidden: false }, copy.topics.shownDone(topic.title))}>
											{copy.topics.show}
										</button>
									</span>
								</li>
							))}
						</ul>
						<p className="note">
							<Icon name="search" small />
							<span>{copy.topics.hiddenNote}</span>
						</p>
					</details>
				)}
			</div>
		</section>
	);
}

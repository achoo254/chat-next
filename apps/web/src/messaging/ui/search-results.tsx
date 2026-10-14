// Search from the chat list (mockups/search.html#global), opened by
// ⌘/Ctrl+K or ⌘/Ctrl+F: results grouped the way people look for things —
// Liên hệ (contacts, private chats, bots, then people the server finds by
// username when they allow it) · Nhóm và kênh · Tin nhắn (the core's local
// full-text search) — with the words highlighted. Typing without accents
// still matches accented text.
import { fold, type StoredMessage } from "@app/core";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { dialogTitle, listTime } from "../data/format.ts";
import { highlight } from "../data/highlight.ts";
import type { Person } from "../data/remote.ts";
import { useDialog, useDialogOrder, useServices, useUser } from "../data/services.tsx";
import { ChatAvatar } from "./parts.tsx";
import { usePeopleSearch } from "./people-search.ts";
import { presenceText } from "./presence.tsx";

const SEARCH_DELAY_MS = 80;
const MESSAGE_LIMIT = 50;

/** The text with the query's words marked; plain runs stay text so names read as one string. */
function Marked({ text, query }: { text: string; query: string }) {
	return (
		<>
			{highlight(text, query).map((segment, index) => (segment.match ? <mark key={index}>{segment.text}</mark> : <Fragment key={index}>{segment.text}</Fragment>))}
		</>
	);
}

/** Every word of the query appears in `text` (accents and đ ignored). */
function matchesAll(text: string, words: readonly string[]): boolean {
	const folded = fold(text);
	return words.every((word) => folded.includes(word));
}

interface PersonHit {
	readonly id: number;
	readonly name: string;
	readonly sub: string;
	readonly isBot: boolean;
	/** The private chat with them, 0 when there is none yet. */
	readonly chatId: number;
}

interface ChatHit {
	readonly id: number;
	readonly title: string;
	readonly sub: string;
}

function personSub(person: Person, contact: boolean, copy: FullCopy, locale: string): string {
	if (person.isBot) return copy.info.botLine(person.username);
	if (contact) return `${copy.search.inContacts} · ${presenceText(person.presence, copy, locale)}`;
	return person.username === "" ? "" : `@${person.username}`;
}

export default function SearchResults({ query, onOpen }: { query: string; onOpen: () => void }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { source, store, remote, toasts } = useServices();
	const contacts = useContacts(remote);
	const order = useDialogOrder();
	const server = usePeopleSearch(query);
	const [result, setResult] = useState<{ query: string; hits: StoredMessage[] } | null>(null);
	const words = useMemo(() => fold(query).split(/\s+/).filter((word) => word !== ""), [query]);

	useEffect(() => {
		let active = true;
		const timer = setTimeout(() => {
			source.search(query, { limit: MESSAGE_LIMIT }).then(
				(hits) => {
					if (active) setResult({ query, hits });
				},
				() => {
					if (active) setResult({ query, hits: [] });
				},
			);
		}, SEARCH_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [source, query]);

	const { people, chats } = useMemo(() => {
		const peopleById = new Map<number, PersonHit>();
		const chatHits: ChatHit[] = [];
		const privateChats = new Map<number, number>();
		for (const chatId of order) {
			const view = store.dialog(chatId);
			if (view === undefined) continue;
			const chat = view.chat;
			if (chat?.type === "private" && view.peer !== null) privateChats.set(view.peer.id, chatId);
			if (chat?.type === "group" || chat?.type === "channel") {
				if (!matchesAll(chat.title, words)) continue;
				chatHits.push({
					id: chatId,
					title: chat.title,
					sub: chat.type === "channel" ? copy.info.channel(chat.memberCount) : copy.forward.groupMembers(chat.memberCount),
				});
			}
		}
		for (const { person } of contacts.entries) {
			if (!matchesAll(`${person.name} ${person.username}`, words)) continue;
			peopleById.set(person.id, { id: person.id, name: person.name, sub: personSub(person, true, copy, locale), isBot: person.isBot, chatId: privateChats.get(person.id) ?? 0 });
		}
		for (const chatId of order) {
			const peer = store.dialog(chatId)?.peer;
			if (peer == null || peer.isSelf || peopleById.has(peer.id) || !matchesAll(`${peer.name} ${peer.username}`, words)) continue;
			peopleById.set(peer.id, {
				id: peer.id,
				name: peer.name,
				sub: peer.isBot ? copy.info.botLine(peer.username) : copy.search.privateChat,
				isBot: peer.isBot,
				chatId,
			});
		}
		for (const person of server.people ?? []) {
			if (peopleById.has(person.id)) continue;
			peopleById.set(person.id, { id: person.id, name: person.name, sub: personSub(person, false, copy, locale), isBot: person.isBot, chatId: privateChats.get(person.id) ?? 0 });
		}
		return { people: [...peopleById.values()], chats: chatHits };
	}, [order, store, contacts, server.people, words, copy, locale]);

	const openChat = (chatId: number) => {
		onOpen();
		navigate(paths.chat(chatId));
	};
	const openPerson = (hit: PersonHit) => {
		if (hit.chatId !== 0) {
			openChat(hit.chatId);
			return;
		}
		remote.createPrivate(hit.id).then(openChat, () => toasts.show(copy.common.failed));
	};
	const openMessage = (message: StoredMessage) => {
		store.openWindow(message.chatId, message.seq);
		openChat(message.chatId);
	};

	const messages = result?.query === query ? result.hits : [];
	const settled = result?.query === query && server.people !== null;
	const sections: ReactNode[] = [];
	if (people.length > 0) {
		sections.push(
			<section key="people" aria-labelledby="sx-people">
				<h3 className="sec-h" id="sx-people">
					{copy.search.people} <span>{copy.search.peopleHint}</span>
				</h3>
				<ul className="hits">
					{people.map((hit) => (
						<li key={hit.id}>
							<button type="button" className="hit" onClick={() => openPerson(hit)}>
								<ChatAvatar id={hit.id} name={hit.name} bot={hit.isBot} />
								<span className="hit-main">
									<span className="hit-head">
										<b>
											<Marked text={hit.name} query={query} />
										</b>
									</span>
									{hit.sub !== "" && <span className="hit-sub">{hit.sub}</span>}
								</span>
							</button>
						</li>
					))}
				</ul>
			</section>,
		);
	}
	if (chats.length > 0) {
		sections.push(
			<section key="chats" aria-labelledby="sx-chats">
				<h3 className="sec-h" id="sx-chats">
					{copy.search.chats}
				</h3>
				<ul className="hits">
					{chats.map((hit) => (
						<li key={hit.id}>
							<button type="button" className="hit" onClick={() => openChat(hit.id)}>
								<ChatAvatar id={hit.id} name={hit.title} />
								<span className="hit-main">
									<span className="hit-head">
										<b>
											<Marked text={hit.title} query={query} />
										</b>
									</span>
									<span className="hit-sub">{hit.sub}</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			</section>,
		);
	}
	if (messages.length > 0) {
		sections.push(
			<section key="messages" aria-labelledby="sx-messages">
				<h3 className="sec-h" id="sx-messages">
					{copy.search.messages} <span>{copy.search.messageCount(messages.length)}</span>
				</h3>
				<ul className="hits" aria-label={copy.search.results}>
					{messages.map((message) => (
						<MessageHit key={`${message.chatId}:${message.seq}`} message={message} query={query} onOpen={openMessage} locale={locale} />
					))}
				</ul>
			</section>,
		);
	}

	return (
		<div className="search-panel" aria-busy={!settled}>
			<div className="search-note">{copy.search.note}</div>
			<div className="sx-results" aria-label={copy.search.label} role="region">
				{sections.length > 0
					? sections
					: settled && (
							<div className="empty">
								<Icon name="search" />
								<strong>{copy.search.emptyTitle}</strong>
								<span>{copy.search.emptyBody}</span>
							</div>
						)}
			</div>
		</div>
	);
}

function MessageHit({ message, query, onOpen, locale }: { message: StoredMessage; query: string; onOpen: (message: StoredMessage) => void; locale: string }) {
	const copy = useScreensCopy();
	const { store } = useServices();
	const view = useDialog(message.chatId);
	const author = useUser(message.fromId === store.selfId ? 0 : message.fromId);
	const title = view === undefined ? "" : dialogTitle(view, copy);
	const group = view?.chat?.type === "group";
	const sender = message.fromId === store.selfId ? copy.common.you : (author?.name ?? "");
	return (
		<li>
			<button type="button" className="hit" onClick={() => onOpen(message)}>
				<ChatAvatar id={message.chatId} name={title} size="sm" />
				<span className="hit-main">
					<span className="hit-head">
						<b>{title}</b>
						<span>{listTime(message.date, new Date(), locale, copy)}</span>
					</span>
					<span className="hit-text">
						{group && sender !== "" && <b>{sender}: </b>}
						<Marked text={message.text} query={query} />
					</span>
				</span>
			</button>
		</li>
	);
}

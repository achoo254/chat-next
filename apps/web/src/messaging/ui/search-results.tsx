// Search from the chat list (mockups/search.html#global), opened by
// ⌘/Ctrl+K or ⌘/Ctrl+F: results grouped the way people look for things —
// Liên hệ (contacts, private chats, bots, then people the server finds by
// username when they allow it) · Nhóm và kênh · Tin nhắn — with the words
// highlighted. Typing without accents still matches accented text. Messages
// found on this device show at once; the server's are merged in after a
// pause in typing without moving the rows already shown (#filters for the
// sender, type and date filters, #empty-error for offline and failures).
// ↑/↓ in the search box move between results, Enter opens one.
import { fold, type SearchHit, type StoredMessage } from "@achoo254/chat-core";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { dialogTitle, listTime } from "../data/format.ts";
import { highlight } from "../data/highlight.ts";
import type { Person } from "../data/remote.ts";
import { useChat, useDialog, useDialogOrder, useServices, useUser } from "../data/services.tsx";
import { formatBytes } from "../media/media-format.ts";
import { anyFilter, NO_FILTERS, startOfDay, toSearchFilters, type UiFilters } from "../search/filters.ts";
import { FilterBar, useSenderName } from "../search/search-filters.tsx";
import { useMessageSearch } from "../search/use-message-search.ts";
import { ChatAvatar } from "./parts.tsx";
import { usePeopleSearch } from "./people-search.ts";
import { presenceText } from "./presence.tsx";
import "../search/search.css";
import { usePrivateChatFailure } from "./private-chat-failure.ts";

/** Load the next server page when the list is scrolled this close to its end. */
const MORE_THRESHOLD_PX = 160;

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

interface SearchResultsProps {
	query: string;
	onOpen: () => void;
	/** The search box: ↑/↓ and Enter in it move through and open the results. */
	inputRef?: RefObject<HTMLInputElement | null>;
}

export default function SearchResults({ query, onOpen, inputRef }: SearchResultsProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store, remote } = useServices();
	const contacts = useContacts(remote);
	const order = useDialogOrder();
	const server = usePeopleSearch(query);
	const [filters, setFilters] = useState<UiFilters>(NO_FILTERS);
	const [today] = useState(() => startOfDay(Date.now()));
	const filtered = anyFilter(filters);
	const search = useMessageSearch({ text: query, chatId: 0, topicId: 0, filters: toSearchFilters(filters) });
	const { state } = search;
	const words = useMemo(() => fold(query).split(/\s+/).filter((word) => word !== ""), [query]);
	const resultsRef = useRef<HTMLDivElement>(null);
	// The result chosen with ↑/↓, for this query and these filters only.
	const listKey = `${query}|${JSON.stringify(filters)}`;
	const [cursor, setCursor] = useState({ key: "", index: -1 });
	const active = cursor.key === listKey ? cursor.index : -1;

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
	const privateChatFailed = usePrivateChatFailure();
	const openPerson = (hit: PersonHit) => {
		if (hit.chatId !== 0) {
			openChat(hit.chatId);
			return;
		}
		remote.createPrivate(hit.id).then(openChat, (err: unknown) => privateChatFailed(err, hit.id));
	};
	const openMessage = (message: StoredMessage) => {
		store.openWindow(message.chatId, message.seq);
		openChat(message.chatId);
	};

	// ↑/↓ and Enter in the search box: the result buttons in screen order.
	useEffect(() => {
		const input = inputRef?.current;
		if (input == null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
			const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button.hit") ?? [])];
			if (buttons.length === 0) return;
			event.preventDefault();
			const current = buttons.findIndex((button) => button.getAttribute("aria-current") === "true");
			if (event.key === "Enter") {
				buttons[Math.max(0, current)]?.click();
				return;
			}
			const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current - 1);
			setCursor({ key: listKey, index: next });
			const button = buttons[next];
			// Not in every DOM (jsdom).
			if (button !== undefined && typeof button.scrollIntoView === "function") button.scrollIntoView({ block: "nearest" });
		};
		input.addEventListener("keydown", onKey);
		return () => input.removeEventListener("keydown", onKey);
	}, [inputRef, listKey]);
	useEffect(() => {
		const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button.hit") ?? [])];
		buttons.forEach((button, index) => {
			if (index === active) button.setAttribute("aria-current", "true");
			else button.removeAttribute("aria-current");
		});
	});

	const onScroll = () => {
		const box = resultsRef.current;
		if (box !== null && box.scrollHeight - box.scrollTop - box.clientHeight < MORE_THRESHOLD_PX) search.more();
	};

	const messages = state.hits;
	const settled = state.localReady && state.server !== "waiting" && state.server !== "loading" && (filtered || server.people !== null);
	const sections: ReactNode[] = [];
	if (!filtered && people.length > 0) {
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
	if (!filtered && chats.length > 0) {
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
					{messages.map((hit) => (
						<MessageHit key={`${hit.message.chatId}:${hit.message.seq}`} hit={hit} query={query} fileRow={filters.type === "document"} onOpen={openMessage} locale={locale} />
					))}
				</ul>
				{state.hasMore && (
					<button type="button" className="btn btn-sm sx-more" disabled={state.loadingMore} onClick={() => search.more()}>
						{state.loadingMore ? copy.search.loadingMore : copy.search.loadMore}
					</button>
				)}
			</section>,
		);
	}

	return (
		<div className="search-panel" aria-busy={!settled}>
			<FilterBar filters={filters} onChange={setFilters} today={today} />
			<SearchStatus state={state.server} count={messages.length} onRetry={search.retry} />
			<div className="sx-results" aria-label={copy.search.label} role="region" ref={resultsRef} onScroll={onScroll}>
				{sections.length > 0
					? sections
					: settled && (
							<EmptyResults
								query={query}
								filters={filters}
								onFilters={setFilters}
								localOnly={state.server === "offline" || state.server === "failed"}
							/>
						)}
			</div>
			{state.server === "offline" && <p className="foot-note">{copy.search.offlineNote}</p>}
			{state.server === "failed" && <p className="foot-note">{copy.search.failedNote}</p>}
		</div>
	);
}

/** The line under the filters (#global states): local first, then merged; offline and failures as banners. */
export function SearchStatus({ state, count, onRetry }: { state: string; count: number; onRetry: () => void }) {
	const copy = useScreensCopy();
	switch (state) {
		case "waiting":
		case "loading":
			return (
				<div className="sx-status" role="status">
					<span className="spin" aria-hidden="true" />
					{copy.search.localLoading}
				</div>
			);
		case "done":
			return (
				<div className="sx-status" role="status">
					<Icon name="check" small />
					{copy.search.merged(count)}
				</div>
			);
		case "offline":
			return (
				<div className="banner warn" role="status">
					<Icon name="wifi-off" small />
					<span>{copy.search.offline}</span>
				</div>
			);
		case "failed":
			return (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.search.failed}</span>
					<button type="button" className="btn btn-sm" onClick={onRetry}>
						{copy.search.retry}
					</button>
				</div>
			);
		default:
			return null;
	}
}

/** "Không có kết quả cho …": tips, and a way out of the filters in use. */
function EmptyResults({
	query,
	filters,
	onFilters,
	localOnly,
}: {
	query: string;
	filters: UiFilters;
	onFilters: (filters: UiFilters) => void;
	/** The server could not be asked: only the device was searched. */
	localOnly: boolean;
}) {
	const copy = useScreensCopy();
	const sender = useSenderName(filters.fromId);
	let clear: { label: string; next: UiFilters } | null = null;
	if (filters.fromId !== 0 && filters.type === null && filters.fromDay === 0) clear = { label: copy.search.removeSender(sender), next: { ...filters, fromId: 0 } };
	else if (filters.fromId === 0 && filters.type !== null && filters.fromDay === 0)
		clear = { label: copy.search.removeType(copy.search.types[filters.type]), next: { ...filters, type: null } };
	else if (filters.fromId === 0 && filters.type === null && filters.fromDay !== 0) clear = { label: copy.search.removeDate, next: { ...filters, fromDay: 0, toDay: 0 } };
	else if (anyFilter(filters)) clear = { label: copy.search.clearFilters, next: NO_FILTERS };
	return (
		<div className="empty">
			<Icon name="search" />
			<strong>{localOnly ? copy.search.emptyLocalFor(query) : copy.search.emptyFor(query)}</strong>
			{!localOnly && (
				<ul className="tips">
					<li>{copy.search.tipSpelling}</li>
					<li>{copy.search.tipHistory}</li>
				</ul>
			)}
			{clear !== null && (
				<button type="button" className="btn" onClick={() => onFilters(clear.next)}>
					{clear.label}
				</button>
			)}
		</div>
	);
}

interface MessageHitProps {
	hit: SearchHit;
	query: string;
	/** Files filter: the file name leads, as in #filters. */
	fileRow: boolean;
	onOpen: (message: StoredMessage) => void;
	locale: string;
}

function MessageHit({ hit, query, fileRow, onOpen, locale }: MessageHitProps) {
	const copy = useScreensCopy();
	const { store } = useServices();
	const { message } = hit;
	const view = useDialog(message.chatId);
	const chat = useChat(view === undefined ? message.chatId : 0);
	const peer = useUser(view === undefined && chat?.type === "private" ? chat.peerUserId : 0);
	const author = useUser(message.fromId === store.selfId ? 0 : message.fromId);
	const title = view !== undefined ? dialogTitle(view, copy) : chat == null ? "" : dialogTitle({ chat, peer: peer ?? null }, copy);
	const group = (view?.chat ?? chat)?.type === "group";
	const sender = message.fromId === store.selfId ? copy.common.you : message.integrationLabel !== "" ? message.integrationLabel : (author?.name ?? "");
	const fileName = message.media?.fileName ?? "";
	const fromServer = hit.source === "server" ? <span className="from-server">{copy.search.fromServer}</span> : null;
	if (fileRow && fileName !== "") {
		const size = message.media === undefined ? "" : formatBytes(message.media.size, locale);
		return (
			<li>
				<button type="button" className={hit.source === "server" ? "hit arrived" : "hit"} onClick={() => onOpen(message)}>
					<span className="device">
						<Icon name="file" />
					</span>
					<span className="hit-main">
						<span className="hit-head">
							<b className="mono-name">
								<Marked text={fileName} query={query} />
							</b>
							<span>{listTime(message.date, new Date(), locale, copy)}</span>
						</span>
						<span className="hit-sub">
							{[size, sender, title].filter((part) => part !== "").join(" · ")} {fromServer}
						</span>
					</span>
				</button>
			</li>
		);
	}
	const text = message.text !== "" ? message.text : fileName;
	return (
		<li>
			<button type="button" className={hit.source === "server" ? "hit arrived" : "hit"} onClick={() => onOpen(message)}>
				<ChatAvatar id={message.chatId} name={title} size="sm" />
				<span className="hit-main">
					<span className="hit-head">
						<b>
							{title} {fromServer}
						</b>
						<span>{listTime(message.date, new Date(), locale, copy)}</span>
					</span>
					<span className="hit-text">
						{group && sender !== "" && <b>{sender}: </b>}
						<Marked text={text} query={query} />
					</span>
				</span>
			</button>
		</li>
	);
}

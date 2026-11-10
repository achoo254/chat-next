// Inline mode of bots (mockups/bots.html#inline-mode): with "@bot_username "
// as the start of the draft, the bot's hint shows above the composer; with a
// query after it, the bot's results (a list of articles, or a grid of media
// when the bot asks for one). Picking one posts it as the user's message
// "via" the bot and clears the draft. Bots without inline mode, and
// usernames of people, show nothing. Loaded with the first such draft.
//
// As in Telegram Web, the results are a list attached to the message box,
// which keeps the focus: the box finds the token (inline-token.ts) and shows
// this list only while it has the focus; ↑ ↓ move through the results, Enter
// posts the highlighted one, Esc closes the list until the text changes, and
// a click picks without taking the focus from the box. Scrolling to the end
// asks the bot for its next page.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cryptoRandomId } from "@achoo254/chat-platform";
import { Icon } from "../../components/screen-icons.tsx";
import { inlineThumbUrl } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { useMediaFile } from "../media/use-media.ts";
import { botErrorKind, type BotInfo, type InlineAnswer, type InlineItem } from "./api.ts";
import { inlineDraft } from "./inline-token.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./inline-results.css";

/** Wait after the last keystroke before asking the bot. */
const QUERY_DELAY_MS = 400;

/** The next page is asked for once the list is scrolled this close to its end. */
const MORE_MARGIN_PX = 64;

/** Bots looked up by username in this session (null: no bot with inline mode). */
const resolved = new Map<string, Promise<BotInfo | null>>();

/** What the results answer: the bot, the chat and the query. */
type Asked = { readonly query: string; readonly botId: number; readonly chatId: number };

/** One result, with the answer (page) it came in: its media and its pick go through that answer's query id. */
interface Entry {
	readonly key: string;
	readonly queryId: string;
	readonly item: InlineItem;
}

type Results = Asked &
	(
		| { readonly status: "loading" }
		| {
				readonly status: "ready";
				readonly entries: readonly Entry[];
				readonly gallery: boolean;
				/** The offset of the next page; "" when there is none (or it failed). */
				readonly nextOffset: string;
				/** The next page is being fetched. */
				readonly more: boolean;
		  }
		| { readonly status: "timeout" }
		| { readonly status: "failed" }
	);

const entriesOf = (answer: InlineAnswer): Entry[] =>
	answer.items.map((item) => ({ key: `${answer.queryId}:${item.id}`, queryId: answer.queryId, item }));

const sameAsk = (a: Asked, b: Asked): boolean => a.query === b.query && a.botId === b.botId && a.chatId === b.chatId;

export interface InlineResultsProps {
	chatId: number;
	topicId: number;
	/** The inline mode token the message box has open: the whole draft, "@bot_username query". */
	draft: string;
	/** The id of the results list, which the message box controls. */
	listId: string;
	/** Set to the list's key handling while it shows: true when the list took the key. */
	keysRef: { current: ((event: KeyboardEvent) => boolean) | null };
	/** The id of the highlighted result (the box's active descendant), null without one. */
	onActive: (optionId: string | null) => void;
	/** The result was posted: the draft is cleared. */
	onSent: () => void;
}

export default function InlineResults({ chatId, topicId, draft, listId, keysRef, onActive, onSent }: InlineResultsProps) {
	const t = useBotsCopy().inline;
	const { bots, toasts } = useServices();
	const parsed = inlineDraft(draft);
	const name = parsed?.username.toLowerCase() ?? "";
	const query = parsed?.query ?? "";
	const [bot, setBot] = useState<{ name: string; info: BotInfo | null } | null>(null);
	const [results, setResults] = useState<Results | null>(null);
	const [sending, setSending] = useState("");
	/** The highlighted result, for the answer whose first page has this query id (another answer starts at the top). */
	const [selected, setSelected] = useState({ answer: "", index: 0 });
	const list = useRef<HTMLUListElement>(null);
	// Set at once (state updates later): a double click sends once.
	const busy = useRef(false);
	/** The page being fetched ("bot:chat:query:offset"), set at once: two calls in one render ask once. */
	const fetching = useRef("");

	useEffect(() => {
		if (name === "") return;
		let active = true;
		let lookup = resolved.get(name);
		if (lookup === undefined) {
			lookup = bots.resolve(name).then(
				(info) => (info !== null && info.inlinePlaceholder !== "" ? info : null),
				() => {
					resolved.delete(name);
					return null;
				},
			);
			resolved.set(name, lookup);
		}
		void lookup.then((info) => active && setBot({ name, info }));
		return () => {
			active = false;
		};
	}, [bots, name]);

	const info = name !== "" && bot?.name === name ? bot.info : null;
	const trimmed = query.trim();
	useEffect(() => {
		if (info === null || trimmed === "") return;
		let active = true;
		const asked = { query: trimmed, botId: info.id, chatId };
		const timer = setTimeout(() => {
			setResults({ ...asked, status: "loading" });
			bots.inlineQuery(info.id, chatId, trimmed, "").then(
				(answer) =>
					active && setResults({ ...asked, status: "ready", entries: entriesOf(answer), gallery: answer.gallery, nextOffset: answer.nextOffset, more: false }),
				(err: unknown) => active && setResults({ ...asked, status: botErrorKind(err) === "bot_timeout" ? "timeout" : "failed" }),
			);
		}, QUERY_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [bots, info, chatId, trimmed]);

	const current = info !== null && results !== null && sameAsk(results, { query: trimmed, botId: info.id, chatId }) ? results : null;
	const ready = current?.status === "ready" ? current : null;
	const entries = ready?.entries ?? [];
	const first = entries[0]?.queryId ?? "";
	const index = selected.answer === first ? Math.min(selected.index, Math.max(0, entries.length - 1)) : 0;
	const optionId = (position: number): string => `${listId}-${position}`;
	const activeId = entries.length > 0 ? optionId(index) : null;
	const select = (position: number) => setSelected({ answer: first, index: position });

	/** Asks for the next page of these results, once at a time; a failed page ends the list there. */
	const loadMore = () => {
		if (ready === null || ready.nextOffset === "" || ready.more) return;
		const offset = ready.nextOffset;
		const page = `${ready.botId}:${ready.chatId}:${ready.query}:${offset}`;
		if (fetching.current === page) return;
		fetching.current = page;
		const follows = (shown: Results | null): shown is Extract<Results, { status: "ready" }> =>
			shown !== null && shown.status === "ready" && sameAsk(shown, ready) && shown.nextOffset === offset;
		const done = () => {
			if (fetching.current === page) fetching.current = "";
		};
		setResults({ ...ready, more: true });
		bots.inlineQuery(ready.botId, ready.chatId, ready.query, offset).then(
			(answer) => {
				done();
				setResults((shown) =>
					follows(shown) ? { ...shown, entries: [...shown.entries, ...entriesOf(answer)], nextOffset: answer.nextOffset, more: false } : shown,
				);
			},
			() => {
				done();
				setResults((shown) => (follows(shown) ? { ...shown, nextOffset: "", more: false } : shown));
			},
		);
	};

	const nearEnd = (element: HTMLElement): boolean => element.scrollTop + element.clientHeight >= element.scrollHeight - MORE_MARGIN_PX;

	// A first page too short to scroll asks for the next one at once, as scrolling to its end would.
	useEffect(() => {
		const element = list.current;
		if (element !== null && nearEnd(element)) loadMore();
	});

	// The highlighted result stays in view as the arrows move it.
	useEffect(() => {
		if (activeId !== null) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
	}, [activeId]);

	// The box points at the highlighted result while there is one.
	useLayoutEffect(() => onActive(activeId), [onActive, activeId]);
	useLayoutEffect(() => () => onActive(null), [onActive]);

	const pick = (entry: Entry) => {
		if (busy.current) return;
		busy.current = true;
		setSending(entry.key);
		bots.sendInlineResult(chatId, topicId, entry.queryId, entry.item.id, cryptoRandomId()).then(
			() => {
				busy.current = false;
				setSending("");
				onSent();
			},
			() => {
				busy.current = false;
				setSending("");
				toasts.show(t.sendFailed);
			},
		);
	};

	/** Keys in the message box while the list shows (before the composer's own): true when the list took the key. */
	const onKey = (event: KeyboardEvent): boolean => {
		if (info === null) return false;
		const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
		const picked = entries[index];
		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && entries.length > 0) {
			const next = (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
			select(next);
			// Near the end, the next page comes before the arrows get there.
			if (next >= entries.length - 2) loadMore();
		} else if (event.key === "Enter" && !event.shiftKey && picked !== undefined) {
			pick(picked);
		} else if (event.key !== "Escape") {
			return false;
		}
		event.preventDefault();
		return true;
	};
	useLayoutEffect(() => {
		keysRef.current = onKey;
		return () => {
			keysRef.current = null;
		};
	});

	if (info === null) return null;

	const hint = (): ReactNode => {
		if (trimmed === "") {
			return (
				<p className="inline-hint">
					{info.inlinePlaceholder}
					<small className="muted">{t.disclosure(info.username)}</small>
				</p>
			);
		}
		switch (current?.status) {
			case undefined:
			case "loading":
				return <p className="inline-hint muted">{t.loading}</p>;
			case "timeout":
				return <p className="inline-hint muted">{t.timeout}</p>;
			case "failed":
				return <p className="inline-hint muted">{t.failed}</p>;
			case "ready":
				return current.entries.length === 0 ? <p className="inline-hint muted">{t.empty(trimmed)}</p> : null;
		}
	};
	const heading = current?.status === "loading" ? t.asking(info.username) : t.from(info.username);
	const gallery = ready?.gallery === true;
	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- not an action: a press anywhere on the results keeps the focus (and the phone keyboard) in the message box, which handles the keys of this listbox
		<div className="inline-results" role="region" aria-label={heading} onMouseDown={(event) => event.preventDefault()}>
			<div className="inline-head">
				<Icon name="robot" small />
				<span>{heading}</span>
			</div>
			<div aria-live="polite">{hint()}</div>
			{trimmed !== "" && entries.length > 0 && (
				<ul
					ref={list}
					id={listId}
					role="listbox"
					aria-label={heading}
					aria-busy={ready?.more === true}
					className={gallery ? "inline-grid" : "inline-list"}
					// Out of the Tab order (browsers make scrolling boxes focusable): the box keeps the keys.
					tabIndex={-1}
					onScroll={(event) => {
						if (nearEnd(event.currentTarget)) loadMore();
					}}
				>
					{entries.map((entry, position) => {
						const { item } = entry;
						return (
							// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- options never take focus: the message box handles ↑ ↓, Enter and Esc for this listbox
							<li
								key={entry.key}
								id={optionId(position)}
								role="option"
								aria-selected={position === index}
								aria-busy={sending === entry.key}
								aria-label={gallery ? item.title || item.description || item.kind : undefined}
								className={position === index ? "active" : undefined}
								onMouseMove={() => position !== index && select(position)}
								onClick={() => pick(entry)}
							>
								{gallery ? (
									<Thumb queryId={entry.queryId} item={item} />
								) : (
									<>
										{(item.thumbnail ?? item.media) !== undefined && <Thumb queryId={entry.queryId} item={item} small />}
										<span className="inline-text">
											<b>{item.title || item.media?.fileName || item.kind}</b>
											{item.description !== "" && <span>{item.description}</span>}
										</span>
									</>
								)}
							</li>
						);
					})}
					{ready?.more === true && (
						<li role="presentation" className="inline-more muted">
							{t.loadingMore}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

/** A result's picture: its photo (a video's poster), or an article's thumbnail; the inline thumb until it loads. */
function Thumb({ queryId, item, small = false }: { queryId: string; item: InlineItem; small?: boolean }) {
	const ref = item.thumbnail ?? item.media;
	const picture = ref !== undefined && (ref.kind === "photo" || ref.kind === "video");
	const { state } = useMediaFile(
		picture && ref !== undefined
			? { chatId: 0, seq: 0, fileId: ref.fileId, inlineQueryId: queryId, kind: ref.kind, ...(ref.sizes.some((s) => s.type === "s") ? { size: "s" as const } : {}) }
			: null,
	);
	const src = state.status === "ok" ? state.url : ref === undefined ? "" : inlineThumbUrl(ref.inlineThumb);
	return (
		<span className={small ? "thumb sm" : "thumb"} aria-hidden="true">
			{src !== "" && <img src={src} alt="" />}
			{!picture && <Icon name="file" />}
		</span>
	);
}

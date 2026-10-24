// Search in one chat (mockups/search.html#in-chat): the bar takes the place
// of the chat header. Hits are stepped through newest first with the arrow
// buttons, Enter (older) and Shift+Enter (newer); the chat jumps to each one
// and loads the history around it. Every match on screen is tinted and the
// current one stronger (CSS Custom Highlight API; browsers without it still
// get the jump and the flash of the message). Esc or X closes the bar and
// keeps the position.
import { fold, hitKey } from "@achoo254/chat-core";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { highlight } from "../data/highlight.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar } from "../ui/parts.tsx";
import { SenderPicker, useSenderName } from "./search-filters.tsx";
import { useMessageSearch } from "./use-message-search.ts";
import "./search.css";

interface InChatSearchProps {
	chatId: number;
	/** Forum topic being viewed; 0 searches the whole chat. */
	topicId: number;
	title: string;
	onClose: () => void;
}

export default function InChatSearch({ chatId, topicId, title, onClose }: InChatSearchProps) {
	const copy = useScreensCopy();
	const t = copy.search.inChat;
	const { store } = useServices();
	const [query, setQuery] = useState("");
	const [fromId, setFromId] = useState(0);
	const [picking, setPicking] = useState(false);
	const pickerId = useId();
	const headerRef = useRef<HTMLElement>(null);
	const search = useMessageSearch({ text: query, chatId, topicId, filters: fromId === 0 ? {} : { fromId } });
	const { state } = search;
	const hits = state.hits;
	const sender = useSenderName(fromId);

	// The selected hit, by key so merging in server hits keeps it selected,
	// and only for the request it was chosen in. Until the user steps, the
	// newest hit is selected.
	const requestKey = `${query.trim()}|${fromId}`;
	const [choice, setChoice] = useState({ request: "", hit: "" });
	// Stepping past the last loaded hit asks for the next page; the hit after
	// `from` is selected once it has arrived.
	const [pending, setPending] = useState({ request: "", from: "" });
	const indexOf = (key: string) => (key === "" ? -1 : hits.findIndex((hit) => hitKey(hit.message) === key));
	let index = choice.request === requestKey ? indexOf(choice.hit) : -1;
	if (index < 0 && hits.length > 0) index = 0;
	if (pending.request === requestKey && !state.loadingMore) {
		const from = indexOf(pending.from);
		if (from >= 0 && from + 1 < hits.length) index = from + 1;
	}
	const current = index >= 0 ? hits[index] : undefined;
	const select = (next: number) => {
		const hit = hits[next];
		if (hit === undefined) return;
		setChoice({ request: requestKey, hit: hitKey(hit.message) });
		setPending({ request: "", from: "" });
	};

	const currentSeq = current?.message.seq ?? 0;
	useEffect(() => {
		if (currentSeq !== 0) store.openWindow(chatId, currentSeq);
	}, [store, chatId, currentSeq]);
	useHitHighlights(headerRef, query, currentSeq);

	const older = () => {
		if (index + 1 < hits.length) select(index + 1);
		else if (state.hasMore && current !== undefined) {
			setPending({ request: requestKey, from: hitKey(current.message) });
			search.more();
		}
	};
	const newer = () => select(index - 1);
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) newer();
			else older();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		}
	};

	const searching = state.request !== null && state.server !== "idle";
	const busy = !state.localReady || ((state.server === "waiting" || state.server === "loading") && hits.length === 0);
	let counter = "";
	if (searching && busy) counter = t.searching;
	else if (searching && hits.length === 0) counter = t.none;
	else if (hits.length > 0) counter = t.counter(Math.max(1, index + 1), hits.length, state.hasMore);

	return (
		<>
			<header className="convo-head insearch" ref={headerRef}>
				<label className="search-field">
					<Icon name="search" small />
					<span className="sr-only">{t.label(title)}</span>
					<input
						type="search"
						autoComplete="off"
						spellCheck={false}
						// The bar opens on purpose (header button): typing starts at once.
						// eslint-disable-next-line jsx-a11y/no-autofocus -- opened by the user's own click, so focus goes where they will type
						autoFocus
						placeholder={t.label(title)}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
					/>
				</label>
				{fromId !== 0 && (
					<span className="chip on hide-narrow">
						<ChatAvatar id={fromId} name={sender} size="xs" />
						{sender}
						<button type="button" className="chip-x" aria-label={copy.search.removeSender(sender)} onClick={() => setFromId(0)}>
							<Icon name="x" small />
						</button>
					</span>
				)}
				<span className="counter" aria-live="polite">
					{counter}
				</span>
				<button type="button" className="icon-btn flip-y" aria-label={t.older} disabled={index + 1 >= hits.length && !state.hasMore} onClick={older}>
					<Icon name="chevron-down" />
				</button>
				<button type="button" className="icon-btn" aria-label={t.newer} disabled={index <= 0} onClick={newer}>
					<Icon name="chevron-down" />
				</button>
				<button
					type="button"
					className="icon-btn hide-narrow"
					aria-label={t.sender}
					aria-haspopup="dialog"
					aria-expanded={picking}
					aria-controls={pickerId}
					aria-pressed={fromId !== 0}
					onClick={() => setPicking((open) => !open)}
				>
					<Icon name="user" />
				</button>
				<button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
					<Icon name="x" />
				</button>
			</header>
			{picking && (
				<SenderPicker
					id={pickerId}
					chatId={chatId}
					onClose={() => setPicking(false)}
					onPick={(userId) => {
						setPicking(false);
						setFromId(userId);
					}}
				/>
			)}
		</>
	);
}

const HIT = "chat-search-hit";
const HIT_NOW = "chat-search-hit-now";
/** Parts of a message that are not its text: never tinted. */
const SKIP = ".stamp, .who, .qa, .reactions, .int-label, .via, .reply, .fwd, button";

/** Tints every match of `query` in the chat's messages on screen; the current hit's more strongly. */
function useHitHighlights(anchor: RefObject<HTMLElement | null>, query: string, currentSeq: number): void {
	useEffect(() => {
		const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
		const log = anchor.current?.closest(".convo")?.querySelector<HTMLElement>('[role="log"]');
		if (registry === undefined || typeof Highlight === "undefined" || log == null) return;
		const words = fold(query).trim();
		let frame = 0;
		const paint = () => {
			frame = 0;
			const all = new Highlight();
			const now = new Highlight();
			if (words !== "") {
				const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
					const parent = node.parentElement;
					if (parent === null || parent.closest(SKIP) !== null || node.textContent === null) continue;
					const target = parent.closest("[data-seq]")?.getAttribute("data-seq") === String(currentSeq) ? now : all;
					let offset = 0;
					for (const segment of highlight(node.textContent, query)) {
						if (segment.match) {
							const range = new Range();
							range.setStart(node, offset);
							range.setEnd(node, offset + segment.text.length);
							target.add(range);
						}
						offset += segment.text.length;
					}
				}
			}
			registry.set(HIT, all);
			registry.set(HIT_NOW, now);
		};
		paint();
		const observer = new MutationObserver(() => {
			if (frame === 0) frame = requestAnimationFrame(paint);
		});
		observer.observe(log, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
			registry.delete(HIT);
			registry.delete(HIT_NOW);
		};
	}, [anchor, query, currentSeq]);
}

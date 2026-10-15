// The chat list column: search box, filter tabs and the header with
// Settings, Contacts and New chat (narrow screens, mockups/chat.html#narrow)
// and the dialog list. Rows have a fixed height per kind and are absolutely
// positioned, and only the rows in view (plus a margin) are mounted. The
// "Chưa đọc" filter keeps a chat you just read until you change filters, so
// the list does not jump (#list-states). Alt+↑/↓ opens the chat above/below.
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/icon.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { inFolder, type Folder } from "../data/format.ts";
import { useBackendValue, useListEntries, useListStatus } from "../data/services.tsx";
import { ChatRow, ROW_HEIGHT, TWO_LINE_ROW_HEIGHT } from "./chat-row.tsx";
import { FolderTabs } from "./folder-rail.tsx";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { useUi } from "./ui-context.tsx";

const OVERSCAN_PX = 320;

const SearchResults = lazy(() => import("./search-results.tsx"));

/** Chats kept in the "Chưa đọc" filter after they were read, until the filter changes. */
interface Kept {
	readonly folder: Folder;
	readonly ids: ReadonlySet<number>;
}

interface ChatListProps {
	folder: Folder;
	onFolder: (folder: Folder) => void;
	currentChatId: number;
	searchRef: RefObject<HTMLInputElement | null>;
	onVisibleChats: (chatIds: readonly number[]) => void;
}

/** The search shortcut as this platform writes it (⌘K on Apple, Ctrl K elsewhere). */
const SEARCH_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K";

export function ChatListColumn({ folder, onFolder, currentChatId, searchRef, onVisibleChats }: ChatListProps) {
	const copy = useCopy();
	const ui = useUi();
	const [query, setQuery] = useState("");
	const searching = query.trim() !== "";

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			setQuery("");
			event.currentTarget.blur();
		}
	};

	return (
		<section className="list" aria-label={copy.list.label}>
			<header className="n-head narrow-only">
				<Link to={paths.settings("profile")} className="icon-btn" aria-label={copy.folders.settings}>
					<Icon name="settings" />
				</Link>
				<h2>{brand.appName}</h2>
				<Link to={paths.contacts()} className="icon-btn" aria-label={copy.folders.contacts}>
					<ContactsGlyph />
				</Link>
				<button type="button" className="icon-btn" aria-label={copy.list.newChat} onClick={() => ui.dialog.set({ kind: "newChat" })}>
					<Icon name="plus" />
				</button>
			</header>
			<div className="list-head">
				<label className="search-field">
					<Icon name="search" small />
					<span className="sr-only">{copy.list.search}</span>
					<input
						ref={searchRef}
						type="search"
						placeholder={copy.list.searchPlaceholder}
						autoComplete="off"
						value={query}
						onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
					/>
					<span className="kbd" aria-hidden="true">
						{SEARCH_SHORTCUT}
					</span>
				</label>
				<button type="button" className="icon-btn hide-narrow" aria-label={copy.list.newChat} onClick={() => ui.dialog.set({ kind: "newChat" })}>
					<Icon name="plus" />
				</button>
			</div>
			{searching ? (
				<Suspense fallback={<div className="search-panel" aria-busy="true" />}>
					<SearchResults query={query.trim()} onOpen={() => setQuery("")} inputRef={searchRef} />
				</Suspense>
			) : (
				<>
					<FolderTabs folder={folder} onFolder={onFolder} />
					<Dialogs folder={folder} onFolder={onFolder} currentChatId={currentChatId} onVisibleChats={onVisibleChats} />
				</>
			)}
		</section>
	);
}

function Skeleton() {
	const copy = useCopy();
	const widths = [
		["w60", "w85"],
		["w45", "w70"],
		["w55", "w90"],
		["w35", "w65"],
		["w50", "w80"],
	];
	return (
		<div className="list-loading" aria-busy="true">
			<div aria-hidden="true">
				{widths.map(([a, b], index) => (
					<div className="sk-row" key={index}>
						<span className="sk av" />
						<div>
							<span className={`sk ${a ?? ""}`} />
							<span className={`sk ${b ?? ""}`} />
						</div>
						<span className="sk" />
					</div>
				))}
			</div>
			<div className="list-foot">
				<span className="spin" aria-hidden="true" />
				{copy.list.firstLoad}
			</div>
		</div>
	);
}

interface DialogsProps {
	folder: Folder;
	onFolder: (folder: Folder) => void;
	currentChatId: number;
	onVisibleChats: (chatIds: readonly number[]) => void;
}

function Dialogs({ folder, onFolder, currentChatId, onVisibleChats }: DialogsProps) {
	const copy = useCopy();
	const entries = useListEntries();
	const status = useListStatus();
	const scroller = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(640);
	const [kept, setKept] = useState<Kept>({ folder, ids: new Set() });
	if (kept.folder !== folder) setKept({ folder, ids: new Set() });
	// Forums whose topics are loaded show a second line (the topics), so their rows are taller.
	const twoLine = useBackendValue((backend) =>
		entries
			.filter((entry) => entry.forum && backend.topics(entry.chatId) !== null)
			.map((entry) => entry.chatId)
			.join(","),
	);

	const rows = useMemo(() => {
		const tall = new Set(twoLine === "" ? [] : twoLine.split(",").map(Number));
		const ids: number[] = [];
		const offsets: number[] = [];
		let total = 0;
		for (const entry of entries) {
			const unread = entry.unread || (kept.folder === folder && kept.ids.has(entry.chatId)) || (folder === "unread" && entry.chatId === currentChatId);
			if (!inFolder(entry.kind, folder, unread)) continue;
			ids.push(entry.chatId);
			offsets.push(total);
			total += tall.has(entry.chatId) ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT;
		}
		return { ids, offsets, total };
	}, [entries, folder, kept, currentChatId, twoLine]);

	// Remember what the "Chưa đọc" filter showed, so reading a chat does not drop it.
	if (folder === "unread" && kept.folder === folder && rows.ids.some((id) => !kept.ids.has(id))) {
		setKept({ folder, ids: new Set([...kept.ids, ...rows.ids]) });
	}

	// Alt+↑/↓: the chat above or below the open one in this list.
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
			const index = rows.ids.indexOf(currentChatId);
			const next = rows.ids[index === -1 ? 0 : index + (event.key === "ArrowUp" ? -1 : 1)];
			if (next === undefined) return;
			event.preventDefault();
			navigate(paths.chat(next));
			const element = scroller.current;
			const position = rows.ids.indexOf(next);
			const top = rows.offsets[position] ?? 0;
			if (element !== null && (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight)) {
				element.scrollTop = Math.max(0, top - element.clientHeight / 2);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [rows, currentChatId]);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element === null) return;
		setViewport(element.clientHeight || 640);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setViewport(element.clientHeight || 640));
		observer.observe(element);
		return () => observer.disconnect();
	}, [status]);

	const first = Math.max(0, upperBound(rows.offsets, scrollTop - OVERSCAN_PX) - 1);
	const last = Math.min(rows.ids.length, upperBound(rows.offsets, scrollTop + viewport + OVERSCAN_PX));
	const visible = rows.ids.slice(first, last);
	const visibleKey = visible.join(",");

	useEffect(() => {
		onVisibleChats(visibleKey === "" ? [] : visibleKey.split(",").map(Number));
	}, [visibleKey, onVisibleChats]);

	if (status === "loading" && entries.length === 0) return <Skeleton />;
	if (rows.ids.length === 0) {
		return (
			<div className="empty">
				<Icon name="checks" />
				<strong>{folder === "unread" ? copy.folders.emptyTitleUnread : copy.folders.emptyTitle}</strong>
				<span>{copy.folders.emptyBody[folder]}</span>
				{folder !== "all" && (
					<button type="button" className="btn btn-sm" onClick={() => onFolder("all")}>
						{copy.folders.showAll}
					</button>
				)}
			</div>
		);
	}
	// Only "Cloud của tôi" and bots (every account starts with the assistant
	// bot's chat) so far: the rest of the list invites the team (#first-run).
	const alone = folder === "all" && entries.every((entry) => entry.saved || entry.kind === "bot");
	return (
		<div className={alone ? "chats alone" : "chats"} ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
			<ul className="chat-rows" aria-label={copy.list.label} style={{ height: rows.total }}>
				{visible.map((chatId, index) => {
					const position = first + index;
					return (
						<ChatRow
							key={chatId}
							chatId={chatId}
							current={chatId === currentChatId}
							position={position + 1}
							total={rows.ids.length}
							style={{
								transform: `translateY(${rows.offsets[position] ?? 0}px)`,
								height: (rows.offsets[position + 1] ?? rows.total) - (rows.offsets[position] ?? 0),
							}}
						/>
					);
				})}
			</ul>
			{alone && <InviteTeam />}
		</div>
	);
}

/** The empty list of a new account: bring the team in with a group invite link. */
function InviteTeam() {
	const copy = useCopy();
	const ui = useUi();
	return (
		<div className="empty invite-team">
			<Icon name="users" />
			<strong>{copy.folders.inviteTitle}</strong>
			<span>{copy.folders.inviteBody}</span>
			<button type="button" className="btn btn-primary" onClick={() => ui.dialog.set({ kind: "newGroup", withUserId: 0 })}>
				<Icon name="user-plus" />
				{copy.folders.inviteCreateGroup}
			</button>
			<button type="button" className="btn" onClick={() => ui.dialog.set({ kind: "newChat" })}>
				<Icon name="message" />
				{copy.folders.inviteMessageOne}
			</button>
		</div>
	);
}

/** Index of the first offset greater than `value`. */
function upperBound(offsets: readonly number[], value: number): number {
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((offsets[mid] ?? 0) <= value) low = mid + 1;
		else high = mid;
	}
	return low;
}

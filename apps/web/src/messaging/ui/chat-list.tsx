// The chat list column: search box, filter tabs and the header with
// Settings, Contacts and New chat (narrow screens, mockups/chat.html#narrow)
// and the dialog list. Rows have a fixed height per kind and are absolutely
// positioned, and only the rows in view (plus a margin) are mounted.
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/icon.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { chatKind, inFolder, type Folder } from "../data/format.ts";
import { useBackendVersion, useDialogOrder, useListStatus, useServices } from "../data/services.tsx";
import { ChatRow, ROW_HEIGHT, TWO_LINE_ROW_HEIGHT } from "./chat-row.tsx";
import { FolderTabs } from "./folder-rail.tsx";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { useUi } from "./ui-context.tsx";

const OVERSCAN_PX = 320;

const SearchResults = lazy(() => import("./search-results.tsx"));

interface ChatListProps {
	folder: Folder;
	onFolder: (folder: Folder) => void;
	currentChatId: number;
	searchRef: RefObject<HTMLInputElement | null>;
	onVisibleChats: (chatIds: readonly number[]) => void;
}

export function ChatListColumn({ folder, onFolder, currentChatId, searchRef, onVisibleChats }: ChatListProps) {
	const copy = useCopy();
	const ui = useUi();
	const [query, setQuery] = useState("");
	const searching = query.trim() !== "";

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") setQuery("");
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
						⌘K
					</span>
				</label>
				<button type="button" className="icon-btn hide-narrow" aria-label={copy.list.newChat} onClick={() => ui.dialog.set({ kind: "newChat" })}>
					<Icon name="plus" />
				</button>
			</div>
			{searching ? (
				<Suspense fallback={<div className="search-panel" aria-busy="true" />}>
					<SearchResults query={query.trim()} />
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
	const { store, backend } = useServices();
	const order = useDialogOrder();
	const status = useListStatus();
	const backendVersion = useBackendVersion();
	const scroller = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(640);

	const rows = useMemo(() => {
		void backendVersion;
		const pinned: number[] = [];
		const rest: number[] = [];
		for (const chatId of order) {
			const view = store.dialog(chatId);
			if (view === undefined || !inFolder(chatKind(view.chat, view.peer, false), folder)) continue;
			(backend.isPinnedDialog(chatId) ? pinned : rest).push(chatId);
		}
		const ids = [...pinned, ...rest];
		const offsets: number[] = [];
		let total = 0;
		for (const chatId of ids) {
			offsets.push(total);
			const view = store.dialog(chatId);
			total += view?.chat?.forum === true && backend.topics(chatId) !== null ? TWO_LINE_ROW_HEIGHT : ROW_HEIGHT;
		}
		return { ids, offsets, total };
	}, [order, folder, store, backend, backendVersion]);

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

	if (status === "loading" && order.length === 0) return <Skeleton />;
	if (rows.ids.length === 0) {
		return (
			<div className="empty">
				<Icon name="checks" />
				<strong>{copy.folders.emptyTitle}</strong>
				<span>{copy.folders.emptyBody[folder]}</span>
				{folder !== "all" && (
					<button type="button" className="btn btn-sm" onClick={() => onFolder("all")}>
						{copy.folders.showAll}
					</button>
				)}
			</div>
		);
	}
	return (
		<div className="chats" ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
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

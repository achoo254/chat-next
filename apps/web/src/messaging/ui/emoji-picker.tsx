// One emoji panel for reactions and the composer (mockups/chat.html#emoji-picker):
// a search box (Vietnamese names, accents optional), "Dùng gần đây", category
// tabs and a grid. Arrow keys move between cells, Enter picks, Esc closes and
// the caller returns focus to the button that opened it. A reaction closes
// the panel; the composer keeps it open to pick more.
import { fold } from "@app/core";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";

type Category = "smileys" | "gestures" | "objects" | "symbols";

/** Emoji with their Vietnamese names (search matches the names without accents). */
const EMOJIS: Record<Category, readonly (readonly [string, string])[]> = {
	smileys: [
		["😀", "Cười tươi"], ["😃", "Cười to"], ["😄", "Cười híp mắt"], ["😁", "Cười nhe răng"], ["😆", "Cười sảng khoái"],
		["😅", "Cười ngượng"], ["🤣", "Cười lăn"], ["😂", "Cười ra nước mắt"], ["🙂", "Mỉm cười"], ["😉", "Nháy mắt"],
		["😊", "Cười hiền"], ["😇", "Thiên thần"], ["🥰", "Yêu thương"], ["😍", "Mắt trái tim"], ["😘", "Hôn gió"],
		["😋", "Ngon miệng"], ["😎", "Kính râm"], ["🤓", "Mọt sách"], ["🤔", "Suy nghĩ"], ["🤨", "Nghi ngờ"],
		["😐", "Không cảm xúc"], ["😶", "Im lặng"], ["🙄", "Đảo mắt"], ["😏", "Cười nhếch mép"], ["😬", "Nhăn răng"],
		["😮", "Ngạc nhiên"], ["😲", "Kinh ngạc"], ["😳", "Đỏ mặt"], ["🥺", "Năn nỉ"], ["😢", "Buồn"],
		["😭", "Khóc to"], ["😤", "Hừ"], ["😡", "Giận dữ"], ["🤯", "Choáng váng"], ["😱", "Hoảng sợ"],
		["😴", "Buồn ngủ"], ["🤒", "Ốm"], ["🤗", "Ôm"], ["🤫", "Suỵt"], ["🥲", "Cười trong nước mắt"],
		["😌", "Nhẹ nhõm"], ["🥳", "Tiệc tùng"],
	],
	gestures: [
		["👍", "Thích"], ["👎", "Không thích"], ["👌", "Ổn"], ["✌️", "Chiến thắng"], ["🤞", "Cầu may"],
		["🤝", "Bắt tay"], ["👏", "Vỗ tay"], ["🙌", "Giơ tay ăn mừng"], ["🙏", "Cảm ơn"], ["💪", "Mạnh mẽ"],
		["👋", "Vẫy tay"], ["✋", "Dừng lại"], ["👉", "Chỉ sang phải"], ["👈", "Chỉ sang trái"], ["👆", "Chỉ lên"],
		["👇", "Chỉ xuống"], ["☝️", "Một ý"], ["🤙", "Gọi nhé"], ["🫡", "Tuân lệnh"], ["👀", "Đang xem"],
		["🫶", "Trái tim bằng tay"],
	],
	objects: [
		["💡", "Ý tưởng"], ["📌", "Ghim"], ["📎", "Kẹp giấy"], ["📝", "Ghi chú"], ["📅", "Lịch"],
		["⏰", "Báo thức"], ["💻", "Máy tính"], ["📱", "Điện thoại"], ["🔒", "Khoá"], ["🔑", "Chìa khoá"],
		["🛠️", "Công cụ"], ["🐛", "Lỗi"], ["🚀", "Tên lửa"], ["🎉", "Ăn mừng"], ["🎁", "Quà"],
		["☕", "Cà phê"], ["🍕", "Pizza"], ["🏆", "Cúp"], ["📦", "Gói hàng"], ["📊", "Biểu đồ"],
	],
	symbols: [
		["✅", "Xong"], ["❌", "Sai"], ["⚠️", "Cảnh báo"], ["❗", "Chú ý"], ["❓", "Câu hỏi"],
		["❤️", "Yêu thích"], ["💔", "Tim vỡ"], ["🔥", "Lửa"], ["⭐", "Ngôi sao"], ["✨", "Lấp lánh"],
		["💯", "Một trăm điểm"], ["🆗", "OK"], ["🔴", "Chấm đỏ"], ["🟢", "Chấm xanh"], ["➕", "Cộng"],
		["➖", "Trừ"], ["🔁", "Lặp lại"], ["⏳", "Đang chờ"], ["💤", "Ngủ"],
	],
};

const CATEGORIES: readonly Category[] = ["smileys", "gestures", "objects", "symbols"];
const TAB_GLYPHS: Record<Category, string> = { smileys: "😀", gestures: "👍", objects: "💡", symbols: "✅" };
const NAMES = new Map(CATEGORIES.flatMap((category) => EMOJIS[category]));
const RECENT_KEY = "chat:emoji-recent";
const RECENT_MAX = 7;
const DEFAULT_RECENT = ["👍", "🙏", "✅", "🔥", "👀", "🎉", "❤️"];
/** A cell is 44px plus a 2px gap; used when the grid has no layout (tests). */
const CELL_PX = 46;

function readRecent(): string[] {
	try {
		const stored: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "null");
		if (Array.isArray(stored)) {
			const known = stored.filter((item): item is string => typeof item === "string" && NAMES.has(item));
			if (known.length > 0) return known.slice(0, RECENT_MAX);
		}
	} catch {
		// Unreadable or blocked storage: the default row.
	}
	return DEFAULT_RECENT;
}

function remember(emoji: string): void {
	try {
		const next = [emoji, ...readRecent().filter((item) => item !== emoji)].slice(0, RECENT_MAX);
		window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// The recent row simply does not update when storage is blocked.
	}
}

interface Section {
	readonly id: "recent" | Category | "results";
	readonly title: string;
	readonly emojis: readonly string[];
}

interface EmojiPickerProps {
	/** "reaction": picking reacts and closes; "insert": picking inserts and keeps the panel open. */
	mode: "reaction" | "insert";
	onPick: (emoji: string) => void;
	/** Called on Esc and on a click outside; the caller moves focus back. */
	onClose: () => void;
}

export function EmojiPicker({ mode, onPick, onClose }: EmojiPickerProps) {
	const copy = useScreensCopy();
	const t = copy.emojiPicker;
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	const [query, setQuery] = useState("");
	const [recent, setRecent] = useState(readRecent);
	const [tab, setTab] = useState<Section["id"]>("recent");
	const [active, setActive] = useState(0);

	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		ref.current?.querySelector<HTMLInputElement>("input")?.focus();
		const onDown = (event: PointerEvent) => {
			if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) closeRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, []);

	const needle = fold(query.trim());
	const sections = useMemo<readonly Section[]>(() => {
		if (needle !== "") {
			const hits = CATEGORIES.flatMap((category) => EMOJIS[category]).filter(([, name]) => fold(name).includes(needle));
			return [{ id: "results", title: t.results(query.trim()), emojis: hits.map(([emoji]) => emoji) }];
		}
		return [
			{ id: "recent", title: t.recent, emojis: recent },
			...CATEGORIES.map((category) => ({ id: category, title: t[category], emojis: EMOJIS[category].map(([emoji]) => emoji) })),
		];
	}, [needle, query, recent, t]);
	const cells = sections.flatMap((section) => section.emojis.map((emoji) => ({ section: section.id, emoji })));
	const current = Math.min(active, Math.max(0, cells.length - 1));
	/** Index of each section's first cell in `cells`. */
	const starts = sections.map((_, index) => sections.slice(0, index).reduce((sum, section) => sum + section.emojis.length, 0));

	const pick = (emoji: string) => {
		remember(emoji);
		if (mode === "insert") setRecent(readRecent());
		onPick(emoji);
	};

	const focusCell = (index: number) => {
		setActive(index);
		ref.current?.querySelectorAll<HTMLButtonElement>(".emoji-grid button")[index]?.focus();
	};

	const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const grid = ref.current?.querySelector<HTMLElement>(".emoji-grid");
		const columns = Math.max(1, Math.floor((grid?.clientWidth ?? 0) / CELL_PX) || 7);
		const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
		const step = steps[event.key];
		if (step === undefined) return;
		event.preventDefault();
		const next = current + step;
		if (next < 0) {
			ref.current?.querySelector<HTMLInputElement>("input")?.focus();
			return;
		}
		focusCell(Math.min(cells.length - 1, next));
	};

	const jump = (id: Section["id"]) => {
		setTab(id);
		const index = cells.findIndex((cell) => cell.section === id);
		if (index < 0) return;
		setActive(index);
		// The scroller is the sections' offset parent (position: relative), so this puts the heading on top.
		const scroller = ref.current?.querySelector<HTMLElement>(".emoji-scroll");
		const section = ref.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
		if (scroller != null && section != null) scroller.scrollTop = section.offsetTop;
	};

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc pressed on the search field or an emoji bubbles here to close the picker
		<div
			ref={ref}
			className="emoji-pop"
			role="group"
			aria-label={mode === "reaction" ? t.reaction : t.insert}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					closeRef.current();
				}
			}}
		>
			<label className="search-field">
				<Icon name="search" small />
				<span className="sr-only">{t.search}</span>
				<input
					type="search"
					placeholder={t.search}
					autoComplete="off"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" && cells.length > 0) {
							event.preventDefault();
							focusCell(0);
						} else if (event.key === "Enter" && cells[0] !== undefined) {
							event.preventDefault();
							pick(cells[0].emoji);
						}
					}}
				/>
			</label>
			{needle === "" && (
				<div className="emoji-cats" role="tablist" aria-label={t.categories}>
					<button type="button" role="tab" aria-selected={tab === "recent"} aria-label={t.recent} onClick={() => jump("recent")}>
						<Icon name="clock" />
					</button>
					{CATEGORIES.map((category) => (
						<button key={category} type="button" role="tab" aria-selected={tab === category} aria-label={t[category]} onClick={() => jump(category)}>
							<span aria-hidden="true">{TAB_GLYPHS[category]}</span>
						</button>
					))}
				</div>
			)}
			<div className="emoji-scroll" role="presentation" onKeyDown={onGridKey}>
				{sections.map((section, sectionIndex) => {
					const start = starts[sectionIndex] ?? 0;
					return (
						<div className="emoji-sec" key={section.id} data-section={section.id}>
							<h4>{section.title}</h4>
							{section.emojis.length === 0 ? (
								<p className="emoji-none">{t.none}</p>
							) : (
								<div className="emoji-grid" role="group" aria-label={section.title}>
									{section.emojis.map((emoji, index) => (
										<button
											key={emoji}
											type="button"
											aria-label={NAMES.get(emoji) ?? emoji}
											tabIndex={start + index === current ? 0 : -1}
											onFocus={() => setActive(start + index)}
											onClick={() => pick(emoji)}
										>
											{emoji}
										</button>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

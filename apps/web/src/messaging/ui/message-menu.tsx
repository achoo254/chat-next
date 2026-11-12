// Message actions (mockups/chat.html#context-menu): a popover that opens right
// where it was asked for (the pointer, or the message's "…" / "Thả cảm xúc"
// button) with the "Thả cảm xúc" row over the menu. It opens below that spot
// and flips above it when the messages area has no room below. Opened by right
// click, long press, the keyboard or the message's buttons; Esc or a click
// outside closes it. The + at the end of the reaction row (or the message's
// emoji button) shows the full emoji panel (#emoji-picker). Your own messages
// offer "Thu hồi" (for everyone) and "Xoá ở phía tôi"; other people's only
// "Xoá ở phía tôi"; a recalled message only "Xoá ở phía tôi", without the
// reaction row. On a phone (the stylesheet's touch breakpoint) the message is
// lifted instead (Telegram): the screen blurs, a copy of the message floats
// from its place (up or down only as far as the reaction row and the menu need
// to fit) and sinks back to it when the menu closes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Chat, StoredMessage } from "@achoo254/chat-core";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { Glyph, type GlyphName } from "./glyphs.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { isSavedChat } from "../data/format.ts";
import { pinnedLists } from "../data/pinned.ts";
import type { WindowItem } from "../data/store.ts";
import { Permission, type Limits } from "../data/remote.ts";
import { useItem, useServices, useUser } from "../data/services.tsx";
import { EmojiPicker } from "./emoji-picker.tsx";
import { MessageBubble, PendingBubble } from "./message-item.tsx";
import { QUICK_REACTIONS } from "./reaction-pill.ts";
import { copyText } from "./parts.tsx";
import { useUi, type MenuAnchor } from "./ui-context.tsx";

export function canPin(chat: Chat | null): boolean {
	if (chat === null) return false;
	if (chat.type === "private" || chat.type === "secret") return true;
	if (chat.myRole === "admin" || chat.myRole === "owner") return true;
	return chat.type === "group" && (chat.myPermissions & Permission.pinMessages) !== 0;
}

/** "Who read it": own messages in groups within the size and age the server allows. */
function canSeeReaders(message: StoredMessage, chat: Chat | null, selfId: number, limits: Limits | null): boolean {
	if (chat?.type !== "group" || message.fromId !== selfId || limits === null) return false;
	if (limits.readReceiptsMemberMax > 0 && chat.memberCount > limits.readReceiptsMemberMax) return false;
	return limits.readReceiptsMaxAge === 0 || Date.now() / 1000 - message.date <= limits.readReceiptsMaxAge;
}

function canEdit(message: StoredMessage, selfId: number, limits: Limits | null): boolean {
	if (message.fromId !== selfId || message.text === "" || message.forward !== null || message.action !== null) return false;
	if (limits === null || limits.editTimeLimit === 0) return true;
	return Date.now() / 1000 - message.date <= limits.editTimeLimit;
}

interface MenuEntry {
	readonly label: string;
	readonly icon: IconName | { readonly glyph: GlyphName };
	readonly run: () => void;
	readonly danger?: boolean;
	readonly separated?: boolean;
}

interface MenuLayerProps {
	chatId: number;
	itemKey: string;
	chat: Chat | null;
	/** Open on the emoji panel instead of the menu. */
	picker: boolean;
	anchor: MenuAnchor;
	readOutboxMaxSeq: number;
}

/** Gap kept between the popover and the spot it opened from, and from the edges of the area. */
const GAP_PX = 4;
const EDGE_PX = 8;

/**
 * Places the popover at `anchor`: below it, or above it when it would pass the
 * bottom of the messages area; kept inside the window sideways. A button's
 * popover lines up with the button's start edge (end edge on your own messages).
 */
function place(element: HTMLElement, anchor: MenuAnchor, mine: boolean): void {
	element.style.maxHeight = "";
	const width = element.offsetWidth;
	const height = element.offsetHeight;
	const area = document.querySelector(".convo .messages")?.getBoundingClientRect();
	const floor = Math.min(area?.bottom ?? window.innerHeight, window.innerHeight) - EDGE_PX;
	const ceiling = Math.max(area?.top ?? 0, 0) + EDGE_PX;
	const roomBelow = floor - (anchor.bottom + GAP_PX);
	const roomAbove = anchor.top - GAP_PX - ceiling;
	// Below the spot unless it does not fit there and the other side has more room; when neither fits, the larger side with a scroll.
	const flip = height > roomBelow && roomAbove > roomBelow;
	const room = flip ? roomAbove : roomBelow;
	const shown = Math.min(height, Math.max(room, 0));
	if (shown < height) element.style.maxHeight = `${shown}px`;
	element.style.top = `${flip ? anchor.top - GAP_PX - shown : anchor.bottom + GAP_PX}px`;
	const button = anchor.left !== anchor.right;
	const left = button && mine ? anchor.right - width : anchor.left;
	element.style.left = `${Math.max(EDGE_PX, Math.min(left, window.innerWidth - width - EDGE_PX))}px`;
}

/** The touch layout of the stylesheet (messaging.css): the message is lifted rather than a popover opened. */
const TOUCH_QUERY = "(max-width: 760px), (pointer: coarse)";
/** How long the lifted message takes to settle back; matches the transition in messaging.css. */
const LEAVE_MS = 200;

/**
 * Places the lifted stack so the message copy sits exactly over the original,
 * and sets --lift: how far the stack floats (vertically) to keep the reaction
 * row and the menu inside the window.
 */
function placeLifted(stack: HTMLElement, from: DOMRect, mine: boolean): void {
	const copyTop = stack.querySelector<HTMLElement>(".ctx-message")?.offsetTop ?? 0;
	const width = stack.offsetWidth;
	const height = stack.offsetHeight;
	const top = from.top - copyTop;
	const floating = Math.max(EDGE_PX, Math.min(top, window.innerHeight - height - EDGE_PX));
	const left = mine ? from.right - width : from.left;
	stack.style.left = `${Math.max(EDGE_PX, Math.min(left, window.innerWidth - width - EDGE_PX))}px`;
	stack.style.top = `${top}px`;
	stack.style.setProperty("--lift", `${floating - top}px`);
}

/** Every message of the album `message` belongs to, in order; just its own seq outside an album. */
function albumSeqs(items: readonly WindowItem[], message: StoredMessage): number[] {
	if (message.groupedId === 0) return [message.seq];
	return items.flatMap((item) =>
		item.kind === "message" && !item.message.recalled && item.message.groupedId === message.groupedId && item.message.fromId === message.fromId
			? [item.message.seq]
			: [],
	);
}

export default function MenuLayer({ chatId, itemKey, chat, picker, anchor, readOutboxMaxSeq }: MenuLayerProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { store, source, remote, backend, toasts } = useServices();
	const pins = pinnedLists(store);
	const item = useItem(chatId, itemKey);
	const author = useUser(item?.kind === "message" && item.message.fromId !== store.selfId ? item.message.fromId : 0);
	const menu = useRef<HTMLDivElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const [limits, setLimits] = useState<Limits | null>(null);
	const [more, setMore] = useState(picker);
	// Lifted layout: where the message is on screen when the menu opens; null for the popover.
	const from = useMemo(() => {
		if (typeof window.matchMedia !== "function" || !window.matchMedia(TOUCH_QUERY).matches) return null;
		return document.querySelector<HTMLElement>(`.messages [data-key="${itemKey}"]`)?.getBoundingClientRect() ?? null;
	}, [itemKey]);
	const stack = useRef<HTMLDivElement>(null);
	const [phase, setPhase] = useState<"enter" | "open" | "leave">("enter");
	const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		let active = true;
		remote.limits().then(
			(value) => {
				if (active) setLimits(value);
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote]);

	useEffect(() => {
		if (from !== null) return;
		const onDown = (event: PointerEvent) => {
			if (pop.current !== null && event.target instanceof Node && !pop.current.contains(event.target)) ui.menu.set(null);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [ui, from]);

	// Lifted: one frame at the message's place, then the float and the fade-in (and clear a pending leave on unmount).
	useEffect(() => {
		if (from === null) return;
		const frame = requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")));
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(leaving.current);
		};
	}, [from]);

	useEffect(() => {
		if (!more) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, [more]);

	// Placed after layout, before paint; again whenever the content changes (menu <-> emoji panel).
	useLayoutEffect(() => {
		const mineNow = item?.kind === "pending" || item?.message.fromId === store.selfId;
		if (from !== null && stack.current !== null) placeLifted(stack.current, from, mineNow);
		else if (pop.current !== null) place(pop.current, anchor, mineNow);
	});

	// The popover closes at once; the lifted message sinks back first, while an action runs straight away.
	const close = () => {
		const done = () => {
			ui.menu.set(null);
			document.querySelector<HTMLElement>(`.messages [data-key="${itemKey}"]`)?.focus();
		};
		if (from === null) {
			done();
			return;
		}
		if (phase === "leave") return;
		setPhase("leave");
		leaving.current = setTimeout(done, LEAVE_MS);
	};

	if (item === undefined) return null;
	const mine = item.kind === "pending" || item.message.fromId === store.selfId;
	const failure = (err: unknown) => {
		void err;
		toasts.show(copy.common.failed);
	};
	const text = item.kind === "pending" ? item.pending.text : item.message.text;
	const copyEntry: MenuEntry = {
		label: copy.menu.copy,
		icon: "copy",
		run: () => {
			void copyText(text).then((ok) => toasts.show(ok ? copy.menu.copiedText : copy.common.failed));
		},
	};

	const entries: MenuEntry[] = [];
	if (item.kind === "pending") {
		const pending = item.pending;
		if (pending.failure !== null) {
			entries.push({ label: copy.menu.resend, icon: "send", run: () => source.retryOutbox(pending.outboxId).catch(failure) });
		}
		entries.push(copyEntry);
		entries.push({ label: copy.menu.discard, icon: "trash", danger: true, separated: true, run: () => source.discardOutbox(pending.outboxId).catch(failure) });
	} else if (item.message.recalled) {
		// A recalled message has nothing left but its place: it can only be hidden on your side.
		const message = item.message;
		entries.push({ label: copy.menu.deleteForMe, icon: "trash", danger: true, run: () => ui.dialog.set({ kind: "delete", chatId, seq: message.seq, recall: false }) });
	} else {
		const message = item.message;
		const channel = chat?.type === "channel";
		const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
		const canWrite = !channel || admin;
		if (canWrite) entries.push({ label: copy.menu.reply, icon: "reply", run: () => ui.intents.cell(chatId).set({ mode: "reply", seq: message.seq }) });
		// An album goes on as a whole, as from its quick Forward button.
		const seqs = albumSeqs(store.items(chatId), message);
		entries.push({ label: copy.menu.forward, icon: "forward", run: () => ui.dialog.set({ kind: "forward", chatId, seq: message.seq, seqs }) });
		if (!isSavedChat(chat, null)) {
			entries.push({
				label: copy.menu.saveToCloud,
				icon: "cloud",
				// CreatePrivate with yourself answers your saved chat, creating it when needed.
				run: () =>
					remote
						.createPrivate(store.selfId)
						.then((saved) => remote.forward(chatId, seqs, saved))
						.then(() => toasts.show(copy.menu.savedToCloud), failure),
			});
		}
		if (message.text !== "") entries.push(copyEntry);
		const media = message.media;
		if (media !== undefined) {
			entries.push({
				label: copy.menu.download,
				icon: "arrow-down",
				run: () => {
					toasts.show(copy.menu.downloading);
					void import("../media/download.ts")
						.then(({ downloadMedia }) => downloadMedia(source, chatId, message.seq, media))
						.then(
							(ok) => {
								if (!ok) toasts.show(copy.menu.mediaGone);
							},
							failure,
						);
				},
			});
		}
		if (canEdit(message, store.selfId, limits)) {
			entries.push({ label: copy.menu.edit, icon: "edit", run: () => ui.intents.cell(chatId).set({ mode: "edit", seq: message.seq }) });
		}
		if (canPin(chat)) {
			const pinned = chat?.pinnedSeq === message.seq || pins.listed(chatId, message.seq);
			const direct = pinned || chat?.type === "private" || chat?.type === "secret";
			entries.push({
				label: pinned ? copy.menu.unpin : copy.menu.pin,
				icon: "pin",
				run: () => {
					// Groups and channels ask first (notify everyone or pin quietly); a private chat pins at once.
					if (!direct) {
						ui.dialog.set({ kind: "pin", chatId, seq: message.seq });
						return;
					}
					(pinned ? remote.unpin(chatId, message.seq) : remote.pin(chatId, message.seq)).then(
						() => {
							if (pinned) pins.forget(chatId, [message.seq]);
							toasts.show(pinned ? copy.menu.unpinned : copy.menu.pinned);
						},
						failure,
					);
				},
			});
		}
		if (canSeeReaders(message, chat, store.selfId, limits)) {
			entries.push({ label: copy.menu.readBy, icon: "eye", run: () => ui.dialog.set({ kind: "readBy", chatId, seq: message.seq }) });
		}
		if (!mine && backend.features.has("report")) {
			entries.push({
				label: copy.menu.report,
				icon: "flag",
				run: () =>
					ui.dialog.set({
						kind: "report",
						target: { kind: "message", chatId, seq: message.seq },
						name: author?.name ?? copy.message.unknownUser,
						blockUserId: message.fromId,
					}),
			});
		}
		if (mine) {
			entries.push({
				label: copy.menu.recall,
				icon: { glyph: "refresh" },
				danger: true,
				separated: true,
				run: () => ui.dialog.set({ kind: "delete", chatId, seq: message.seq, recall: true }),
			});
		}
		entries.push({
			label: copy.menu.deleteForMe,
			icon: "trash",
			danger: true,
			separated: !mine,
			run: () => ui.dialog.set({ kind: "delete", chatId, seq: message.seq, recall: false }),
		});
	}

	const react = (emoji: string) => {
		if (item.kind !== "message") return;
		const current = item.message.reactions.find((r) => r.chosen)?.emoji;
		remote.setReaction(chatId, item.message.seq, current === emoji ? "" : emoji).catch(failure);
		close();
	};

	const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
		const index = items.indexOf(document.activeElement as HTMLElement);
		const next = items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
		next?.focus();
	};

	const reactions =
		item.kind === "message" && !item.message.recalled && !more ? (
			<div className="react-picker" role="group" aria-label={copy.menu.react}>
				{QUICK_REACTIONS.map((emoji) => (
					<button key={emoji} type="button" aria-label={copy.menu.reactionNames[emoji] ?? emoji} onClick={() => react(emoji)}>
						{emoji}
					</button>
				))}
				<button type="button" className="more-react" aria-label={copy.menu.moreReactions} aria-expanded={false} onClick={() => setMore(true)}>
					<Icon name="plus" />
				</button>
			</div>
		) : null;
	const actions = more ? (
		<EmojiPicker mode="reaction" onPick={react} onClose={close} />
	) : (
		// eslint-disable-next-line jsx-a11y/interactive-supports-focus -- focus sits on the menu items; the menu only receives their arrow keys
		<div className="menu" role="menu" ref={menu} aria-label={mine ? copy.menu.labelMine : copy.menu.label} onKeyDown={onMenuKey}>
			{entries.map((entry) => (
				<MenuButton key={entry.label} entry={entry} onDone={close} />
			))}
		</div>
	);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
		}
	};

	if (from !== null) {
		let bubble: ReactNode;
		if (item.kind === "pending") {
			bubble = <PendingBubble chatId={chatId} itemKey={itemKey} pending={item.pending} chat={chat} tabbable={false} inert />;
		} else {
			bubble = <MessageBubble chatId={chatId} itemKey={itemKey} message={item.message} chat={chat} readOutboxMaxSeq={readOutboxMaxSeq} tabbable={false} inert />;
		}
		return (
			<div
				className="ctx-layer"
				data-phase={phase}
				role="presentation"
				onClick={(event) => {
					if (event.target === event.currentTarget) close();
				}}
				onKeyDown={onKeyDown}
			>
				<div ref={stack} className={mine ? "ctx-stack mine" : "ctx-stack"}>
					{reactions}
					<div className="ctx-message" aria-hidden="true" inert style={{ width: from.width }}>
						{bubble}
					</div>
					{actions}
				</div>
			</div>
		);
	}

	return (
		<div ref={pop} className="ctx-pop" role="presentation" onKeyDown={onKeyDown}>
			{reactions}
			{actions}
		</div>
	);
}

function MenuButton({ entry, onDone }: { entry: MenuEntry; onDone: () => void }) {
	return (
		<>
			{entry.separated === true && <hr />}
			<button
				type="button"
				role="menuitem"
				className={entry.danger === true ? "danger" : undefined}
				onClick={() => {
					onDone();
					entry.run();
				}}
			>
				{typeof entry.icon === "string" ? <Icon name={entry.icon} /> : <Glyph name={entry.icon.glyph} />}
				{entry.label}
			</button>
		</>
	);
}

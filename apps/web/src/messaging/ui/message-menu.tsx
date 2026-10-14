// Message actions (mockups/chat.html#context-menu): a dimmed layer over the
// conversation with the reaction row, the message itself and the menu.
// Opened by right click, long press or the keyboard; Esc closes it.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Chat, StoredMessage } from "@app/core";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { Permission, type Limits } from "../data/remote.ts";
import { useItem, useServices } from "../data/services.tsx";
import { EmojiPicker } from "./emoji-picker.tsx";
import { MessageBubble, PendingBubble } from "./message-item.tsx";
import { copyText } from "./parts.tsx";
import { useUi } from "./ui-context.tsx";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏"] as const;

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
	readonly icon: IconName;
	readonly run: () => void;
	readonly danger?: boolean;
	readonly separated?: boolean;
}

export default function MenuLayer({ chatId, itemKey, chat, readOutboxMaxSeq }: { chatId: number; itemKey: string; chat: Chat | null; readOutboxMaxSeq: number }) {
	const copy = useCopy();
	const ui = useUi();
	const { store, source, remote, backend, toasts } = useServices();
	const item = useItem(chatId, itemKey);
	const menu = useRef<HTMLDivElement>(null);
	const [limits, setLimits] = useState<Limits | null>(null);
	const [more, setMore] = useState(false);

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
		menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, []);

	const close = () => {
		ui.menu.set(null);
		document.querySelector<HTMLElement>(`.messages [data-key="${itemKey}"]`)?.focus();
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
	} else {
		const message = item.message;
		const channel = chat?.type === "channel";
		const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
		const canWrite = !channel || admin;
		if (canWrite) entries.push({ label: copy.menu.reply, icon: "reply", run: () => ui.intents.cell(chatId).set({ mode: "reply", seq: message.seq }) });
		entries.push({ label: copy.menu.forward, icon: "forward", run: () => ui.dialog.set({ kind: "forward", chatId, seq: message.seq }) });
		if (message.text !== "") entries.push(copyEntry);
		if (canEdit(message, store.selfId, limits)) {
			entries.push({ label: copy.menu.edit, icon: "edit", run: () => ui.intents.cell(chatId).set({ mode: "edit", seq: message.seq }) });
		}
		if (canPin(chat)) {
			const pinned = chat?.pinnedSeq === message.seq;
			entries.push({
				label: pinned ? copy.menu.unpin : copy.menu.pin,
				icon: "pin",
				run: () =>
					(pinned ? remote.unpin(chatId, message.seq) : remote.pin(chatId, message.seq)).then(
						() => toasts.show(pinned ? copy.menu.unpinned : copy.menu.pinned),
						failure,
					),
			});
		}
		if (canSeeReaders(message, chat, store.selfId, limits)) {
			entries.push({ label: copy.menu.readBy, icon: "checks", run: () => ui.dialog.set({ kind: "readBy", chatId, seq: message.seq }) });
		}
		if (!mine && backend.features.has("report")) {
			const author = store.user(message.fromId);
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
		if (mine || !channel || admin) {
			entries.push({
				label: mine ? copy.menu.deleteMine : copy.menu.deleteTheirs,
				icon: "trash",
				danger: true,
				separated: true,
				run: () => ui.dialog.set({ kind: "delete", chatId, seq: message.seq, mine }),
			});
		}
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

	let bubble: ReactNode;
	if (item.kind === "pending") {
		bubble = <PendingBubble chatId={chatId} itemKey={itemKey} pending={item.pending} chat={chat} tabbable={false} inert />;
	} else {
		bubble = (
			<MessageBubble chatId={chatId} itemKey={itemKey} message={item.message} chat={chat} readOutboxMaxSeq={readOutboxMaxSeq} tabbable={false} inert />
		);
	}

	return (
		<div
			className={mine ? "ctx-layer mine" : "ctx-layer"}
			onClick={(event) => {
				if (event.target === event.currentTarget) close();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				}
			}}
		>
			{item.kind === "message" && (
				<div className="react-picker" role="group" aria-label={copy.menu.react}>
					{QUICK_REACTIONS.map((emoji) => (
						<button key={emoji} type="button" aria-label={copy.menu.reactionNames[emoji] ?? emoji} onClick={() => react(emoji)}>
							{emoji}
						</button>
					))}
					<span className="emoji-anchor">
						<button type="button" aria-label={copy.menu.moreReactions} aria-expanded={more} onClick={() => setMore((open) => !open)}>
							<Icon name="plus" />
						</button>
						{more && <EmojiPicker onPick={react} onClose={() => setMore(false)} />}
					</span>
				</div>
			)}
			<div className="ctx-message" aria-hidden="true" inert>
				{bubble}
			</div>
			<div className="menu" role="menu" ref={menu} aria-label={mine ? copy.menu.labelMine : copy.menu.label} onKeyDown={onMenuKey}>
				{entries.map((entry) => (
					<MenuButton key={entry.label} entry={entry} onDone={close} />
				))}
			</div>
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
				<Icon name={entry.icon} />
				{entry.label}
			</button>
		</>
	);
}

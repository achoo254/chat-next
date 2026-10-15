// The private chat with a bot (mockups/bots.html): before the first message
// the chat shows the bot's profile and "Bắt đầu" in place of the composer
// (#bot-start); afterwards the composer gets the bot's command menu
// (#commands) and the reply keyboard the bot set (#reply-keyboard). Loaded
// with the first bot chat opened, with its own styles.
import { useEffect, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useItem, useServices, useUser, useWindow } from "../data/services.tsx";
import { messageKey, type WindowItem } from "../data/store.ts";
import { ChatAvatar, DialogHead, Modal, useDomId } from "../ui/parts.tsx";

/** Id of a chat's command menu, which the composer's menu button controls. */
export const BOT_MENU_ID = (chatId: number): string => `bot-cmds-${chatId}`;
import type { BotCommand, BotInfo } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./bot-chat.css";

function useBotInfo(botId: number, chatId: number): BotInfo | null {
	const { bots } = useServices();
	const [info, setInfo] = useState<BotInfo | null>(null);
	useEffect(() => {
		let active = true;
		// Fetched each time the chat opens: the owner may have changed the menu.
		bots.info(botId, chatId).then(
			(found) => {
				if (active) setInfo(found);
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [bots, botId, chatId]);
	return info;
}

/** The bot's profile in its empty chat: description, commands and what starting it means. */
export function BotProfileCard({ botId, chatId }: { botId: number; chatId: number }) {
	const t = useBotsCopy();
	const user = useUser(botId);
	const info = useBotInfo(botId, chatId);
	const name = info?.name ?? user?.name ?? "";
	return (
		<div className="bot-card">
			<ChatAvatar id={botId} name={name} size="lg" bot />
			<h3>{name}</h3>
			{info !== null && info.description !== "" && <p>{info.description}</p>}
			{info !== null && info.commands.length > 0 && (
				<ul>
					{info.commands.map((command) => (
						<li key={command.command}>
							<code>/{command.command}</code>
							<span className="muted">{command.description}</span>
						</li>
					))}
				</ul>
			)}
			<div className="consent-note">
				<Icon name="lock" small />
				<span>{t.start.consent(name)}</span>
			</div>
		</div>
	);
}

/** "Bắt đầu" in place of the composer: consent plus "/start" (StartBot with no parameter). */
export function BotStartBar({ botId }: { botId: number }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const user = useUser(botId);
	const [busy, setBusy] = useState(false);
	const start = async () => {
		setBusy(true);
		try {
			await bots.start(botId, "");
			// The chat fills from the update stream; this bar goes once the message is there.
		} catch {
			toasts.show(copy.common.failed);
			setBusy(false);
		}
	};
	return (
		<div className="start-bar">
			<button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={() => void start()}>
				{busy ? t.start.starting : t.start.start}
			</button>
			<small>{t.start.hint(user?.name ?? "")}</small>
		</div>
	);
}

/** A bot's answer with show_alert (mockups/bots.html#inline-keyboard): a small dialog instead of a toast. */
export function BotAlertDialog({ botId, text, onClose }: { botId: number; text: string; onClose: () => void }) {
	const t = useBotsCopy();
	const user = useUser(botId);
	const id = useDomId("bot-alert");
	return (
		<Modal labelledBy={id} onClose={onClose} className="popup">
			<DialogHead id={id} title={user?.name ?? ""} />
			<div className="dlg-body">
				<p className="alert-text">{text}</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn btn-primary" onClick={onClose}>
					{t.alert.ok}
				</button>
			</div>
		</Modal>
	);
}

/** The bot's newest message with a reply markup, when that markup is a keyboard (not its removal); null otherwise. */
export function activeKeyboard(items: readonly (WindowItem | undefined)[], botId: number): { seq: number; key: string } | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind !== "message") continue;
		const message = item.message;
		if (message.fromId !== botId || message.keyboard === undefined) continue;
		return message.keyboard.kind === "keyboard" ? { seq: message.seq, key: messageKey(message) } : null;
	}
	return null;
}

/** Commands matching what is typed: "/de" keeps /deploy; anything but a bare command shows none. */
export function matchCommands(commands: readonly BotCommand[], text: string, manual: boolean): BotCommand[] {
	if (text === "") return manual ? [...commands] : [];
	if (!text.startsWith("/") || /\s/.test(text)) return [];
	const typed = text.slice(1).split("@")[0]?.toLowerCase() ?? "";
	return commands.filter((command) => command.command.startsWith(typed));
}

/** What the composer draws for the bot layer: its two buttons and the placeholder. */
export interface BotBar {
	/** The command menu button: null without commands, else whether the menu is open. */
	readonly menu: boolean | null;
	/** The keyboard toggle: null without a reply keyboard, else whether it shows. */
	readonly keyboard: boolean | null;
	/** The bot's placeholder while its keyboard shows; null for the composer's own. */
	readonly placeholder: string | null;
}

/** What the composer's buttons and keys call in the bot layer. */
export interface BotActions {
	toggleMenu(): void;
	toggleKeyboard(): void;
	/** Asked first on every key in the text box; true when the menu used the key. */
	onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

export interface BotLayerProps {
	chatId: number;
	botId: number;
	text: string;
	setText: (text: string) => void;
	/** Sends `text` as the user's own message. */
	send: (text: string) => void;
	focus: () => void;
	/** The layer's current state for the composer's buttons (called when it changes). */
	onBar: (bar: BotBar) => void;
	actionsRef: { current: BotActions | null };
}

/** Command menu and reply keyboard around the composer of a private chat with a bot. */
export function BotLayer({ chatId, botId, text, setText, send, focus, onBar, actionsRef }: BotLayerProps) {
	const t = useBotsCopy();
	const { store, source, toasts } = useServices();
	const copy = useCopy();
	const user = useUser(botId);
	const info = useBotInfo(botId, chatId);
	const window_ = useWindow(chatId);
	const [manual, setManual] = useState(false);
	const [closedFor, setClosedFor] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);

	const commands = info?.commands ?? [];
	const matches = closedFor === text ? [] : matchCommands(commands, text, manual);
	const open = matches.length > 0 || (manual && commands.length > 0 && text.startsWith("/") && !/\s/.test(text));
	const index = Math.min(selected, Math.max(0, matches.length - 1));
	const close = () => {
		setManual(false);
		setClosedFor(text);
	};
	const fill = (command: BotCommand) => {
		setText(`/${command.command} `);
		setManual(false);
		focus();
	};

	const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!open || matches.length === 0) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setSelected((index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
			return true;
		}
		const picked = matches[index];
		if (picked === undefined) return false;
		if (event.key === "Tab") {
			event.preventDefault();
			fill(picked);
			return true;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			setText("");
			setManual(false);
			send(`/${picked.command}`);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return true;
		}
		return false;
	};


	const newest = activeKeyboard(window_?.keys.map((key) => store.item(chatId, key)) ?? [], botId);
	// That message as it is now (hidden or shown on this device changes it, not the window's keys).
	const item = useItem(chatId, newest?.key ?? "");
	const keyboard = item?.kind === "message" && item.message.keyboard?.kind === "keyboard" ? item.message.keyboard : null;
	const active = newest !== null && keyboard !== null ? { seq: newest.seq, keyboard } : null;
	// Hidden on this device is kept in the local database (survives a reload).
	const padShown = active !== null && !active.keyboard.hidden;
	const setHidden = (seq: number, hidden: boolean) => {
		source.setKeyboardHidden(chatId, seq, hidden).catch(() => toasts.show(copy.common.failed));
	};
	const name = user?.name ?? "";

	const toggleMenu = () => {
		if (open) close();
		else {
			setClosedFor(null);
			setManual(true);
			if (text === "") setText("/");
			focus();
		}
	};
	const toggleKeyboard = () => {
		if (active !== null) setHidden(active.seq, padShown);
	};
	useLayoutEffect(() => {
		actionsRef.current = { toggleMenu, toggleKeyboard, onKey };
		return () => {
			actionsRef.current = null;
		};
	});

	const menuState = commands.length > 0 ? open : null;
	const keyboardState = active === null ? null : padShown;
	const placeholder = padShown && active.keyboard.placeholder !== "" ? active.keyboard.placeholder : null;
	useLayoutEffect(() => {
		onBar({ menu: menuState, keyboard: keyboardState, placeholder });
	}, [onBar, menuState, keyboardState, placeholder]);
	useLayoutEffect(() => () => onBar({ menu: null, keyboard: null, placeholder: null }), [onBar]);

	return (
		<>
			{open && matches.length > 0 && (
				<div className="cmd-menu">
					<div className="menu-head">
						<Icon name="command" small />
						{t.menu.head}
					</div>
					<ul role="listbox" id={BOT_MENU_ID(chatId)} aria-label={t.menu.button}>
						{matches.map((command, position) => (
							<li
								key={command.command}
								role="option"
								aria-selected={position === index}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => fill(command)}
							>
								<ChatAvatar id={botId} name={name} size="sm" bot />
								<span>
									<span className="cmd">/{command.command}</span>
									<span className="desc">{command.description}</span>
								</span>
							</li>
						))}
					</ul>
					<div className="menu-foot">
						<span>
							<span className="kbd">↑</span> <span className="kbd">↓</span> {t.menu.select}
						</span>
						<span>
							<span className="kbd">Tab</span> {t.menu.fill}
						</span>
						<span>
							<span className="kbd">Enter</span> {t.menu.send}
						</span>
					</div>
				</div>
			)}
			{padShown && (
				<div className="reply-kb" role="group" aria-label={t.keyboard.label(name)}>
					{active.keyboard.rows.map((row, rowIndex) => (
						<div className="reply-row" key={rowIndex}>
							{row.map((label, position) => (
								<button
									key={position}
									type="button"
									onClick={() => {
										if (active.keyboard.oneTime) setHidden(active.seq, true);
										send(label);
									}}
								>
									{label}
								</button>
							))}
						</div>
					))}
				</div>
			)}
		</>
	);
}

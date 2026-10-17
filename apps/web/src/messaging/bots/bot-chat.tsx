// The private chat with a bot (mockups/bots.html): before the first message
// the chat shows the bot's profile and "Bắt đầu" in place of the composer
// (#bot-start); afterwards the composer gets the bot's command menu
// (#commands) and the reply keyboard the bot set (#reply-keyboard). In a
// group the composer gets the command menu of the group's bots (#commands):
// a picked command carries "@username" when the group has more than one
// bot. Loaded with the first bot chat or group opened, with its own styles.
import { useEffect, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { EventKeys, type ReplyKeyboard, type StoredMessage } from "@app/core";
import { cryptoRandomId } from "@app/platform";
import { Icon } from "../../components/icon.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices, useUser } from "../data/services.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "../ui/parts.tsx";

/** Id of a chat's command menu, which the composer's menu button controls. */
export const BOT_MENU_ID = (chatId: number): string => `bot-cmds-${chatId}`;
import type { BotCommand, BotInfo, Bots, ChatMenus } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import "./bot-chat.css";

/** GetBotInfo requests in flight, so the parts of one chat that need it share a single call. */
const infoRequests = new Map<string, Promise<BotInfo>>();

function requestInfo(bots: Bots, botId: number, chatId: number): Promise<BotInfo> {
	const key = `${botId}:${chatId}`;
	let request = infoRequests.get(key);
	if (request === undefined) {
		request = bots.info(botId, chatId);
		infoRequests.set(key, request);
		const forget = () => infoRequests.delete(key);
		request.then(forget, forget);
	}
	return request;
}

interface Fetched {
	readonly key: string;
	readonly value: BotInfo;
}

/**
 * `refreshMs` > 0 asks again at that interval while the viewer owns the bot
 * (the "not running" banner follows it), also after a failed request.
 */
function useFetchedBotInfo(botId: number, chatId: number, refreshMs = 0): Fetched | null {
	const { bots } = useServices();
	const [info, setInfo] = useState<Fetched | null>(null);
	const key = `${botId}:${chatId}`;
	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Unknown until the first answer: a failed first request is retried too.
		let owner: boolean | null = null;
		const again = () => {
			if (active && refreshMs > 0 && owner !== false) timer = setTimeout(load, refreshMs);
		};
		const load = () => {
			// Fetched each time the chat opens: the owner may have changed the menu.
			requestInfo(bots, botId, chatId).then(
				(found) => {
					if (!active) return;
					owner = found.isOwner;
					setInfo({ key: `${botId}:${chatId}`, value: found });
					again();
				},
				() => again(),
			);
		};
		load();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [bots, botId, chatId, refreshMs]);
	return info?.key === key ? info : null;
}

function useBotInfo(botId: number, chatId: number): BotInfo | null {
	return useFetchedBotInfo(botId, chatId)?.value ?? null;
}

const NOT_RUNNING_RECHECK_MS = 30_000;

/**
 * In the owner's private chat with their bot: "Bot chưa chạy" while the bot
 * has not asked for updates lately, with a link to its token and long poll
 * guide in Developer Console (mockups/bots.html#bot-not-running).
 */
export function BotNotRunningBanner({ botId, chatId }: { botId: number; chatId: number }) {
	const t = useBotsCopy();
	const fetched = useFetchedBotInfo(botId, chatId, NOT_RUNNING_RECHECK_MS);
	if (fetched === null || !fetched.value.notRunning) return null;
	return (
		<div className="banner warn" role="status">
			<Icon name="alert" small />
			<span className="grow">{t.owner.notRunning}</span>
			<Link to={paths.consoleBot(botId, "token")}>{t.owner.guide}</Link>
		</div>
	);
}

/** "Quản lý bot" in the bot's info column, for its owner only (mockups/chat.html#info-panels). */
export function BotManageRow({ botId }: { botId: number }) {
	const t = useBotsCopy();
	const info = useBotInfo(botId, 0);
	if (info === null || !info.isOwner) return null;
	return (
		<div className="info-sec">
			<Link to={paths.consoleBot(botId)} className="row link-row">
				<Icon name="settings" />
				<span className="grow">
					{t.owner.manage}
					<small>{t.owner.manageHint}</small>
				</span>
			</Link>
		</div>
	);
}

/** The bot's profile in its empty chat: description, commands and what starting it means. */
export function BotProfileCard({ botId, chatId }: { botId: number; chatId: number }) {
	const t = useBotsCopy();
	const user = useUser(botId);
	const info = useBotInfo(botId, chatId);
	const name = info?.name ?? user?.name ?? "";
	return (
		<div className="bot-card">
			<ChatAvatar id={botId} name={name} size="lg" bot photoOf={botId} photoId={info?.photoId ?? user?.photoId ?? ""} />
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
	// One id for this bar: pressing again after a failure cannot send /start twice.
	const [randomId] = useState(cryptoRandomId);
	const start = async () => {
		setBusy(true);
		try {
			await bots.start(botId, "", randomId);
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

type ShownKeyboard = Extract<ReplyKeyboard, { kind: "keyboard" }>;

/**
 * The reply keyboard the bot set last in this chat, as Telegram keeps it for
 * the whole chat: read from the local database, so jumping to an old message
 * or scrolling far back neither brings back an older keyboard nor drops this
 * one. Read again whenever the chat's messages change (a new markup, hidden
 * or shown on this device). null without one, or when the bot removed it.
 */
function useBotKeyboard(chatId: number, botId: number): { seq: number; keyboard: ShownKeyboard } | null {
	const { source, store } = useServices();
	const [found, setFound] = useState<{ chatId: number; botId: number; message: StoredMessage | null } | null>(null);
	useEffect(() => {
		let active = true;
		let asked = 0;
		const read = () => {
			const ticket = ++asked;
			source.botKeyboard(chatId, botId).then(
				(message) => {
					// Only the newest answer counts: an older read may finish last.
					if (active && ticket === asked) setFound({ chatId, botId, message });
				},
				(err: unknown) => store.reportError(err, `bot keyboard ${chatId}`),
			);
		};
		read();
		const stop = source.events.subscribe(EventKeys.history(chatId), read);
		return () => {
			active = false;
			stop();
		};
	}, [source, store, chatId, botId]);
	const message = found !== null && found.chatId === chatId && found.botId === botId ? found.message : null;
	const keyboard = message?.keyboard;
	return message !== null && keyboard?.kind === "keyboard" ? { seq: message.seq, keyboard } : null;
}

/** Commands matching what is typed: "/de" keeps /deploy; anything but a bare command shows none. */
export function matchCommands<C extends BotCommand>(commands: readonly C[], text: string, manual: boolean): C[] {
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

/** A command the menu offers: what picking it puts in the composer, and the bot it is for. */
export interface MenuEntry extends BotCommand {
	readonly key: string;
	readonly botId: number;
	readonly botName: string;
	/** "/status", or "/status@deploy_bot" in a group with several bots. */
	readonly insert: string;
}

interface CommandMenuState {
	readonly open: boolean;
	readonly matches: readonly MenuEntry[];
	readonly index: number;
	fill(entry: MenuEntry): void;
	toggleMenu(): void;
	onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

/** The command menu's state and keys: typing "/" filters, ↑ ↓ select, Tab fills, Enter sends, Esc closes. */
function useCommandMenu(
	entries: readonly MenuEntry[],
	text: string,
	setText: (text: string) => void,
	send: (text: string) => void,
	focus: () => void,
): CommandMenuState {
	const [manual, setManual] = useState(false);
	const [closedFor, setClosedFor] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const matches = closedFor === text ? [] : matchCommands(entries, text, manual);
	const open = matches.length > 0 || (manual && entries.length > 0 && text.startsWith("/") && !/\s/.test(text));
	const index = Math.min(selected, Math.max(0, matches.length - 1));
	const close = () => {
		setManual(false);
		setClosedFor(text);
	};
	const fill = (entry: MenuEntry) => {
		setText(`${entry.insert} `);
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
			send(picked.insert);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return true;
		}
		return false;
	};
	const toggleMenu = () => {
		if (open) close();
		else {
			setClosedFor(null);
			setManual(true);
			if (text === "") setText("/");
			focus();
		}
	};
	return { open, matches, index, fill, toggleMenu, onKey };
}

/** The list above the composer; `owners` adds the bot's name to each row (groups). */
function CommandMenu({ chatId, menu, head, owners }: { chatId: number; menu: CommandMenuState; head: string; owners: boolean }) {
	const t = useBotsCopy();
	if (!menu.open || menu.matches.length === 0) return null;
	return (
		<div className="cmd-menu">
			<div className="menu-head">
				<Icon name="command" small />
				{head}
			</div>
			<ul role="listbox" id={BOT_MENU_ID(chatId)} aria-label={t.menu.button}>
				{menu.matches.map((entry, position) => (
					<li
						key={entry.key}
						role="option"
						className={owners ? "with-owner" : undefined}
						aria-selected={position === menu.index}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => menu.fill(entry)}
					>
						<ChatAvatar id={entry.botId} name={entry.botName} size="sm" bot />
						<span>
							<span className="cmd">/{entry.command}</span>
							<span className="desc">{entry.description}</span>
						</span>
						{owners && <span className="owner">{entry.botName}</span>}
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
	);
}

/** Command menu and reply keyboard around the composer of a private chat with a bot. */
export function BotLayer({ chatId, botId, text, setText, send, focus, onBar, actionsRef }: BotLayerProps) {
	const t = useBotsCopy();
	const { source, toasts } = useServices();
	const copy = useCopy();
	const user = useUser(botId);
	const info = useBotInfo(botId, chatId);
	const active = useBotKeyboard(chatId, botId);
	const name = user?.name ?? "";
	const entries: MenuEntry[] = (info?.commands ?? []).map((command) => ({
		...command,
		key: command.command,
		botId,
		botName: name,
		insert: `/${command.command}`,
	}));
	const menu = useCommandMenu(entries, text, setText, send, focus);

	// Hidden on this device is kept in the local database (survives a reload).
	const padShown = active !== null && !active.keyboard.hidden;
	const setHidden = (seq: number, hidden: boolean) => {
		source.setKeyboardHidden(chatId, seq, hidden).catch(() => toasts.show(copy.common.failed));
	};

	const toggleKeyboard = () => {
		if (active !== null) setHidden(active.seq, padShown);
	};
	useLayoutEffect(() => {
		actionsRef.current = { toggleMenu: menu.toggleMenu, toggleKeyboard, onKey: menu.onKey };
		return () => {
			actionsRef.current = null;
		};
	});

	const menuState = entries.length > 0 ? menu.open : null;
	const keyboardState = active === null ? null : padShown;
	const placeholder = padShown && active.keyboard.placeholder !== "" ? active.keyboard.placeholder : null;
	useLayoutEffect(() => {
		onBar({ menu: menuState, keyboard: keyboardState, placeholder });
	}, [onBar, menuState, keyboardState, placeholder]);
	useLayoutEffect(() => () => onBar({ menu: null, keyboard: null, placeholder: null }), [onBar]);

	return (
		<>
			<CommandMenu chatId={chatId} menu={menu} head={t.menu.head} owners={false} />
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

/** The commands of a group's bots, "/cmd@username" when the group has more than one bot. */
export function groupEntries(menus: ChatMenus): MenuEntry[] {
	const tagged = menus.botCount > 1;
	return menus.bots.flatMap((bot) =>
		bot.commands.map((command) => ({
			...command,
			key: `${bot.botId}:${command.command}`,
			botId: bot.botId,
			botName: bot.name,
			insert: tagged ? `/${command.command}@${bot.username}` : `/${command.command}`,
		})),
	);
}

export type GroupBotLayerProps = Omit<BotLayerProps, "botId">;

/** The command menu of a group's bots above its composer; nothing when no bot has commands there. */
export function GroupBotLayer({ chatId, text, setText, send, focus, onBar, actionsRef }: GroupBotLayerProps) {
	const t = useBotsCopy();
	const { bots } = useServices();
	const [loaded, setLoaded] = useState<{ chatId: number; entries: MenuEntry[] } | null>(null);
	useEffect(() => {
		let active = true;
		// Asked each time the group opens: bots join, leave and change their menus.
		bots.chatMenus(chatId).then(
			(menus) => {
				if (active) setLoaded({ chatId, entries: groupEntries(menus) });
			},
			() => {
				// No menu then; the composer works as without bots.
			},
		);
		return () => {
			active = false;
		};
	}, [bots, chatId]);
	const entries = loaded !== null && loaded.chatId === chatId ? loaded.entries : NO_ENTRIES;
	const menu = useCommandMenu(entries, text, setText, send, focus);
	useLayoutEffect(() => {
		actionsRef.current = { toggleMenu: menu.toggleMenu, toggleKeyboard: () => {}, onKey: menu.onKey };
		return () => {
			actionsRef.current = null;
		};
	});
	const menuState = entries.length > 0 ? menu.open : null;
	useLayoutEffect(() => {
		onBar({ menu: menuState, keyboard: null, placeholder: null });
	}, [onBar, menuState]);
	useLayoutEffect(() => () => onBar({ menu: null, keyboard: null, placeholder: null }), [onBar]);
	return <CommandMenu chatId={chatId} menu={menu} head={t.menu.groupHead} owners />;
}

const NO_ENTRIES: MenuEntry[] = [];

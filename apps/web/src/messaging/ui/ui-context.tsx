// Screen-level controls shared by the chat screen's parts: which dialog is
// open, what the composer is doing (reply or edit) and the message menu.
// The context value is created once per screen and never changes; the
// changing parts are small external stores read with useSyncExternalStore.
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReportTarget } from "../data/pending-backend.ts";
import type { AddFailure } from "../data/remote.ts";

export type DialogRequest =
	| { readonly kind: "newChat" }
	/** `withUserId`: opened from a profile, that person is picked already (0: nobody). */
	| { readonly kind: "newGroup"; readonly withUserId: number }
	| { readonly kind: "inviteTeam"; readonly chatId: number }
	| { readonly kind: "newChannel" }
	/** `seqs`: every message of an album (the server keeps their files, nothing is uploaded again). */
	| { readonly kind: "forward"; readonly chatId: number; readonly seq: number; readonly seqs?: readonly number[] }
	/** `recall`: your own message, removed for everyone ("Thu hồi"); otherwise hidden for you only. */
	| { readonly kind: "delete"; readonly chatId: number; readonly seq: number; readonly recall: boolean }
	/** Private chat: deleted for you; group or channel: deleted for everyone by its owner. */
	| { readonly kind: "deleteChat"; readonly chatId: number }
	| { readonly kind: "pin"; readonly chatId: number; readonly seq: number }
	/** Every pinned message of a chat, or of a forum topic (topicId 0: the whole chat). */
	| { readonly kind: "pinnedList"; readonly chatId: number; readonly topicId: number }
	/** Who reacted to a message, opened on one emoji. */
	| { readonly kind: "reactors"; readonly chatId: number; readonly seq: number; readonly emoji: string }
	| { readonly kind: "report"; readonly target: ReportTarget; readonly name: string; readonly blockUserId: number }
	| { readonly kind: "profile"; readonly userId: number }
	/** A group's or channel's name, description and photo (#edit-chat). */
	| { readonly kind: "editChat"; readonly chatId: number }
	| { readonly kind: "leave"; readonly chatId: number }
	| { readonly kind: "addMembers"; readonly chatId: number }
	/** `text`: what the message shows for the link ("" when it is the address itself); `fromId`: the sender. */
	| { readonly kind: "link"; readonly url: string; readonly text: string; readonly fromId: number }
	| { readonly kind: "readBy"; readonly chatId: number; readonly seq: number }
	/** People the server did not add, each with the reason, and what still works for them. */
	| {
			readonly kind: "addFailed";
			readonly chatId: number;
			readonly failures: readonly AddFailure[];
			readonly addedIds: readonly number[];
			/** Names shown in the picker, for people GetUsers does not return to you yet. */
			readonly pickedNames: ReadonlyMap<number, string>;
	  }
	| { readonly kind: "members"; readonly chatId: number }
	/** `back`: return to the member list when done. */
	| { readonly kind: "removeMember"; readonly chatId: number; readonly userId: number; readonly back: boolean }
	| { readonly kind: "addContact" }
	/** A bot's answer to a callback button that asked for a dialog (show_alert). */
	| { readonly kind: "botAlert"; readonly botId: number; readonly text: string };

export type ComposerIntent =
	| { readonly mode: "reply"; readonly seq: number }
	| { readonly mode: "edit"; readonly seq: number };

export interface MenuTarget {
	readonly chatId: number;
	readonly key: string;
	/** Opened from the message's "Thả cảm xúc" button: straight to the emoji panel. */
	readonly picker?: boolean;
}

/** A Mini App the user opened (OpenMiniApp answered), shown in the container (bots/mini-app.tsx). */
export interface MiniAppRequest {
	/** New for each opening, so opening again starts the container afresh. */
	readonly id: number;
	readonly botId: number;
	/** The chat and message whose button opened it; seq 0 for the bot's main Mini App. */
	readonly chatId: number;
	readonly seq: number;
	/** Text of the button that opened it; "" for the main Mini App. */
	readonly buttonText: string;
	/** The button's Mini App URL as asked of OpenMiniApp ("" for the main one), to open it again ("Tải lại"). */
	readonly buttonUrl: string;
	/** The https URL to load and the signed init data, from OpenMiniApp. */
	readonly url: string;
	readonly initData: string;
}

/** The one Mini App open on the screen; minimized, it keeps running hidden behind a chip. */
export interface OpenMiniApp {
	readonly request: MiniAppRequest;
	readonly minimized: boolean;
	/** Minimized because the user went to another chat, not by hand: going back to its chat restores it. */
	readonly away?: boolean;
}

/** Closes the Mini App `id`; one opened since (another, or the same reloaded) stays. */
export function closeMiniApp(cell: Cell<OpenMiniApp | null>, id: number): void {
	if (cell.get()?.request.id === id) cell.set(null);
}

/** Minimizes or restores the Mini App `id`, if it is still the open one. */
export function minimizeMiniApp(cell: Cell<OpenMiniApp | null>, id: number, minimized: boolean): void {
	const open = cell.get();
	if (open !== null && open.request.id === id && open.minimized !== minimized) cell.set({ request: open.request, minimized });
}

/**
 * Keeps the Mini App with the chat it was opened from: going to another chat
 * minimizes it to its chip (its main button would otherwise sit beside a chat
 * its data does not go to), and going back to its chat restores it, unless
 * the user minimized it by hand. No chat on the screen (0) changes nothing.
 */
export function followChatOnScreen(cell: Cell<OpenMiniApp | null>, chatId: number): void {
	const open = cell.get();
	if (open === null || chatId === 0) return;
	const own = open.request.chatId === chatId;
	if (!own && !open.minimized) cell.set({ request: open.request, minimized: true, away: true });
	else if (own && open.minimized && open.away === true) cell.set({ request: open.request, minimized: false });
}

/** The chat list's row menu (mockups/chat.html#list-menu), opened at a point of the viewport. */
export interface ListMenuTarget {
	readonly chatId: number;
	readonly x: number;
	readonly y: number;
}

/** A value with subscribers, for state several distant components read. */
export class Cell<T> {
	private readonly listeners = new Set<() => void>();

	constructor(private value: T) {}

	get = (): T => this.value;

	set(value: T): void {
		if (Object.is(value, this.value)) return;
		this.value = value;
		for (const listener of [...this.listeners]) listener();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

/** Reply/edit state per chat, so switching chats keeps each composer's intent. */
export class ComposerIntents {
	private readonly cells = new Map<number, Cell<ComposerIntent | null>>();

	cell(chatId: number): Cell<ComposerIntent | null> {
		let cell = this.cells.get(chatId);
		if (cell === undefined) {
			cell = new Cell<ComposerIntent | null>(null);
			this.cells.set(chatId, cell);
		}
		return cell;
	}
}

export interface Ui {
	readonly dialog: Cell<DialogRequest | null>;
	readonly menu: Cell<MenuTarget | null>;
	readonly listMenu: Cell<ListMenuTarget | null>;
	readonly miniApp: Cell<OpenMiniApp | null>;
	readonly intents: ComposerIntents;
	/** Focuses the search box of the chat list (⌘K, header search button). */
	readonly focusSearch: () => void;
	readonly toggleInfo: (open?: boolean) => void;
}

export const UiContext = createContext<Ui | null>(null);

/**
 * Opens the open conversation's in-chat search with a query (a tapped
 * #hashtag). Provided by the conversation; null elsewhere (dialogs, other
 * screens), where hashtags stay plain.
 */
export const ChatSearchContext = createContext<((query: string) => void) | null>(null);

export function useUi(): Ui {
	const ui = useContext(UiContext);
	if (ui === null) throw new Error("useUi must be used inside <UiContext>");
	return ui;
}

export function useCell<T>(cell: Cell<T>): T {
	return useSyncExternalStore(cell.subscribe, cell.get);
}

export function useIntent(chatId: number): ComposerIntent | null {
	const ui = useUi();
	const cell = ui.intents.cell(chatId);
	const subscribe = useCallback((listener: () => void) => cell.subscribe(listener), [cell]);
	return useSyncExternalStore(subscribe, cell.get);
}

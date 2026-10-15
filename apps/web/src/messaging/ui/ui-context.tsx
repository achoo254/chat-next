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
	| { readonly kind: "addContact" };

export type ComposerIntent =
	| { readonly mode: "reply"; readonly seq: number }
	| { readonly mode: "edit"; readonly seq: number };

export interface MenuTarget {
	readonly chatId: number;
	readonly key: string;
	/** Opened from the message's "Thả cảm xúc" button: straight to the emoji panel. */
	readonly picker?: boolean;
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
	readonly intents: ComposerIntents;
	/** Focuses the search box of the chat list (⌘K, header search button). */
	readonly focusSearch: () => void;
	readonly toggleInfo: (open?: boolean) => void;
}

export const UiContext = createContext<Ui | null>(null);

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

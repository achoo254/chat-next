// The selection mode of the open chat (selection-actions.ts does the selecting): read by
// every message on screen, so this part stays small and in the first chunk.
import { useCallback, useSyncExternalStore } from "react";
import { useUi, type MessageSelection } from "./ui-context.tsx";

/** The selection of `chatId`; null when that chat is not selecting. */
export function useSelection(chatId: number): MessageSelection | null {
	const ui = useUi();
	const cell = ui.selection;
	const get = useCallback(() => {
		const value = cell.get();
		return value !== null && value.chatId === chatId ? value : null;
	}, [cell, chatId]);
	return useSyncExternalStore(cell.subscribe, get);
}

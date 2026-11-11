// "Phát âm thanh khi đang mở chat" (settings.html#notifications, kept on this
// device): a message from someone else arriving in the open chat, while the
// page is visible, plays the app's tone at the user's sound setting, unless
// it was posted silently. The core shows no notification for that chat
// then, so nothing plays twice.
import { useEffect, useRef } from "react";
import { useSoundInChat } from "../data/device-settings.ts";
import { useNotificationSettings, useServices, useWindow } from "../data/services.tsx";
import { useSurface, type Surface } from "./surface.ts";

export function useIncomingSound(chatId: number): void {
	const surface = useSurface();
	const { store, self } = useServices();
	const enabled = useSoundInChat(self.id);
	const { sound } = useNotificationSettings();
	const window = useWindow(chatId);
	const newest = useRef<{ chatId: number; seq: number } | null>(null);

	useEffect(() => {
		if (window === undefined || window.status !== "ready" || !window.live) return;
		const items = store.items(chatId);
		let latest = null;
		for (let i = items.length - 1; i >= 0 && latest === null; i--) {
			const item = items[i];
			if (item?.kind === "message") latest = item.message;
		}
		if (latest === null) return;
		const previous = newest.current;
		newest.current = { chatId, seq: latest.seq };
		// The first look at a chat only notes where it ends.
		if (previous === null || previous.chatId !== chatId || latest.seq <= previous.seq) return;
		// Silent messages (webhooks posting without a notification) never play the tone.
		if (!enabled || latest.fromId === store.selfId || latest.action !== null || latest.silent || silent(surface)) return;
		void import("../data/sound.ts").then((module) => module.playTone(sound));
	}, [store, chatId, window, enabled, sound, surface]);
}

/**
 * The page and the compact window can show the same chat at once; only one of
 * them plays the tone: the page when it is shown, the compact window when the
 * page is hidden behind it.
 */
function silent(surface: Surface): boolean {
	if (surface.document.visibilityState === "hidden") return true;
	const pageHidden = document.visibilityState === "hidden";
	return surface.compact ? !pageHidden : pageHidden;
}

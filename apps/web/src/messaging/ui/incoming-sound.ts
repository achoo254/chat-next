// "Phát âm thanh khi đang mở chat" (settings.html#notifications, kept on this
// device): a message from someone else arriving in the open chat, while the
// page is visible, plays the app's tone at the user's sound setting, unless
// it was posted silently. The core shows no notification for that chat
// then, so nothing plays twice.
import { useEffect, useRef } from "react";
import { useSoundInChat } from "../data/device-settings.ts";
import { useNotificationSettings, useServices, useWindow } from "../data/services.tsx";

export function useIncomingSound(chatId: number): void {
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
		if (!enabled || latest.fromId === store.selfId || latest.action !== null || latest.silent || document.visibilityState === "hidden") return;
		void import("../data/sound.ts").then((module) => module.playTone(sound));
	}, [store, chatId, window, enabled, sound]);
}

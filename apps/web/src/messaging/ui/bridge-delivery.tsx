// Where the messages of a chat that sends on to another app (Chat Bridge, ADR
// 0022) are on their way: sending, failed, or of unknown result. The server
// lists what is not finished; a message that is not listed was sent. The bridge
// client is loaded on demand, so a chat that is not connected costs no more than
// one status call a minute (see settings/bridge-delivery.ts).
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useServices } from "../data/services.tsx";
import type { BridgeOutboxItem } from "../settings/bridge-api.ts";

/** How often the outbox of an open two-way chat is looked at. */
const POLL_MS = 2500;

export interface BridgeDelivery {
	/** The app the chat sends to ("telegram"). */
	readonly app: string;
	/** What is not finished, by message. */
	readonly items: ReadonlyMap<number, readonly BridgeOutboxItem[]>;
	readonly retry: (seq: number) => void;
	readonly dismiss: (seq: number) => void;
}

export const BridgeDeliveryContext = createContext<BridgeDelivery | null>(null);

/** How the app is named to the user. */
export const bridgeAppName = (app: string): string => (app === "telegram" ? "Telegram" : app);

/** The unfinished item of a message that matters most: a send first, then an edit, then a delete. */
export function itemOf(delivery: BridgeDelivery | null, seq: number): BridgeOutboxItem | null {
	const items = delivery?.items.get(seq);
	if (items === undefined || items.length === 0) return null;
	return items.find((i) => i.op === "send") ?? items.find((i) => i.op === "edit") ?? items[0] ?? null;
}

/** The delivery state of `chatId`, or null when it does not send on to another app. */
export function useBridgeDelivery(chatId: number): BridgeDelivery | null {
	const { transport } = useServices();
	const [state, setState] = useState<{ readonly chatId: number; readonly app: string; readonly items: ReadonlyMap<number, readonly BridgeOutboxItem[]> } | null>(null);
	const refreshRef = useRef<() => void>(() => undefined);
	const retryRef = useRef<(seq: number) => void>(() => undefined);
	const dismissRef = useRef<(seq: number) => void>(() => undefined);

	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const start = async () => {
			const { twoWayChats, bridgeClient } = await import("../settings/bridge-delivery.ts");
			const app = (await twoWayChats(transport)).get(chatId);
			if (!alive || app === undefined) return;
			const api = bridgeClient(transport);
			const look = async () => {
				clearTimeout(timer);
				if (document.visibilityState === "visible") {
					try {
						const list = await api.outbox(chatId);
						if (!alive) return;
						const items = new Map<number, BridgeOutboxItem[]>();
						for (const item of list) items.set(item.seq, [...(items.get(item.seq) ?? []), item]);
						setState({ chatId, app, items });
					} catch {
						// The next look tries again; a server that cannot answer shows no state, never a wrong one.
					}
				}
				if (alive) timer = setTimeout(() => void look(), POLL_MS);
			};
			refreshRef.current = () => void look();
			retryRef.current = (seq) => void api.retry(chatId, seq).then(() => look(), () => look());
			dismissRef.current = (seq) => void api.dismiss(chatId, seq).then(() => look(), () => look());
			await look();
		};
		void start();
		return () => {
			alive = false;
			clearTimeout(timer);
			refreshRef.current = () => undefined;
		};
	}, [chatId, transport]);

	if (state === null || state.chatId !== chatId) return null;
	return { app: state.app, items: state.items, retry: (seq) => retryRef.current(seq), dismiss: (seq) => dismissRef.current(seq) };
}

/** The delivery context of the chat being shown. */
export function useDeliveryContext(): BridgeDelivery | null {
	return useContext(BridgeDeliveryContext);
}

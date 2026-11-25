// Where the messages of a chat that sends on to another app (Chat Bridge, ADR
// 0022) are on their way: sending, failed, or of unknown result. The server lists
// what is not finished; a message that is not listed was sent. Only this small
// part is in the startup chunk: the watcher that asks the server
// (bridge-delivery-watch.ts) and what is drawn (bridge-message-state.tsx) load on
// demand, and a chat that is not connected costs one status call a minute.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { appName } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import type { BridgeOutboxItem } from "../settings/bridge-api.ts";
import type { DeliveryState, DeliveryWatch } from "./bridge-delivery-watch.ts";

export interface BridgeDelivery extends DeliveryState {
	readonly retry: (seq: number) => void;
	readonly dismiss: (seq: number) => void;
}

/** The one chunk with everything a connected chat needs beyond this file: the watcher and what is drawn. */
export const bridgeChunk = () => import("./bridge-message-state.tsx");

export const BridgeDeliveryContext = createContext<BridgeDelivery | null>(null);

/** How the app is named to the user. */
export const bridgeAppName = appName;

/** The unfinished item of a message that matters most: a send first, then an edit, then a delete. */
export function itemOf(delivery: BridgeDelivery | null, seq: number): BridgeOutboxItem | null {
	"use no memo";
	const items = delivery?.items.get(seq);
	if (items === undefined || items.length === 0) return null;
	return items.find((i) => i.op === "send") ?? items.find((i) => i.op === "edit") ?? items[0] ?? null;
}

/** The delivery state of `chatId`, or null when it does not send on to another app. */
export function useBridgeDelivery(chatId: number): BridgeDelivery | null {
	"use no memo";
	const { transport } = useServices();
	const [state, setState] = useState<{ readonly chatId: number; readonly value: DeliveryState } | null>(null);
	const watch = useRef<DeliveryWatch | null>(null);
	useEffect(() => {
		let alive = true;
		void bridgeChunk()
			.then((m) => m.watchDelivery(transport, chatId, (value) => alive && setState({ chatId, value })))
			.then((started) => {
				if (alive) watch.current = started;
				else started?.stop();
			});
		return () => {
			alive = false;
			watch.current?.stop();
			watch.current = null;
		};
	}, [chatId, transport]);
	if (state === null || state.chatId !== chatId) return null;
	return { ...state.value, retry: (seq) => watch.current?.retry(seq), dismiss: (seq) => watch.current?.dismiss(seq) };
}

/** The delivery context of the chat being shown. */
export function useDeliveryContext(): BridgeDelivery | null {
	"use no memo";
	return useContext(BridgeDeliveryContext);
}

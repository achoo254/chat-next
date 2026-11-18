// The watcher behind useBridgeDelivery (bridge-delivery.tsx): finds out whether a
// chat sends on to another app and, if it does, keeps asking the server what it
// has queued. Loaded on demand, so the code that polls and calls the bridge never
// weighs on the startup chunk.
import type { Transport } from "@connectrpc/connect";
import type { BridgeOutboxItem } from "../settings/bridge-api.ts";
import { bridgeClient, twoWayChats } from "../settings/bridge-delivery.ts";

/** How often the outbox of an open two-way chat is looked at. */
const POLL_MS = 2500;

export interface DeliveryState {
	readonly app: string;
	readonly items: ReadonlyMap<number, readonly BridgeOutboxItem[]>;
}

export interface DeliveryWatch {
	readonly stop: () => void;
	readonly retry: (seq: number) => void;
	readonly dismiss: (seq: number) => void;
}

/** Starts watching `chatId`; null when the chat does not send on to another app (or the bridge is off). */
export async function watchDelivery(transport: Transport, chatId: number, onState: (state: DeliveryState) => void): Promise<DeliveryWatch | null> {
	const app = (await twoWayChats(transport)).get(chatId);
	if (app === undefined) return null;
	const api = bridgeClient(transport);
	let alive = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const look = async (): Promise<void> => {
		clearTimeout(timer);
		if (document.visibilityState === "visible") {
			try {
				const list = await api.outbox(chatId);
				if (!alive) return;
				const items = new Map<number, BridgeOutboxItem[]>();
				for (const item of list) items.set(item.seq, [...(items.get(item.seq) ?? []), item]);
				onState({ app, items });
			} catch {
				// The next look tries again; a server that cannot answer shows no state, never a wrong one.
			}
		}
		if (alive) timer = setTimeout(() => void look(), POLL_MS);
	};
	void look();
	return {
		stop: () => {
			alive = false;
			clearTimeout(timer);
		},
		retry: (seq) => void api.retry(chatId, seq).then(look, look),
		dismiss: (seq) => void api.dismiss(chatId, seq).then(look, look),
	};
}

// What the merged screen knows of each of a person's chats before sending
// (ADR 0025): whether it takes messages and, if not, why; and the date of its
// newest message, which picks the first target. A read-only copy or a closed
// chat is known from the chat itself; the account of the other app (needing
// a login, stopped) and whether the app sends messages at all come from the
// bridge, asked once when the screen opens. This only informs: nothing here
// stops a send, and a bridge that cannot answer leaves the chats as they are.
import type { Transport } from "@connectrpc/connect";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useServices } from "../data/services.tsx";
import type { ChatStore } from "../data/store.ts";
import type { PersonMember } from "./people-api.ts";
import type { SendTarget, TargetReason } from "./send-targets.ts";

interface ChatFacts {
	readonly chatId: number;
	readonly app: string;
	readonly reason: TargetReason | null;
	readonly date: number;
}

/** What the chat itself says about sending there, and its newest message's date. */
function chatFacts(store: ChatStore, chatId: number, app: string): ChatFacts {
	const chat = store.chat(chatId) ?? null;
	const view = store.dialog(chatId);
	const closed = chat?.left === true || view?.peer?.deleted === true;
	const reason: TargetReason | null = chat?.externalSource !== undefined ? "readOnly" : closed ? "closed" : null;
	return { chatId, app, reason, date: view?.topMessage?.date ?? 0 };
}

/** What the bridge says about the chats it sends on for: their account's state, or that the app does not send. */
async function bridgeReasons(transport: Transport, chatIds: readonly number[]): Promise<Map<number, TargetReason>> {
	const { bridgeClient } = await import("../settings/bridge-delivery.ts");
	const api = bridgeClient(transport);
	const reasons = new Map<number, TargetReason>();
	const status = await api.status();
	for (const account of status.accounts) {
		for (const chat of account.chats) {
			if (!chatIds.includes(chat.chatId)) continue;
			if (account.status === "needs_login") reasons.set(chat.chatId, "needsLogin");
			else if (account.status === "stopped") reasons.set(chat.chatId, "stopped");
			else if (chat.direction !== "both") reasons.set(chat.chatId, "noSend");
			else {
				const features = await api.features(account.id, chat.conversationId).catch(() => []);
				if (features.some((feature) => feature.feature === "messages" && !feature.canSend)) reasons.set(chat.chatId, "noSend");
			}
		}
	}
	return reasons;
}

export interface PersonTargets {
	/** The person's private chats, in the order of their identities. */
	readonly targets: readonly SendTarget[];
	/** The date of each chat's newest message (0: none known). */
	readonly dates: ReadonlyMap<number, number>;
}

/** The person's chats as send targets, kept up to date with the chats and their newest messages. */
export function usePersonTargets(members: readonly PersonMember[]): PersonTargets {
	// The snapshot reads the store's current chats: the compiler must not cache it.
	"use no memo";
	const { store, transport } = useServices();
	const pairs = members.filter((member) => member.chatId !== 0).map((member) => [member.chatId, member.app] as const);
	const ids = pairs.map(([chatId]) => chatId).join(",");
	const subscribe = useMemo(
		() => (listener: () => void) => {
			const stops = ids === "" ? [] : ids.split(",").flatMap((id) => [store.subscribe(`chat:${id}`, listener), store.subscribe(`dialog:${id}`, listener)]);
			return () => {
				for (const stop of stops) stop();
			};
		},
		[store, ids],
	);
	// One string that changes only when what matters does, so the snapshot is stable between renders.
	const snapshot = useSyncExternalStore(subscribe, () => JSON.stringify(pairs.map(([chatId, app]) => chatFacts(store, chatId, app))));
	const [bridge, setBridge] = useState<{ readonly ids: string; readonly reasons: ReadonlyMap<number, TargetReason> } | null>(null);

	useEffect(() => {
		if (ids === "") return;
		for (const id of ids.split(",")) store.ensureChat(Number(id));
		let live = true;
		bridgeReasons(
			transport,
			ids.split(",").map((id) => Number(id)),
		).then(
			(reasons) => {
				if (live) setBridge({ ids, reasons });
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [store, transport, ids]);

	return useMemo(() => {
		const facts: unknown = JSON.parse(snapshot);
		const list = Array.isArray(facts) ? (facts as ChatFacts[]) : [];
		const extra = bridge !== null && bridge.ids === ids ? bridge.reasons : null;
		return {
			targets: list.map((fact) => ({ chatId: fact.chatId, app: fact.app, reason: fact.reason ?? extra?.get(fact.chatId) ?? null })),
			dates: new Map(list.map((fact) => [fact.chatId, fact.date])),
		};
	}, [snapshot, bridge, ids]);
}

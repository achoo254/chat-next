// Where the messages of each of a person's chats are on their way to the other
// app (Chat Bridge, ADR 0022), for the merged timeline: one watcher per chat,
// started once for the screen, so a row shows the "sending", "failed" or
// "unknown" mark of its own chat as it does on that chat's screen. A chat that
// does not send on to another app has none and its rows show no mark.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BridgeDeliveryContext, useBridgeDelivery, type BridgeDelivery } from "../ui/bridge-delivery.tsx";

const DeliveryByChat = createContext<ReadonlyMap<number, BridgeDelivery>>(new Map());

/** Watches one chat and reports its delivery state up whenever the unfinished items change. */
function Watch({ chatId, publish }: { chatId: number; publish: (chatId: number, delivery: BridgeDelivery | null) => void }) {
	"use no memo";
	const delivery = useBridgeDelivery(chatId);
	const items = delivery?.items;
	useEffect(() => {
		publish(chatId, delivery);
		// `delivery` is a new object each render; its items change only with the state.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatId, items, delivery === null]);
	useEffect(() => () => publish(chatId, null), [chatId, publish]);
	return null;
}

export function DeliveryHub({ chatIds, children }: { chatIds: readonly number[]; children: ReactNode }) {
	"use no memo";
	const [byChat, setByChat] = useState<ReadonlyMap<number, BridgeDelivery>>(new Map());
	const publish = useState(() => (chatId: number, delivery: BridgeDelivery | null) => {
		setByChat((current) => {
			if ((current.get(chatId) ?? null) === delivery) return current;
			const next = new Map(current);
			if (delivery === null) next.delete(chatId);
			else next.set(chatId, delivery);
			return next;
		});
	})[0];
	return (
		<DeliveryByChat.Provider value={byChat}>
			{chatIds.map((chatId) => (
				<Watch key={chatId} chatId={chatId} publish={publish} />
			))}
			{children}
		</DeliveryByChat.Provider>
	);
}

/** Gives its children the delivery state of `chatId`, as that chat's own screen does. */
export function ChatDelivery({ chatId, children }: { chatId: number; children: ReactNode }) {
	"use no memo";
	const delivery = useContext(DeliveryByChat).get(chatId) ?? null;
	return <BridgeDeliveryContext.Provider value={delivery}>{children}</BridgeDeliveryContext.Provider>;
}

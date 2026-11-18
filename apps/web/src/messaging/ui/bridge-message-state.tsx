// What a message of a chat that sends on to another app (Chat Bridge, ADR 0022)
// says about its way there: the mark on its time line, the row under a failed one,
// and the note above the composer. Loaded on demand (only a connected chat needs
// it), with its own copy, so none of it weighs on the startup chunk.
import { useEffect } from "react";
import type { BridgeOutboxItem } from "../settings/bridge-api.ts";
import { useBridgeCopy } from "../settings/use-bridge-copy.ts";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { bridgeAppName, itemOf, useDeliveryContext } from "./bridge-delivery.tsx";
import { LabelledIcon } from "./chat-row.tsx";
import { Icon } from "../../components/icon.tsx";

export { watchDelivery } from "./bridge-delivery-watch.ts";

type Copy = ReturnType<typeof useBridgeCopy>["delivery"];

/** The feature a refused change belongs to, for the notice. */
const STATE_OP_FEATURE: Partial<Record<BridgeOutboxItem["op"], string>> = {
	set_topic: "topics",
	set_info: "info",
	set_mute: "notify",
	set_dialog_pin: "dialog",
	set_unread_mark: "dialog",
};

const unfinished = (item: BridgeOutboxItem): boolean => item.status === "failed" || item.status === "unknown";

/** What a message that did not go out says, for the time line and the row under it. */
function noteOf(t: Copy, item: BridgeOutboxItem, app: string): string {
	if (item.status === "unknown") return t.unknown(app);
	return item.op === "send" ? t.failed(app) : t.editFailed(app);
}

/** The mark that replaces the "sent" tick while a message is on its way or did not go out. */
export function BridgeStamp({ item, app }: { item: BridgeOutboxItem; app: string }) {
	"use no memo";
	const t = useBridgeCopy().delivery;
	const name = bridgeAppName(app);
	return unfinished(item) ? (
		<LabelledIcon name="alert" label={noteOf(t, item, name)} className="fail" />
	) : (
		<LabelledIcon name="clock" label={t.sending(name)} />
	);
}

/** The row under a message that failed or whose result is unknown: why, and what to do (resend; delete a send, dismiss an edit). */
export function BridgeFailedRow({ chatId, seq }: { chatId: number; seq: number }) {
	"use no memo";
	const t = useBridgeCopy().delivery;
	const copy = useCopy();
	const { source, toasts } = useServices();
	const delivery = useDeliveryContext();
	const item = itemOf(delivery, seq);
	if (delivery === null || item === null || !unfinished(item)) return null;
	return (
		<div className="failed-row" role="status">
			{noteOf(t, item, bridgeAppName(delivery.app))}
			<button type="button" className="btn btn-sm" onClick={() => delivery.retry(seq)}>
				{t.resend}
			</button>
			{item.op === "send" ? (
				<button
					type="button"
					className="btn btn-sm btn-quiet"
					onClick={() => {
						source.deleteMessages(chatId, [seq], true).catch(() => toasts.show(copy.common.failed));
					}}
				>
					{t.discard}
				</button>
			) : (
				<button type="button" className="btn btn-sm btn-quiet" onClick={() => delivery.dismiss(seq)}>
					{t.dismiss}
				</button>
			)}
		</div>
	);
}

/** The line above the composer of a chat that sends on; it also tells, once, a pin the app refused. */
export function BridgeNote({ app, refused }: { app: string; refused: readonly BridgeOutboxItem[] }) {
	"use no memo";
	const copy = useBridgeCopy();
	const t = copy.delivery;
	const { toasts } = useServices();
	useEffect(() => {
		for (const item of refused) {
			const app_ = bridgeAppName(app);
			if (item.op === "pin_message" || item.op === "pin_topic") toasts.show(t.pinRefused(app_, item.op === "pin_topic"));
			else toasts.show(t.changeRefused(app_, copy.features.name[STATE_OP_FEATURE[item.op] ?? ""] ?? STATE_OP_FEATURE[item.op] ?? ""));
		}
	}, [refused, toasts, t, copy, app]);
	return (
		<p className="bridge-note" role="note">
			<Icon name="info" small />
			{t.note(bridgeAppName(app))}
		</p>
	);
}

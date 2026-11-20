// One message of a person's merged timeline (ADR 0025) and its menu. The
// messages are not in the store's windows, so each row hands its message to
// the shared bubble itself, with the app it came through in words and the
// limited actions of this screen; every action goes to the message's chat.
import { Suspense, lazy, memo, useEffect } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useChat, useDialog } from "../data/services.tsx";
import { appLabel } from "../ui/link-suggestions.tsx";
import { MessageBubble, PendingBubble, type LimitedActions } from "../ui/message-item.tsx";
import { useCell, useUi } from "../ui/ui-context.tsx";
import type { MergedItem } from "./merged-timeline.ts";

// The same chunks the chat screen loads for service lines and the message menu.
const SystemLine = lazy(() => import("../ui/message-extras.tsx").then((m) => ({ default: m.SystemLine })));
const MenuLayer = lazy(() => import("../ui/message-menu.tsx"));

interface MergedRowProps {
	item: MergedItem;
	tabbable: boolean;
	runPrev: boolean;
	runNext: boolean;
	limited: LimitedActions;
}

/** A message, a send on its way or a service line, from one of the person's chats. */
export const MergedRow = memo(function MergedRow({ item, tabbable, runPrev, runNext, limited }: MergedRowProps) {
	const copy = useScreensCopy();
	const chat = useChat(item.chatId) ?? null;
	const readOutboxMaxSeq = useDialog(item.chatId)?.dialog.readOutboxMaxSeq ?? 0;
	const platform = appLabel(item.app, copy);
	if (item.kind === "pending") {
		return (
			<PendingBubble
				chatId={item.chatId}
				itemKey={item.key}
				pending={item.pending}
				chat={chat}
				tabbable={tabbable}
				runPrev={runPrev}
				runNext={runNext}
				platform={platform}
			/>
		);
	}
	if (item.message.action !== null) {
		return (
			<Suspense fallback={<span className="system" aria-hidden="true">{" "}</span>}>
				<SystemLine message={item.message} channel={false} />
			</Suspense>
		);
	}
	return (
		<MessageBubble
			chatId={item.chatId}
			itemKey={item.key}
			message={item.message}
			chat={chat}
			readOutboxMaxSeq={readOutboxMaxSeq}
			tabbable={tabbable}
			runPrev={runPrev}
			runNext={runNext}
			platform={platform}
			limited={limited}
		/>
	);
});

/** The menu of the message it was opened on, when that message is on this timeline; closed when the screen goes. */
export function MergedMenu({ items, limited }: { items: ReadonlyMap<string, MergedItem>; limited: LimitedActions }) {
	const ui = useUi();
	const target = useCell(ui.menu);
	const item = target === null ? undefined : items.get(target.key);
	const chatId = item?.chatId ?? 0;
	const chat = useChat(chatId) ?? null;
	const readOutboxMaxSeq = useDialog(chatId)?.dialog.readOutboxMaxSeq ?? 0;
	useEffect(() => () => ui.menu.set(null), [ui]);
	if (target === null || item === undefined) return null;
	return (
		<Suspense fallback={null}>
			<MenuLayer
				key={`${target.key}:${target.picker === true ? 1 : 0}:${target.anchor.left}:${target.anchor.top}`}
				chatId={item.chatId}
				itemKey={target.key}
				chat={chat}
				picker={target.picker === true}
				anchor={target.anchor}
				readOutboxMaxSeq={readOutboxMaxSeq}
				item={item}
				limited={limited}
			/>
		</Suspense>
	);
}

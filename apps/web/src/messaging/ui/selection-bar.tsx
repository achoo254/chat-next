// The bar that stands in for the composer while messages are selected (selection.ts): how
// many, and what can be done to them all. Each action is the one of a message's menu, over
// every selected message, so a chat synced with another app follows as for one message
// (a forward into Telegram is a real forward there, an unsend unsends there too).
import { useEffect } from "react";
import type { StoredMessage } from "@achoo254/chat-core";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { fullDate, isSavedChat } from "../data/format.ts";
import { useChat, useServices } from "../data/services.tsx";
import type { WindowItem } from "../data/store.ts";
import { useNameOf } from "./chat-row.tsx";
import { copyText } from "./parts.tsx";
import { useUi, type MessageSelection } from "./ui-context.tsx";

/** The selected messages this device holds, oldest first. */
function selectedMessages(items: readonly WindowItem[], seqs: readonly number[]): StoredMessage[] {
	const wanted = new Set(seqs);
	return items.flatMap((item) => (item.kind === "message" && wanted.has(item.message.seq) ? [item.message] : []));
}

export default function SelectionBar({ selection }: { selection: MessageSelection }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const ui = useUi();
	const { store, source, remote, toasts } = useServices();
	const { chatId, seqs } = selection;
	const chat = useChat(chatId);
	const messages = selectedMessages(store.items(chatId), seqs);
	const nameOf = useNameOf(messages.map((message) => message.fromId));
	const t = copy.selection;
	const done = () => ui.selection.set(null);
	const failure = () => toasts.show(copy.common.failed);

	// Esc ends selecting, as in Telegram, unless a dialog or menu is open over it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || ui.dialog.get() !== null || ui.menu.get() !== null) return;
			event.preventDefault();
			ui.selection.set(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ui]);

	const live = messages.filter((message) => !message.recalled);
	const texts = live.filter((message) => message.text !== "");
	const media = live.filter((message) => message.media !== undefined);
	const channel = chat?.type === "channel";
	// Unsend is offered only when every message is your own, as in a message's menu.
	const allMine = messages.length > 0 && messages.every((message) => message.fromId === store.selfId && !message.recalled);
	const senderOf = (message: StoredMessage) => (channel ? (chat?.title ?? "") : nameOf(message.fromId));

	const actions: { label: string; icon: IconName; run: () => void; hidden?: boolean }[] = [
		{
			label: t.forward,
			icon: "forward",
			hidden: live.length === 0,
			run: () => {
				const ids = live.map((message) => message.seq);
				ui.dialog.set({ kind: "forward", chatId, seq: ids[0] ?? 0, seqs: ids });
			},
		},
		{
			label: t.saveToCloud,
			icon: "cloud",
			hidden: live.length === 0 || isSavedChat(chat, null),
			run: () => {
				const ids = live.map((message) => message.seq);
				remote
					.createPrivate(store.selfId)
					.then((saved) => remote.forward(chatId, ids, saved))
					.then(() => {
						toasts.show(copy.menu.savedToCloud);
						done();
					}, failure);
			},
		},
		{
			label: t.copy,
			icon: "copy",
			hidden: texts.length === 0,
			run: () => {
				// One message is its text; several carry who sent each and when, as Telegram copies them.
				const text =
					texts.length === 1
						? (texts[0]?.text ?? "")
						: texts.map((message) => `${senderOf(message)}, [${fullDate(message.date, locale)}]\n${message.text}`).join("\n\n");
				void copyText(text).then((ok) => {
					toasts.show(ok ? t.copied(texts.length) : copy.common.failed);
					if (ok) done();
				});
			},
		},
		{
			label: t.download,
			icon: "download",
			hidden: media.length === 0,
			run: () => {
				toasts.show(copy.menu.downloading);
				void import("../media/download.ts").then(async ({ downloadMedia }) => {
					for (const message of media) {
						if (message.media === undefined) continue;
						const ok = await downloadMedia(source, chatId, message.seq, message.media).catch(() => false);
						if (!ok) toasts.show(copy.menu.mediaGone);
					}
				}, failure);
			},
		},
		{
			label: t.delete,
			icon: "trash",
			run: () => {
				const ids = messages.map((message) => message.seq);
				ui.dialog.set({ kind: "delete", chatId, seq: ids[0] ?? 0, seqs: ids, recall: allMine });
			},
		},
	];

	return (
		<div className="selection-bar" role="toolbar" aria-label={t.label}>
			<button type="button" className="icon-btn" aria-label={t.cancel} title={t.cancel} onClick={done}>
				<Icon name="x" />
			</button>
			<span className="grow selection-count" aria-live="polite">
				{t.count(seqs.length)}
			</span>
			{actions
				.filter((action) => action.hidden !== true)
				.map((action) => (
					<button key={action.label} type="button" aria-label={action.label} className={action.icon === "trash" ? "btn btn-sm btn-danger-text" : "btn btn-sm"} onClick={action.run}>
						<Icon name={action.icon} small />
						<span>{action.label}</span>
					</button>
				))}
		</div>
	);
}

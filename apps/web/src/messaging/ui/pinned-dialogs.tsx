// Every pinned message of a chat or forum topic (mockups/chat.html#pin-message),
// newest first. A row jumps to its message; members who may pin unpin a
// message with its X, or all of them with "Bỏ ghim tất cả" after a
// confirmation. Loaded with the first use of the pinned bar's list button.
import { useState } from "react";
import type { Message } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dialogTitle, listTime, messagePreview } from "../data/format.ts";
import { pinnedLists, usePinned } from "../data/pinned.ts";
import { useChat, useDialog, useServices, useTopics } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { canPin } from "./message-menu.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";

interface PinnedListProps {
	chatId: number;
	topicId: number;
	onClose: () => void;
}

export function PinnedListDialog({ chatId, topicId, onClose }: PinnedListProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { store, remote, source, toasts, self } = useServices();
	const pins = pinnedLists(store);
	const chat = useChat(chatId) ?? null;
	const view = useDialog(chatId);
	const topics = useTopics(chatId, chat?.forum === true);
	const list = usePinned(chatId, topicId, true);
	const nameOf = useNameOf(list?.messages.map((message) => message.fromId) ?? []);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(0);
	const id = useDomId("pins");
	const t = copy.pinnedList;
	const channel = chat?.type === "channel";
	const manage = canPin(chat) && chat?.left !== true;
	const count = list?.status === "ready" ? list.count : 0;
	const topic = topicId === 0 ? undefined : topics?.find((item) => item.id === topicId);
	const where = topic?.title ?? (view === undefined ? (chat?.title ?? "") : dialogTitle(view, copy));

	const when = (message: Message): string => listTime(message.date, new Date(), locale, copy);

	const jump = (seq: number) => {
		store.openWindow(chatId, seq);
		onClose();
	};

	const unpin = (seq: number) => {
		setBusy(seq);
		remote.unpin(chatId, seq).then(
			() => {
				setBusy(0);
				pins.forget(chatId, [seq]);
				toasts.show(t.unpinned);
			},
			() => {
				setBusy(0);
				toasts.show(copy.common.failed);
			},
		);
	};

	const unpinAll = () => {
		setBusy(-1);
		source.unpinAllMessages(chatId, topicId).then(
			() => {
				pins.forget(chatId, "all");
				toasts.show(t.unpinnedAll(count));
				onClose();
			},
			() => {
				setBusy(0);
				setConfirming(false);
				toasts.show(copy.common.failed);
			},
		);
	};

	if (confirming) {
		return (
			<Modal labelledBy={id} onClose={onClose} className="narrow">
				<DialogHead id={id} title={t.confirmTitle} onClose={onClose} />
				<div className="dlg-body stack">
					<p className="note">
						<Icon name="pin" />
						<span>{t.confirmBody(count, where)}</span>
					</p>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={() => setConfirming(false)}>
						{copy.common.cancel}
					</button>
					<button type="button" className="btn btn-danger" aria-busy={busy === -1} disabled={busy !== 0} onClick={unpinAll}>
						{t.unpinAll}
					</button>
				</div>
			</Modal>
		);
	}

	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.title(count)} onClose={onClose} />
			<div className="dlg-body stack">
				{list === undefined || list.status === "loading" ? (
					<p className="status">
						<span className="spin" aria-hidden="true" />
						{copy.common.loading}
					</p>
				) : list.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
					</div>
				) : list.messages.length === 0 ? (
					<p className="status">{t.empty}</p>
				) : (
					<ul className="pin-list">
						{list.messages.map((message) => {
							const name = nameOf(message.fromId);
							return (
								<li key={message.seq} className="row">
									<ChatAvatar id={message.fromId} name={message.fromId === self.id ? self.name : name} size="sm" />
									<button type="button" className="pin-row grow" onClick={() => jump(message.seq)}>
										<span className="pin-text">{messagePreview(message, nameOf, copy, channel)}</span>
										<small>{t.meta(name, when(message))}</small>
									</button>
									{manage && (
										<button
											type="button"
											className="icon-btn"
											aria-label={t.unpin(name)}
											aria-busy={busy === message.seq}
											disabled={busy !== 0}
											onClick={() => unpin(message.seq)}
										>
											<Icon name="x" small />
										</button>
									)}
								</li>
							);
						})}
					</ul>
				)}
				{list?.status === "ready" && list.hasMore && (
					<button type="button" className="see-all" onClick={() => pins.loadMore(chatId, topicId)}>
						{t.more}
					</button>
				)}
			</div>
			{manage && count > 0 && (
				<div className="dlg-foot">
					<button type="button" className="btn btn-danger" disabled={busy !== 0} onClick={() => setConfirming(true)}>
						{t.unpinAll}
					</button>
				</div>
			)}
		</Modal>
	);
}

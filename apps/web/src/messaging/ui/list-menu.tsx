// The chat list's row menu (mockups/chat.html#list-menu): pin the chat (at
// most PINNED_DIALOGS_MAX), mark it read or unread, mute it for a while
// (submenu) or turn notifications back on, and delete: a private chat for
// yourself, a group or channel you own for everyone (#delete-chat). Opened by right click, a long press, the menu key or the row's
// "…" button, never by opening the chat. Mute and pins sync to the user's
// other sessions through the server; "unread" is a mark on this device.
import { MUTE_FOREVER, PINNED_DIALOGS_MAX } from "@app/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dialogTitle } from "../data/format.ts";
import type { MuteFor } from "../data/remote.ts";
import { useDialog, useListEntries, useListEntry, useServices } from "../data/services.tsx";
import { muteEnd, MuteDurations, pinLimitReached, useMute } from "./dialog-settings.tsx";
import { PopupMenu } from "./popup-menu.tsx";
import { useUi, type ListMenuTarget } from "./ui-context.tsx";

/** Gap kept between the menu and the edges of the window. */
const EDGE_PX = 8;

export function ListMenu({ target, onClose }: { target: ListMenuTarget; onClose: () => void }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, source, store, toasts } = useServices();
	const ui = useUi();
	const view = useDialog(target.chatId);
	const setMute = useMute(target.chatId, view === undefined ? "" : dialogTitle(view, copy));
	const entry = useListEntry(target.chatId);
	const entries = useListEntries();
	const [submenu, setSubmenu] = useState(false);
	const pair = useRef<HTMLDivElement>(null);
	const t = copy.listMenu;

	// Keep the menus inside the window (measured after layout, before paint).
	useLayoutEffect(() => {
		const element = pair.current;
		if (element === null) return;
		const rect = element.getBoundingClientRect();
		element.style.left = `${Math.max(EDGE_PX, Math.min(target.x, window.innerWidth - rect.width - EDGE_PX))}px`;
		element.style.top = `${Math.max(EDGE_PX, Math.min(target.y, window.innerHeight - rect.height - EDGE_PX))}px`;
	}, [target, submenu]);

	if (view === undefined || entry === undefined) return null;
	const chatId = target.chatId;
	const title = dialogTitle(view, copy);
	const pinnedCount = entries.filter((item) => item.pinned).length;
	const full = !entry.pinned && pinnedCount >= PINNED_DIALOGS_MAX;
	const privateChat = view.chat?.type === "private";
	const ownedChat = (view.chat?.type === "group" || view.chat?.type === "channel") && view.chat.myRole === "owner" && !view.chat.left;

	const close = () => {
		onClose();
		document.querySelector<HTMLElement>(`.chat-rows a[href="${paths.chat(chatId)}"]`)?.focus();
	};
	const run = (task: () => Promise<string>) => {
		close();
		task().then(
			(done) => toasts.show(done),
			(err: unknown) => toasts.show(pinLimitReached(err) ? t.pinLimit(PINNED_DIALOGS_MAX) : copy.common.failed),
		);
	};
	const togglePin = () => {
		if (full) {
			close();
			toasts.show(t.pinLimit(PINNED_DIALOGS_MAX));
			return;
		}
		run(async () => {
			const pinned = await remote.setDialogPinned(chatId, !entry.pinned);
			return entry.pinned ? t.unpinned(title) : t.pinned(title, pinned.length, PINNED_DIALOGS_MAX);
		});
	};
	const mute = (label: string, muteFor: MuteFor) => run(() => setMute(label, muteFor));
	const markRead = () =>
		run(async () => {
			store.setMarkedUnread(chatId, false);
			const top = view.dialog.topSeq;
			if (top > view.dialog.readInboxMaxSeq) await source.markRead(chatId, top);
			return t.read;
		});
	const markUnread = () =>
		run(async () => {
			store.setMarkedUnread(chatId, true);
			return t.unread;
		});
	const muteUntil = view.dialog.muteUntil;

	return (
		<div className="menu-pair list-menu" ref={pair} style={{ left: target.x, top: target.y }}>
			<PopupMenu label={t.label(title)} boundary={pair} onClose={close}>
				<button type="button" role="menuitem" onClick={togglePin}>
					<Icon name="pin" />
					{entry.pinned ? t.unpin : t.pin}
					{full && <span className="count">{t.pinFull(PINNED_DIALOGS_MAX)}</span>}
				</button>
				{entry.unread ? (
					<button type="button" role="menuitem" onClick={markRead}>
						<Icon name="checks" />
						{t.markRead}
					</button>
				) : (
					<button type="button" role="menuitem" onClick={markUnread}>
						<Icon name="message-dot" />
						{t.markUnread}
					</button>
				)}
				{entry.muted ? (
					<button type="button" role="menuitem" onClick={() => mute("", 0)}>
						<Icon name="bell" />
						{t.unmute}
						{muteUntil !== MUTE_FOREVER && <span className="count">{t.mutedUntil(muteEnd(muteUntil, locale))}</span>}
					</button>
				) : (
					<button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu} onClick={() => setSubmenu(true)}>
						<Icon name="bell-off" />
						{t.mute}
						<span className="go">
							<Icon name="chevron-right" small />
						</span>
					</button>
				)}
				{(privateChat || ownedChat) && (
					<>
						<hr />
						<button
							type="button"
							role="menuitem"
							className="danger"
							onClick={() => {
								onClose();
								ui.dialog.set({ kind: "deleteChat", chatId });
							}}
						>
							<Icon name="trash" />
							{privateChat ? t.deleteChat : copy.info.deleteGroup(view.chat?.type === "channel")}
						</button>
					</>
				)}
			</PopupMenu>
			{submenu && (
				<MuteDurations
					boundary={pair}
					onPick={mute}
					onClose={() => {
						setSubmenu(false);
						pair.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
					}}
				/>
			)}
		</div>
	);
}

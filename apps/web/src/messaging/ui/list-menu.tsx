// The chat list's row menu (mockups/chat.html#list-menu): pin the chat, mute
// it for a while (submenu) and mark it read. Opened by right click, a long
// press or the menu key on a row, never by opening the chat. Pinning and
// muting show only when the server offers them; marking read always works.
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { dialogTitle } from "../data/format.ts";
import { useBackendVersion, useDialog, useServices } from "../data/services.tsx";
import { PopupMenu } from "./popup-menu.tsx";
import type { ListMenuTarget } from "./ui-context.tsx";

/** Gap kept between the menu and the edges of the window. */
const EDGE_PX = 8;

export function ListMenu({ target, onClose }: { target: ListMenuTarget; onClose: () => void }) {
	const copy = useScreensCopy();
	const { backend, source, toasts } = useServices();
	useBackendVersion();
	const view = useDialog(target.chatId);
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

	if (view === undefined) return null;
	const chatId = target.chatId;
	const title = dialogTitle(view, copy);
	const muted = backend.isMuted(chatId);
	const pinned = backend.isPinnedDialog(chatId);

	const close = () => {
		onClose();
		document.querySelector<HTMLElement>(`.chat-rows a[href="${paths.chat(chatId)}"]`)?.focus();
	};
	const run = (task: () => Promise<void>, done: string) => {
		close();
		task().then(
			() => toasts.show(done),
			() => toasts.show(copy.common.failed),
		);
	};
	const durations = [
		{ label: t.hour, seconds: 3600 },
		{ label: t.hours8, seconds: 8 * 3600 },
		{ label: t.day, seconds: 86_400 },
		{ label: t.forever, seconds: 0 },
	];

	return (
		<div className="menu-pair list-menu" ref={pair} style={{ left: target.x, top: target.y }}>
			<PopupMenu label={t.label(title)} boundary={pair} onClose={close}>
				{backend.features.has("pinnedDialogs") && (
					<button
						type="button"
						role="menuitem"
						onClick={() => run(() => backend.setPinnedDialog(chatId, !pinned), pinned ? t.unpinned(title) : t.pinned(title))}
					>
						<Icon name="pin" />
						{pinned ? t.unpin : t.pin}
					</button>
				)}
				{backend.features.has("mute") &&
					(muted ? (
						<button type="button" role="menuitem" onClick={() => run(() => backend.setMuted(chatId, false), t.unmuted(title))}>
							<Icon name="bell" />
							{t.unmute}
							<span className="count">{t.mutedUntilBack}</span>
						</button>
					) : (
						<button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu} onClick={() => setSubmenu(true)}>
							<Icon name="bell-off" />
							{t.mute}
							<span className="go">
								<Icon name="chevron-right" small />
							</span>
						</button>
					))}
				<button
					type="button"
					role="menuitem"
					onClick={() => run(() => source.markRead(chatId, view.topMessage?.seq ?? 0), t.read)}
				>
					<Icon name="checks" />
					{t.markRead}
				</button>
			</PopupMenu>
			{submenu && (
				<PopupMenu
					label={t.muteFor}
					boundary={pair}
					onClose={() => {
						setSubmenu(false);
						pair.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
					}}
				>
					{durations.map((duration) => (
						<button
							key={duration.seconds}
							type="button"
							role="menuitem"
							onClick={() =>
								run(() => backend.setMuted(chatId, true, duration.seconds), duration.seconds === 0 ? t.mutedForever : t.mutedFor(duration.label))
							}
						>
							{duration.label}
						</button>
					))}
				</PopupMenu>
			)}
		</div>
	);
}

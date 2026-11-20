// The row of a linked person in "Tất cả" (ADR 0025): the person's name, the
// apps of their private chats, the last message among those chats and the
// sum of their unread messages. It opens the person's screen; its menu only
// opens one of the chats. Pins, mute and delete stay on the chats
// themselves. Loaded with the first person row, never on the first screen.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { countLabel, listTime } from "../data/format.ts";
import { useDialog, useDraft, useServices } from "../data/services.tsx";
import { personPath } from "../people/person-path.ts";
import type { PersonRowItem } from "../people/person-rows.ts";
import { LabelledIcon, Preview, useContextTrigger } from "./chat-row.tsx";
import { appLabel } from "./link-suggestions.tsx";
import { ChatAvatar } from "./parts.tsx";
import { PopupMenu } from "./popup-menu.tsx";

/** Gap kept between the menu and the edges of the window. */
const EDGE_PX = 8;

/** The person's chat with the newest message, and the unread messages of all of them. */
function useNewestAndUnread(chatIds: readonly number[]): { newest: number; unread: number } {
	const { store } = useServices();
	const key = chatIds.join(",");
	const subscribe = useCallback(
		(listener: () => void) => {
			const stops = key.split(",").map((id) => store.subscribe(`dialog:${id}`, listener));
			return () => {
				for (const stop of stops) stop();
			};
		},
		[store, key],
	);
	const snapshot = useSyncExternalStore(subscribe, () => {
		let newest = 0;
		let date = -1;
		let unread = 0;
		for (const chatId of key.split(",").map(Number)) {
			const view = store.dialog(chatId);
			if (view === undefined) continue;
			unread += view.dialog.unreadCount;
			const at = view.topMessage?.date ?? 0;
			if (at > date) {
				date = at;
				newest = chatId;
			}
		}
		return `${newest}:${unread}`;
	});
	const [newest = 0, unread = 0] = snapshot.split(":").map(Number);
	return { newest, unread };
}

interface PersonMenuProps {
	item: PersonRowItem;
	x: number;
	y: number;
	onClose: () => void;
}

/** "Mở chat <app>" for each of the person's chats in the list, nothing else. */
function PersonMenu({ item, x, y, onClose }: PersonMenuProps) {
	const copy = useScreensCopy();
	const box = useRef<HTMLDivElement>(null);
	// Keep the menu inside the window (measured after layout, before paint).
	useLayoutEffect(() => {
		const element = box.current;
		if (element === null) return;
		const rect = element.getBoundingClientRect();
		element.style.left = `${Math.max(EDGE_PX, Math.min(x, window.innerWidth - rect.width - EDGE_PX))}px`;
		element.style.top = `${Math.max(EDGE_PX, Math.min(y, window.innerHeight - rect.height - EDGE_PX))}px`;
	}, [x, y]);
	const members = item.person.members.filter((member) => item.chatIds.includes(member.chatId));
	// In the page's body: the row is moved with a transform, which would carry a fixed menu with it.
	return createPortal(
		<div className="menu-pair list-menu" ref={box} style={{ left: x, top: y }}>
			<PopupMenu label={copy.people.rowActions(item.person.name)} boundary={box} onClose={onClose}>
				{members.map((member) => (
					<button
						key={member.chatId}
						type="button"
						role="menuitem"
						onClick={() => {
							onClose();
							navigate(paths.chat(member.chatId));
						}}
					>
						<Icon name="message" />
						{copy.people.openChat(appLabel(member.app, copy))}
					</button>
				))}
			</PopupMenu>
		</div>,
		document.body,
	);
}

interface PersonRowProps {
	item: PersonRowItem;
	current: boolean;
	style: CSSProperties;
	position: number;
	total: number;
}

export default function PersonRow({ item, current, style, position, total }: PersonRowProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const trigger = useContextTrigger((x, y) => setMenu({ x, y }));
	const { newest, unread } = useNewestAndUnread(item.chatIds);
	const view = useDialog(newest);
	const draft = useDraft(newest);
	const { name } = item.person;
	const apps = item.apps.map((app) => appLabel(app, copy));
	const top = view?.topMessage ?? null;
	return (
		<li className="chat-slot" style={style} aria-setsize={total} aria-posinset={position} {...trigger}>
			<Link to={personPath(item.person.id)} className="chat-row" current={current} aria-label={copy.people.rowLabel(name, apps.join(", "), unread)}>
				<ChatAvatar id={item.person.id} name={name} />
				<span className="tx">
					<span className="name">
						<span className="title-text">{name}</span>
						{apps.map((app) => (
							<span key={app} className="tag grey">
								{app}
							</span>
						))}
					</span>
					{view === undefined ? <span className="preview" /> : <Preview view={view} kind="private" saved={false} draft={draft} topics={null} />}
				</span>
				<span className="meta">
					<span className="line">
						{item.pinned && <LabelledIcon name="pin" label={copy.list.pinned} />}
						{top !== null && listTime(top.date, new Date(), locale, copy)}
					</span>
					{unread > 0 && (
						<span className="line">
							<span className="badge">{countLabel(unread)}</span>
						</span>
					)}
				</span>
			</Link>
			<button
				type="button"
				className="row-more"
				aria-label={copy.people.rowActions(name)}
				aria-haspopup="menu"
				onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					setMenu({ x: rect.left, y: rect.bottom });
				}}
			>
				<Icon name="dots" small />
			</button>
			{menu !== null && <PersonMenu item={item} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
		</li>
	);
}

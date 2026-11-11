// The compact window (picture-in-picture): the chat the page has open, and a
// strip of the other chats with unread messages. It is a second view of the
// page's own state: picking a chat in the strip navigates the page's route, so
// the chat core keeps following one open chat. The window has its own
// dialogs, menus and reply/edit state; the data is shared with the page.
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useCompactWindow } from "../../compact/compact-window-store.ts";
import { LoaderScope } from "../../components/delayed-loader.tsx";
import { navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { dialogTitle } from "../data/format.ts";
import type { ListEntry } from "../data/store.ts";
import { useChat, useDialog, useListEntries, useUser } from "../data/services.tsx";
import { Conversation, EmptyConversation } from "./conversation.tsx";
import { DialogHost } from "./dialog-host.tsx";
import { ChatAvatar } from "./parts.tsx";
import { SurfaceContext, type Surface } from "./surface.ts";
import { Cell, ComposerIntents, UiContext, type DialogRequest, type ListMenuTarget, type MenuTarget, type OpenMiniApp, type Ui } from "./ui-context.tsx";

/** Unread chats the strip shows; the rest are one click away in the page. */
const MAX_STRIP_CHATS = 8;

interface CompactWindowProps {
	/** The chat the page has open (0: none). */
	chatId: number;
	topicId: number;
}

/** Renders nothing until the compact window is open; mount it once inside the chat screen. */
export function CompactWindow({ chatId, topicId }: CompactWindowProps) {
	const pip = useCompactWindow();
	if (pip === null) return null;
	return <CompactContent pip={pip} chatId={chatId} topicId={topicId} />;
}

function CompactContent({ pip, chatId, topicId }: CompactWindowProps & { pip: Window }) {
	const surface = useMemo<Surface>(() => ({ document: pip.document, compact: true }), [pip]);
	const ui = useMemo<Ui>(
		() => ({
			dialog: new Cell<DialogRequest | null>(null),
			menu: new Cell<MenuTarget | null>(null),
			listMenu: new Cell<ListMenuTarget | null>(null),
			miniApp: new Cell<OpenMiniApp | null>(null),
			intents: new ComposerIntents(),
			// The compact window has no chat list or info column.
			focusSearch: () => undefined,
			toggleInfo: () => undefined,
		}),
		[],
	);
	return createPortal(
		<SurfaceContext value={surface}>
			<UiContext value={ui}>
				<div className="app compact no-info has-chat">
					<UnreadStrip activeChatId={chatId} />
					{chatId === 0 ? (
						<EmptyConversation />
					) : (
						<LoaderScope>
							<Conversation chatId={chatId} topicId={topicId} infoOpen={false} />
						</LoaderScope>
					)}
				</div>
				<DialogHost />
			</UiContext>
		</SurfaceContext>,
		pip.document.body,
	);
}

function UnreadStrip({ activeChatId }: { activeChatId: number }) {
	const copy = useCopy();
	const entries = useListEntries();
	const unread = entries.filter((entry) => entry.unread && !entry.muted && entry.chatId !== activeChatId).slice(0, MAX_STRIP_CHATS);
	if (unread.length === 0) return null;
	return (
		<nav className="compact-strip" aria-label={copy.convo.compactUnread}>
			{unread.map((entry) => (
				<UnreadChip key={entry.chatId} entry={entry} />
			))}
		</nav>
	);
}

function UnreadChip({ entry }: { entry: ListEntry }) {
	const copy = useCopy();
	const chat = useChat(entry.chatId);
	const view = useDialog(entry.chatId);
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	if (chat == null) return null;
	const title = dialogTitle({ chat, peer: view?.peer ?? peer ?? null }, copy);
	return (
		<button type="button" className="compact-chip" title={title} onClick={() => navigate(paths.chat(entry.chatId))}>
			<ChatAvatar id={entry.chatId} name={title} size="sm" bot={entry.kind === "bot"} saved={entry.saved} />
			<span>{title}</span>
		</button>
	);
}

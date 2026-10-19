// The messaging screen (mockups/chat.html#app): folder rail, chat list (or
// the topic list of an open group with topics, or the contacts list) with its
// width handle, conversation and the info column. On narrow screens one
// column shows at a time (#narrow); the info column handles its overlay and
// narrow behaviour itself (info-panel.tsx). Screen-wide shortcuts
// (settings.html#shortcuts): ⌘/Ctrl+K or F search, ⌘/Ctrl+1…5 pick a folder,
// ⌘/Ctrl+/ opens the shortcut list.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { LoaderBoundary, LoaderScope, Ready } from "../../components/delayed-loader.tsx";
import { loadConnectWeb } from "../../api/client.ts";
import { preloadable, warm } from "../../components/preload.ts";
import { loadIntegrationsClient } from "../integrations/api.ts";
import { navigate, paths, useSearch, type Route } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { dialogTitle, FOLDERS, type Folder } from "../data/format.ts";
import { hookData, hooksData } from "../data/screen-data.ts";
import { useChat, useDialog, useServices, useTopics, useUser } from "../data/services.tsx";
import { ChatListColumn } from "./chat-list.tsx";
import { Conversation, EmptyConversation } from "./conversation.tsx";
import { DialogHost } from "./dialog-host.tsx";
import { FolderRail } from "./folder-rail.tsx";
import { ListResizer } from "./list-resizer.tsx";
import { Cell, ComposerIntents, UiContext, useCell, type DialogRequest, type ListMenuTarget, type MenuTarget, type MiniAppRequest, type Ui } from "./ui-context.tsx";

const WIDE_QUERY = "(min-width: 1101px)";

const TopicListColumn = lazy(() => import("./topic-list.tsx").then((m) => ({ default: m.TopicListColumn })));
const InfoPanel = lazy(() => import("./info-panel.tsx").then((m) => ({ default: m.InfoPanel })));
const ChatAdmin = lazy(() => import("./chat-admin.tsx").then((m) => ({ default: m.ChatAdmin })));
const BannedList = lazy(() => import("./banned-list.tsx").then((m) => ({ default: m.BannedList })));
const integrationsCode = preloadable(() => import("../integrations/integrations-page.tsx"));
const IntegrationsPage = integrationsCode.Component;
const InviteDialog = lazy(() => import("./invite-dialog.tsx").then((m) => ({ default: m.InviteDialog })));
const contactsCode = preloadable(async () => ({ default: (await import("./contacts.tsx")).ContactsView }));
const ContactsView = contactsCode.Component;
const ListMenu = lazy(() => import("./list-menu.tsx").then((m) => ({ default: m.ListMenu })));
const BotLinkDialog = lazy(() => import("../bots/bot-link-dialog.tsx"));
const MiniApp = lazy(() => import("../bots/mini-app.tsx"));

/** Panes whose code is fetched when the browser is idle after startup (messaging-root.tsx). */
export const chatPanePreloads: readonly (() => Promise<void>)[] = [integrationsCode.preload, contactsCode.preload];

/** The admin column's box around a loader (before the page itself renders one). */
function adminFrame(loader: ReactNode): ReactNode {
	return <section className="admin-page">{loader}</section>;
}

function initialInfoOpen(): boolean {
	return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches;
}

type ChatRoute = Extract<Route, { name: "home" } | { name: "chat" } | { name: "invite" } | { name: "contacts" } | { name: "bot" }>;

export function ChatScreen({ self, route }: { self: SelfUser; route: ChatRoute }) {
	const copy = useCopy();
	const { source, store, remote, integrations } = useServices();
	const [folder, setFolder] = useState<Folder>("all");
	const [infoOpen, setInfoOpen] = useState(initialInfoOpen);
	const [visible, setVisible] = useState<readonly number[]>([]);
	const searchRef = useRef<HTMLInputElement>(null);
	const appRef = useRef<HTMLDivElement>(null);
	const contacts = route.name === "contacts";

	const ui = useMemo<Ui>(
		() => ({
			dialog: new Cell<DialogRequest | null>(null),
			menu: new Cell<MenuTarget | null>(null),
			listMenu: new Cell<ListMenuTarget | null>(null),
			miniApp: new Cell<MiniAppRequest | null>(null),
			intents: new ComposerIntents(),
			focusSearch: () => searchRef.current?.focus(),
			toggleInfo: (open?: boolean) => setInfoOpen((current) => open ?? !current),
		}),
		[],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
			const key = event.key.toLowerCase();
			if (key === "k" || key === "f") {
				event.preventDefault();
				// Contacts, a topic list or an admin page hold the column: go back to the chat list first.
				if (searchRef.current === null) navigate(paths.home);
				requestAnimationFrame(() => {
					searchRef.current?.focus();
					searchRef.current?.select();
				});
				return;
			}
			if (key === "/") {
				event.preventDefault();
				navigate(paths.settings("shortcuts"));
				return;
			}
			const index = Number(key) - 1;
			const picked = Number.isInteger(index) ? FOLDERS[index] : undefined;
			if (picked !== undefined) {
				event.preventDefault();
				setFolder(picked);
				if (route.name === "contacts") navigate(paths.home);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [route]);

	const chatId = route.name === "chat" ? route.chatId : 0;
	const panel = route.name === "chat" ? route.panel : "chat";
	const chat = useChat(chatId);
	const view = useDialog(chatId);
	const peer = useUser(chat?.type === "private" ? chat.peerUserId : 0);
	const topics = useTopics(chatId, chat?.forum === true);
	const requestedTopic = route.name === "chat" ? route.topicId : 0;
	const topic =
		topics === null ? null : (topics.find((t) => t.id === requestedTopic) ?? topics.find((t) => t.general) ?? topics[0] ?? null);
	const title = chat == null ? "" : dialogTitle({ chat, peer: view?.peer ?? peer ?? null }, copy);

	// The core follows the open chat and the large chats visible in the list.
	const visibleKey = visible.join(",");
	useEffect(() => {
		const large = visibleKey === "" ? [] : visibleKey.split(",").map(Number).filter((id) => store.dialog(id)?.chat?.syncMode === "large");
		source.openChat(chatId, 0, large).catch(() => undefined);
	}, [source, store, chatId, visibleKey]);
	useEffect(() => () => void source.openChat(0).catch(() => undefined), [source]);

	const onVisibleChats = useCallback((ids: readonly number[]) => setVisible(ids), []);
	// A bot link's start parameter: another one in place (same path) opens a new dialog.
	const startParam = new URLSearchParams(useSearch()).get("start") ?? "";
	const showInfo = infoOpen && chat != null && panel === "chat" && !contacts;

	const pickFolder = (next: Folder) => {
		setFolder(next);
		if (contacts) navigate(paths.home);
	};
	// Webhook pages: their data starts with their code, so the page shows once (components/preload.ts).
	const hookId = route.name === "chat" ? (route.hookId ?? "") : "";
	// Their first request waits for the integrations client and the transport: fetch those with the page.
	if (panel === "hooks" || panel === "hook" || panel === "hook-new") warm(loadConnectWeb, loadIntegrationsClient);
	const paneParts =
		panel === "hooks"
			? [integrationsCode.preload(), hooksData(integrations, chatId).promise]
			: panel === "hook" && hookId !== ""
				? [integrationsCode.preload(), hookData(integrations, hookId).promise]
				: panel === "hook-new"
					? [integrationsCode.preload()]
					: [];
	// Contacts: the list starts loading with the view's code (the store module stays out of startup).
	useEffect(() => {
		if (!contacts) return;
		import("../data/contacts.ts")
			.then(({ contactsOf }) => contactsOf(remote).load())
			.catch(() => undefined);
	}, [contacts, remote]);

	const open = chatId !== 0 || (contacts && route.userId !== 0);
	const adminMode = panel !== "chat";
	const classes = ["app", "folders", showInfo ? "" : "no-info", open ? "has-chat" : "", adminMode ? "admin-mode" : ""].filter(Boolean).join(" ");

	return (
		<UiContext value={ui}>
			<div className={classes} ref={appRef}>
				<FolderRail self={self} folder={contacts ? null : folder} onFolder={pickFolder} />
				{contacts ? (
					<LoaderBoundary frame={(loader) => <section className="list">{loader}</section>}>
						<ContactsView userId={route.userId} />
					</LoaderBoundary>
				) : (
					<>
						{topics !== null && chat != null && panel === "chat" ? (
							<Suspense fallback={<section className="list" aria-busy="true" />}>
								<TopicListColumn chat={chat} title={title} topics={topics} currentTopicId={topic?.id ?? 0} />
							</Suspense>
						) : (
							<ChatListColumn folder={folder} onFolder={setFolder} currentChatId={chatId} searchRef={searchRef} onVisibleChats={onVisibleChats} />
						)}
						{chatId === 0 ? (
							<EmptyConversation />
						) : adminMode ? (
							<LoaderBoundary frame={adminFrame}>
								<Ready parts={paneParts} frame={adminFrame}>
									{panel === "banned" ? (
										<BannedList chatId={chatId} />
									) : panel === "admin" ? (
										<ChatAdmin chatId={chatId} />
									) : (
										<IntegrationsPage chatId={chatId} panel={panel} hookId={hookId} />
									)}
								</Ready>
							</LoaderBoundary>
						) : (
							<LoaderScope>
								<Conversation chatId={chatId} topicId={topic?.id ?? 0} infoOpen={showInfo} />
							</LoaderScope>
						)}
						{showInfo && chat != null && (
							<Suspense fallback={<aside className="info" aria-busy="true" />}>
								<InfoPanel chat={chat} peer={view?.peer ?? peer} topic={topic} title={title} />
							</Suspense>
						)}
					</>
				)}
				<ListResizer app={appRef} />
			</div>
			<DialogHost />
			<RowMenu ui={ui} />
			<MiniAppLayer ui={ui} />
			{route.name === "invite" && (
				<Suspense fallback={null}>
					<InviteDialog token={route.token} />
				</Suspense>
			)}
			{route.name === "bot" && (
				<Suspense fallback={null}>
					<BotLinkDialog key={`${route.username}?${startParam}`} username={route.username} startParam={startParam} />
				</Suspense>
			)}
		</UiContext>
	);
}

/** The open Mini App's container, loaded on first use. */
function MiniAppLayer({ ui }: { ui: Ui }) {
	const request = useCell(ui.miniApp);
	if (request === null) return null;
	return (
		<Suspense fallback={null}>
			<MiniApp key={request.id} request={request} onClose={() => ui.miniApp.set(null)} />
		</Suspense>
	);
}

/** The chat list's row menu, loaded on first use. */
function RowMenu({ ui }: { ui: Ui }) {
	const target = useCell(ui.listMenu);
	if (target === null) return null;
	return (
		<Suspense fallback={null}>
			<ListMenu key={target.chatId} target={target} onClose={() => ui.listMenu.set(null)} />
		</Suspense>
	);
}

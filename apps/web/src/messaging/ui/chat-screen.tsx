// The messaging screen (mockups/chat.html#app): folder rail, chat list (or
// the topic list of an open group with topics, or the contacts list) with its
// width handle, conversation and the info column. On narrow screens one
// column shows at a time (#narrow); the info column handles its overlay and
// narrow behaviour itself (info-panel.tsx). Screen-wide shortcuts
// (settings.html#shortcuts): ⌘/Ctrl+K or F search, ⌘/Ctrl+1…5 pick a folder,
// ⌘/Ctrl+/ opens the shortcut list, ⌥/Alt+P opens or closes the compact window.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { LoaderBoundary, LoaderScope, Ready } from "../../components/delayed-loader.tsx";
import { loadConnectWeb } from "../../api/client.ts";
import { preloadable, warm } from "../../components/preload.ts";
import { loadIntegrationsClient } from "../integrations/api.ts";
import { compactWindow, isPictureInPictureSupported } from "../../compact/compact-window-store.ts";
import { navigate, paths, useSearch, type Route } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { dialogTitle, FOLDERS, type Folder } from "../data/format.ts";
import { hookData, hooksData } from "../data/screen-data.ts";
import { useAppFolders, useChat, useDialog, useServices, useTopics, useUser } from "../data/services.tsx";
import { ChatListColumn } from "./chat-list.tsx";
import { CompactWindow } from "./compact-window.tsx";
import { Conversation, EmptyConversation, preloadComposer } from "./conversation.tsx";
import { DialogHost, dialogPreload } from "./dialog-host.tsx";
import { FolderRail } from "./folder-rail.tsx";
import { ListResizer } from "./list-resizer.tsx";
import { MiniAppChipSlot, MiniAppLayer } from "./mini-app-slot.tsx";
import {
	Cell,
	ComposerIntents,
	UiContext,
	AI_PHONE_QUERY,
	rememberAiPanel,
	rememberedAiPanel,
	type AiPanelRequest,
	type ComposerFill,
	followChatOnScreen,
	minimizeMiniApp,
	useCell,
	type DialogRequest,
	type ListMenuTarget,
	type MenuTarget,
	type MessageSelection,
	type OpenMiniApp,
	type Ui,
} from "./ui-context.tsx";

const WIDE_QUERY = "(min-width: 1101px)";

const TopicListColumn = lazy(() => import("./topic-list.tsx").then((m) => ({ default: m.TopicListColumn })));
const InfoPanel = lazy(() => import("./info-panel.tsx").then((m) => ({ default: m.InfoPanel })));
// The chat's AI panel (its AI Agent session on the user's machine), loaded when first opened.
const AiPanel = lazy(() => import("./ai-panel.tsx"));
const ChatAdmin = lazy(() => import("./chat-admin.tsx").then((m) => ({ default: m.ChatAdmin })));
const BannedList = lazy(() => import("./banned-list.tsx").then((m) => ({ default: m.BannedList })));
const integrationsCode = preloadable(() => import("../integrations/integrations-page.tsx"));
const IntegrationsPage = integrationsCode.Component;
const InviteDialog = lazy(() => import("./invite-dialog.tsx").then((m) => ({ default: m.InviteDialog })));
const contactsCode = preloadable(async () => ({ default: (await import("./contacts.tsx")).ContactsView }));
const ContactsView = contactsCode.Component;
const ListMenu = lazy(() => import("./list-menu.tsx").then((m) => ({ default: m.ListMenu })));
const BotLinkDialog = lazy(() => import("../bots/bot-link-dialog.tsx"));

/** Panes (and the dialog switch) whose code is fetched when the browser is idle after startup (messaging-root.tsx). */
export const chatPanePreloads: readonly (() => Promise<void>)[] = [preloadComposer, integrationsCode.preload, contactsCode.preload, dialogPreload];

/** The admin column's box around a loader (before the page itself renders one). */
function adminFrame(loader: ReactNode): ReactNode {
	return <section className="admin-page">{loader}</section>;
}

function initialInfoOpen(): boolean {
	return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches;
}

type ChatRoute = Extract<Route, { name: "home" } | { name: "chat" } | { name: "invite" } | { name: "contacts" } | { name: "bot" }>;

interface ChatScreenProps {
	self: SelfUser;
	route: ChatRoute;
	/** Held by the parent so the folder stays picked across Settings and back. */
	folder: Folder;
	/** The app folder picked (Chat Bridge), held with the folder; null when a built-in folder is. */
	app: string | null;
	onFolder: (folder: Folder) => void;
	onApp: (app: string) => void;
}

export function ChatScreen({ self, route, folder, app: pickedApp, onFolder: setFolder, onApp: setApp }: ChatScreenProps) {
	const copy = useCopy();
	const { source, store, remote, integrations } = useServices();
	const [infoOpen, setInfoOpen] = useState(initialInfoOpen);
	const [visible, setVisible] = useState<readonly number[]>([]);
	const searchRef = useRef<HTMLInputElement>(null);
	const appRef = useRef<HTMLDivElement>(null);
	const contacts = route.name === "contacts";

	const ui = useMemo<Ui>(() => {
		const miniApp = new Cell<OpenMiniApp | null>(null);
		// A computer reopens the panel it had open; a phone keeps its sheet closed until asked.
		const ai = new Cell<AiPanelRequest | null>(typeof window.matchMedia === "function" && window.matchMedia(AI_PHONE_QUERY).matches ? null : rememberedAiPanel());
		ai.subscribe(() => rememberAiPanel(ai.get() !== null));
		return {
			dialog: new Cell<DialogRequest | null>(null),
			selection: new Cell<MessageSelection | null>(null),
			menu: new Cell<MenuTarget | null>(null),
			listMenu: new Cell<ListMenuTarget | null>(null),
			miniApp,
			intents: new ComposerIntents(),
			ai,
			composerFill: new Cell<ComposerFill | null>(null),
			focusSearch: () => searchRef.current?.focus(),
			toggleInfo: (open?: boolean) => {
				// One slot: the chat's info takes the AI panel's place.
				if (ai.get() !== null && open !== false) {
					ai.set(null);
					setInfoOpen(true);
					return;
				}
				// One slot: showing the chat's info minimizes a Mini App docked there.
				const docked = miniApp.get();
				if (docked !== null && !docked.minimized && open !== false) {
					minimizeMiniApp(miniApp, docked.request.id, true);
					setInfoOpen(true);
					return;
				}
				setInfoOpen((current) => open ?? !current);
			},
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// The physical key: on macOS ⌥P types a different character. A key press is the user gesture the window needs.
			if (event.code === "KeyP" && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.repeat && isPictureInPictureSupported()) {
				event.preventDefault();
				if (compactWindow.get() === null) void compactWindow.open();
				else compactWindow.close();
				return;
			}
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
				// Contacts or a topic list hold the column: go back to the chat list.
				if (searchRef.current === null) navigate(paths.home);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [route, setFolder]);

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
	// A Mini App shown takes the info column's place; minimized or closed, the column is back as it was.
	const miniApp = useCell(ui.miniApp);
	useEffect(() => followChatOnScreen(ui.miniApp, chatId), [ui, chatId]);
	const miniAppDocked = miniApp !== null && !miniApp.minimized;
	// The AI panel takes the info column's place; a Mini App shown takes it from both.
	const aiRequest = useCell(ui.ai);
	const showAi = aiRequest !== null && chat != null && panel === "chat" && !contacts && route.name === "chat" && !miniAppDocked;
	const showInfo = infoOpen && chat != null && panel === "chat" && !contacts && !miniAppDocked && !showAi;

	// Contacts or a forum's topic list hold the list column; picking a folder brings the chat list back.
	const topicList = topics !== null && chat != null && panel === "chat";
	const pickFolder = (next: Folder) => {
		setFolder(next);
		if (contacts || topicList) navigate(paths.home);
	};
	const pickApp = (next: string) => {
		setApp(next);
		if (contacts || topicList) navigate(paths.home);
	};
	// An app folder that is no longer listed (its chats are all gone) is no longer picked; Telegram and Zalo always are.
	const apps = useAppFolders();
	const app = pickedApp !== null && apps.has(pickedApp) ? pickedApp : null;
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
	const classes = ["app", "folders", showInfo || miniAppDocked || showAi ? "" : "no-info", showAi ? "ai-open" : "", open ? "has-chat" : "", adminMode ? "admin-mode" : ""]
		.filter(Boolean)
		.join(" ");

	return (
		<UiContext value={ui}>
			<div className={classes} ref={appRef}>
				<FolderRail self={self} folder={contacts ? null : folder} app={app} onFolder={pickFolder} onApp={pickApp} />
				{contacts ? (
					<LoaderBoundary frame={(loader) => <section className="list">{loader}</section>}>
						<ContactsView userId={route.userId} />
					</LoaderBoundary>
				) : (
					<>
						{topicList ? (
							<Suspense fallback={<section className="list" aria-busy="true" />}>
								<TopicListColumn chat={chat} title={title} topics={topics} currentTopicId={topic?.id ?? 0} />
							</Suspense>
						) : (
							<ChatListColumn self={self} folder={folder} app={app} onFolder={setFolder} onApp={setApp} currentChatId={chatId} searchRef={searchRef} onVisibleChats={onVisibleChats} />
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
								<Conversation chatId={chatId} topicId={topic?.id ?? 0} infoOpen={showInfo} aiOpen={showAi} />
							</LoaderScope>
						)}
						{showInfo && chat != null && (
							<Suspense fallback={<aside className="info" aria-busy="true" />}>
								<InfoPanel chat={chat} peer={view?.peer ?? peer} topic={topic} title={title} />
							</Suspense>
						)}
						{showAi && chat != null && aiRequest !== null && (
							<Suspense fallback={<aside className="ai-panel" aria-busy="true" />}>
								{/* One panel per chat: another chat opens its own session, without the quote asked about here. */}
								<AiPanel
									key={chatId}
									chat={chat}
									title={title}
									topicId={topic?.id ?? 0}
									request={aiRequest.chatId === chatId ? aiRequest : null}
									app={appRef}
								/>
							</Suspense>
						)}
					</>
				)}
				<ListResizer app={appRef} />
				<MiniAppLayer ui={ui} />
			</div>
			{(chatId === 0 || adminMode) && <MiniAppChipSlot place="screen" />}
			<DialogHost />
			<CompactWindow chatId={chatId} topicId={topic?.id ?? 0} />
			<RowMenu ui={ui} />
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

/** The chat list's row menu, loaded on first use. */
function RowMenu({ ui }: { ui: Ui }) {
	"use no memo";
	const target = useCell(ui.listMenu);
	if (target === null) return null;
	return (
		<Suspense fallback={null}>
			<ListMenu key={target.chatId} target={target} onClose={() => ui.listMenu.set(null)} />
		</Suspense>
	);
}

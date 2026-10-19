// Entry of the signed-in app (chat list, chats, contacts, settings), loaded
// lazily after sign-in so the welcome screen stays small. It starts the client
// core once per signed-in session and keeps it alive across the chat, settings
// and moderation screens.
import type { Transport } from "@connectrpc/connect";
import { Suspense, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import type { SelfUser } from "../api/adapters.ts";
import { useApi } from "../api/api-context.tsx";
import { loadAccountClient, loadConnectWeb, type Api } from "../api/client.ts";
import { PageLoader } from "../components/brand-loader.tsx";
import { LoaderBoundary, Ready } from "../components/delayed-loader.tsx";
import { prefetchWhenIdle, preloadable, warm } from "../components/preload.ts";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, navigate, paths, type Route, type SettingsTab } from "../router.tsx";
import { sessionsData } from "../screens/settings/sessions-data.ts";
import { Shell } from "../screens/shell.tsx";
import "../styles/messaging.css";
import { useCopy } from "./copy/use-copy.ts";
import { countLabel } from "./data/format.ts";
import { webConnector, type MessagingClient, type MessagingConnector } from "./data/connector.ts";
import { Drafts } from "./data/drafts.ts";
import type { PendingBackend } from "./data/pending-backend.ts";
import { decideNotification, type NotificationInput } from "./data/notification-filter.ts";
import { createRemote, loadRemoteClient } from "./data/remote.ts";
import { createIntegrations, loadIntegrationsClient } from "./integrations/api.ts";
import { createBots, loadBotsClient } from "./bots/api.ts";
import { pushOnDevice } from "./push/push-device.ts";
import { createWebPush, loadWebPushClient } from "./push/web-push.ts";
import { loadPrivacyClient } from "./settings/privacy-api.ts";
import { accountData, blockedData, myBotsData, notificationSettingsData, privacyData } from "./data/screen-data.ts";
import { ServicesContext, Toasts, useServices, useUnreadTotals, type Services } from "./data/services.tsx";
import { ChatStore } from "./data/store.ts";
import { ChatScreen, chatPanePreloads } from "./ui/chat-screen.tsx";
import { ContactsGlyph } from "./ui/contacts-glyph.tsx";
import { messageExtrasPreloads } from "./ui/message-item.tsx";
import { ChatAvatar, Toast } from "./ui/parts.tsx";
import { forgetSelf } from "../api/offline-self.ts";

// Settings, the console and moderation load when opened, keeping the first
// chat screen small; once the app is idle their code is fetched ahead.
const settingsCode = preloadable(async () => ({ default: (await import("../screens/settings/settings.tsx")).Settings }));
const settingsExtraCode = preloadable(() => import("./settings/settings-extra.tsx"));
const moderationCode = preloadable(() => import("./moderation/moderation.tsx"));
const consoleCode = preloadable(() => import("./bots/console.tsx"));
const feedbackDialogCode = preloadable(() => import("./settings/feedback-dialog.tsx"));
const Settings = settingsCode.Component;
const SettingsExtra = settingsExtraCode.Component;
const Moderation = moderationCode.Component;
const DeveloperConsole = consoleCode.Component;
const FeedbackDialog = feedbackDialogCode.Component;

/**
 * Secondary screens (and the rarer parts of messages) whose code is fetched
 * when the browser is idle after startup, with the clients their first data
 * loads on demand and the transport those calls go through.
 */
const IDLE_PREFETCH = [
	settingsCode.preload,
	settingsExtraCode.preload,
	feedbackDialogCode.preload,
	consoleCode.preload,
	...chatPanePreloads,
	...messageExtrasPreloads,
	loadConnectWeb,
	loadAccountClient,
	loadRemoteClient,
	loadBotsClient,
	loadIntegrationsClient,
];

/**
 * What a settings, console or moderation screen needs before it first shows,
 * started together: its code and its first data. The screen shows once, with
 * one loader while any of it is missing.
 */
function screenParts(route: Route, services: Services, api: Api): Promise<unknown>[] {
	switch (route.name) {
		case "settings":
			switch (route.tab) {
				case "profile":
					return [settingsCode.preload(), settingsExtraCode.preload()];
				case "sessions":
					warm(loadConnectWeb, loadAccountClient);
					return [settingsCode.preload(), sessionsData(api).promise];
				case "privacy":
					warm(loadConnectWeb, loadRemoteClient);
					return [settingsCode.preload(), settingsExtraCode.preload(), privacyData(services.remote).promise];
				case "blocked":
					warm(loadConnectWeb, loadRemoteClient);
					return [settingsCode.preload(), settingsExtraCode.preload(), blockedData(services.remote).promise];
				case "notifications":
					// The device card asks PushService: fetch its client with the screen.
					warm(loadConnectWeb, loadWebPushClient);
					return [settingsCode.preload(), settingsExtraCode.preload(), notificationSettingsData(services.store).promise];
				case "appearance":
				case "shortcuts":
				case "app":
					return [settingsCode.preload(), settingsExtraCode.preload()];
				case "account":
					warm(loadConnectWeb, loadPrivacyClient);
					return [settingsCode.preload(), settingsExtraCode.preload(), accountData(services.transport).promise];
			}
			break;
		case "console":
			// The list's request waits for the bots client and the transport: fetch them with the screen.
			warm(loadConnectWeb, loadBotsClient);
			if (route.view.page === "new") return [consoleCode.preload()];
			return [consoleCode.preload(), myBotsData(services.bots, route.view.page === "bot" ? route.view.botId : 0).promise];
		case "moderation":
		case "feedback":
		case "announcements":
		case "moderationLog":
		case "moderationBot":
			return [moderationCode.preload()];
	}
	return [];
}

export interface MessagingRootProps {
	self: SelfUser;
	route: Route;
	transport: Transport;
	onSelfChange: (self: SelfUser) => void;
	onSignedOut: () => void;
	/** Tests and the visual harness inject a client on the in-memory server. */
	connector?: MessagingConnector;
}

type Start = { status: "starting" } | { status: "failed" } | { status: "ready"; services: Services; client: MessagingClient };

function reportError(context: string, message: string): void {
	// Surfaced in the console for testers; there is no error reporting service yet.
	console.warn(`[messaging] ${context}: ${message}`);
}

export default function MessagingRoot({ self, route, transport, onSelfChange, onSignedOut, connector = webConnector }: MessagingRootProps) {
	const [start, setStart] = useState<Start>({ status: "starting" });
	const [attempt, setAttempt] = useState(0);
	// The client lives for the signed-in user: profile edits and a new
	// sign-out callback must not restart it, so the effect reads them through
	// effect events.
	const signedOut = useEffectEvent(() => onSignedOut());
	const currentSelf = useEffectEvent(() => self);
	const copy = useCopy();
	const deletedName = useEffectEvent(() => copy.message.deletedAccount);
	// Notifications arrive outside React: they read the store and the copy through this ref.
	const notify = useRef<{ store: ChatStore | null; hiddenBody: string }>({ store: null, hiddenBody: copy.notify.hiddenBody });
	useEffect(() => {
		notify.current.hiddenBody = copy.notify.hiddenBody;
	}, [copy]);

	useEffect(() => {
		const notifying = notify.current;
		let active = true;
		let started: { client: MessagingClient; store: ChatStore; backend: PendingBackend } | null = null;
		Promise.resolve(
			connector({
				onSessionEnded: () => signedOut(),
				onNotificationClick: (chatId) => navigate(paths.chat(chatId)),
				onError: reportError,
				filterNotification: (request: NotificationInput) => {
					const { store, hiddenBody } = notifying;
					// Until the store exists the settings are unknown: nothing is shown.
					if (store === null) return null;
					const settings = store.notificationSettings();
					const decision = decideNotification(
						request,
						store.dialog(request.chatId),
						settings,
						Math.floor(Date.now() / 1000),
						hiddenBody,
						pushOnDevice(self.id),
					);
					// The soft tone loads on first use; the system notification itself is silent.
					if (decision !== null && settings.sound === "soft") void import("./data/sound.ts").then((sound) => sound.playTone("soft"));
					return decision;
				},
			}),
		).then(
			(client) => {
				const remote = createRemote(transport, () => signedOut());
				const store = new ChatStore(
					client.source,
					{
						selfId: self.id,
						deletedName: deletedName(),
						onError: (err, context) => reportError(context, String(err)),
						fetchUsers: async (ids) => (await remote.people(ids)).map(({ presence: _presence, ...user }) => user),
					},
					client.coldSnapshot(),
				);
				const backend = client.createBackend(remote, client.source);
				started = { client, store, backend };
				if (!active) {
					backend.dispose();
					store.dispose();
					client.dispose();
					return;
				}
				notifying.store = store;
				const drafts = new Drafts(self.id);
				const services: Services = {
					self: currentSelf(),
					source: client.source,
					store,
					remote,
					integrations: createIntegrations(transport, () => signedOut()),
					bots: createBots(transport, () => signedOut()),
					webPush: createWebPush(transport, self.id, () => signedOut()),
					transport,
					backend,
					toasts: new Toasts(),
					drafts,
					signOut: () => {
						drafts.clear();
						forgetSelf();
						void client.signOutAndLeave();
					},
				};
				setStart({ status: "ready", services, client });
			},
			(err: unknown) => {
				reportError("start", err instanceof Error ? err.message : String(err));
				if (active) setStart({ status: "failed" });
			},
		);
		return () => {
			active = false;
			notifying.store = null;
			if (started !== null) {
				started.backend.dispose();
				started.store.dispose();
				started.client.dispose();
			}
		};
	}, [connector, transport, self.id, attempt]);

	// Save the last screen for an instant next start.
	useEffect(() => {
		if (start.status !== "ready") return;
		const save = () => {
			if (document.visibilityState === "hidden") start.client.saveSnapshot().catch(() => undefined);
		};
		const onHide = () => start.client.saveSnapshot().catch(() => undefined);
		document.addEventListener("visibilitychange", save);
		window.addEventListener("pagehide", onHide);
		return () => {
			document.removeEventListener("visibilitychange", save);
			window.removeEventListener("pagehide", onHide);
		};
	}, [start]);

	// Fetch the code of secondary screens once startup is over.
	const started = start.status === "ready";
	useEffect(() => (started ? prefetchWhenIdle(IDLE_PREFETCH) : undefined), [started]);

	// Keep this device's Web Push registration in step with the session (a
	// browser that never allowed notifications has nothing to sync).
	const { locale } = useI18n();
	const pushLocale = useEffectEvent(() => locale);
	useEffect(() => {
		if (start.status !== "ready") return;
		const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
		if (!granted && !pushOnDevice(self.id)) return;
		start.services.webPush.sync(pushLocale()).catch((err: unknown) => reportError("web push", err instanceof Error ? err.message : String(err)));
	}, [start, self.id]);

	// One services object per client and profile, so context readers re-render rarely.
	const services = useMemo(() => (start.status === "ready" ? { ...start.services, self } : null), [start, self]);

	if (start.status === "failed") {
		return (
			<StartFailed
				onRetry={() => {
					setStart({ status: "starting" });
					setAttempt((n) => n + 1);
				}}
			/>
		);
	}
	if (services === null) return <PageLoader />;
	return (
		<ServicesContext value={services}>
			<Screen
				self={self}
				route={route}
				onSelfChange={onSelfChange}
				onSignOut={services.signOut}
				moderator={self.isOperator}
			/>
			<Toast />
			<AppBadge />
		</ServicesContext>
	);
}

interface ScreenProps {
	self: SelfUser;
	route: Route;
	onSelfChange: (self: SelfUser) => void;
	onSignOut: () => void;
	moderator: boolean;
}

function Screen({ self, route, onSelfChange, onSignOut, moderator }: ScreenProps) {
	const services = useServices();
	const api = useApi();
	if (route.name === "home" || route.name === "chat" || route.name === "invite" || route.name === "contacts" || route.name === "bot") {
		return <ChatScreen self={self} route={route} />;
	}
	// Started on every render: the requests are shared, so this only starts what a new route needs.
	const parts = screenParts(route, services, api);
	let screen: ReactNode;
	switch (route.name) {
		case "settings":
			screen = (
				<Settings
					tab={route.tab}
					list={route.list === true}
					self={self}
					onSelfChange={onSelfChange}
					messaging={{
						onSignOut,
						moderation: moderator,
						render: (tab: SettingsTab): ReactNode => <SettingsExtra tab={tab} />,
						photo: <SettingsExtra tab="profile" self={self} onSelfChange={onSelfChange} />,
						avatar: <ChatAvatar id={self.id} name={self.name} photoOf={self.id} photoId={self.photoId} />,
						feedback: (onClose) => (
							<Suspense fallback={null}>
								<FeedbackDialog onClose={onClose} />
							</Suspense>
						),
					}}
				/>
			);
			break;
		case "console":
			screen = <DeveloperConsole view={route.view} />;
			break;
		case "moderation":
			screen = <Moderation view={route.reportId === null ? { page: "queue" } : { page: "report", reportId: route.reportId, actions: route.actions }} />;
			break;
		case "feedback":
			screen = <Moderation view={{ page: "feedback" }} />;
			break;
		case "announcements":
			screen = <Moderation view={{ page: "announcements" }} />;
			break;
		case "moderationLog":
			screen = <Moderation view={{ page: "log" }} />;
			break;
		case "moderationBot":
			screen = <Moderation view={{ page: "bot", botId: route.botId }} />;
			break;
	}
	return (
		<Shell
			self={self}
			route={route}
			nav={<ContactsLink />}
			avatar={<ChatAvatar id={self.id} name={self.name} size="sm" photoOf={self.id} photoId={self.photoId} />}
		>
			<LoaderBoundary key={route.name}>
				<Ready parts={parts}>{screen}</Ready>
			</LoaderBoundary>
		</Shell>
	);
}

/**
 * The app badge: unread messages in the tab title and, where the browser has
 * it, on the installed app's icon. Muted chats count only when the user chose
 * so (NotificationSettings.badgeMuted). Counted by ChatStore from the same
 * dialogs as the chat list and folder badges, so they always agree.
 */
function AppBadge() {
	const { messages } = useUnreadTotals();
	const base = useRef(document.title.replace(/^\(\d+\+?\) /, ""));
	useEffect(() => {
		document.title = messages > 0 ? `(${countLabel(messages)}) ${base.current}` : base.current;
		if (typeof navigator.setAppBadge === "function") {
			(messages > 0 ? navigator.setAppBadge(messages) : navigator.clearAppBadge()).catch(() => undefined);
		}
	}, [messages]);
	useEffect(() => {
		const title = base.current;
		return () => {
			document.title = title;
			if (typeof navigator.clearAppBadge === "function") navigator.clearAppBadge().catch(() => undefined);
		};
	}, []);
	return null;
}

/** The rail link to the contacts list (mockups/settings.html rail). */
function ContactsLink() {
	"use no memo";
	const copy = useCopy();
	return (
		<Link to={paths.contacts()} className="icon-btn" aria-label={copy.folders.contacts}>
			<ContactsGlyph />
		</Link>
	);
}

function StartFailed({ onRetry }: { onRetry: () => void }) {
	"use no memo";
	const { t } = useI18n();
	const copy = useCopy();
	return (
		<main className="welcome">
			<div className="boot-error">
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.common.loadFailed}</span>
					<button type="button" className="btn btn-sm" onClick={onRetry}>
						{t.common.retry}
					</button>
				</div>
			</div>
		</main>
	);
}

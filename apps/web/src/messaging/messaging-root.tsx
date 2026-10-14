// Entry of the signed-in app (chat list, chats, contacts, settings), loaded
// lazily after sign-in so the welcome screen stays small. It starts the client
// core once per signed-in session and keeps it alive across the chat, settings
// and moderation screens.
import type { Transport } from "@connectrpc/connect";
import { Suspense, lazy, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import type { SelfUser } from "../api/adapters.ts";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, navigate, paths, type Route, type SettingsTab } from "../router.tsx";
import { Shell } from "../screens/shell.tsx";
import "../styles/messaging.css";
import { useCopy } from "./copy/use-copy.ts";
import { countLabel } from "./data/format.ts";
import { webConnector, type MessagingClient, type MessagingConnector } from "./data/connector.ts";
import { Drafts } from "./data/drafts.ts";
import type { PendingBackend } from "./data/pending-backend.ts";
import { decideNotification, type NotificationInput } from "./data/notification-filter.ts";
import { createRemote } from "./data/remote.ts";
import { ServicesContext, Toasts, useUnreadTotals, type Services } from "./data/services.tsx";
import { ChatStore } from "./data/store.ts";
import { ChatScreen } from "./ui/chat-screen.tsx";
import { ContactsGlyph } from "./ui/contacts-glyph.tsx";
import { Toast } from "./ui/parts.tsx";

// Settings and moderation load when opened, keeping the first chat screen small.
const Settings = lazy(() => import("../screens/settings/settings.tsx").then((m) => ({ default: m.Settings })));
const SettingsExtra = lazy(() => import("./settings/settings-extra.tsx"));
const Moderation = lazy(() => import("./moderation/moderation.tsx"));

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
					const decision = decideNotification(request, store.dialog(request.chatId), settings, Math.floor(Date.now() / 1000), hiddenBody);
					// The soft tone loads on first use; the system notification itself is silent.
					if (decision !== null && settings.sound === "soft") void import("./data/sound.ts").then((sound) => sound.playTone("soft"));
					return decision;
				},
			}),
		).then(
			(client) => {
				const store = new ChatStore(client.source, { selfId: self.id, onError: (err, context) => reportError(context, String(err)) }, client.coldSnapshot());
				const remote = createRemote(transport, () => signedOut());
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
					backend,
					toasts: new Toasts(),
					drafts,
					signOut: () => {
						drafts.clear();
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
	if (services === null) return <Starting />;
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
	switch (route.name) {
		case "home":
		case "chat":
		case "invite":
		case "contacts":
			return <ChatScreen self={self} route={route} />;
		case "settings":
			return (
				<Shell self={self} route={route} nav={<ContactsLink />}>
					<Suspense fallback={<Loading />}>
						<Settings
							tab={route.tab}
							self={self}
							onSelfChange={onSelfChange}
							messaging={{
								onSignOut,
								moderation: moderator,
								render: (tab: SettingsTab): ReactNode => (
									<Suspense fallback={<Loading />}>
										<SettingsExtra tab={tab} />
									</Suspense>
								),
							}}
						/>
					</Suspense>
				</Shell>
			);
		case "moderation":
			return (
				<Shell self={self} route={route} nav={<ContactsLink />}>
					<Suspense fallback={<Loading />}>
						<Moderation reportId={route.reportId} actions={route.actions} />
					</Suspense>
				</Shell>
			);
	}
}

/**
 * The app badge: unread messages in the tab title and, where the browser has
 * it, on the installed app's icon. Muted chats count only when the user chose
 * so (core unreadTotals with NotificationSettings.badgeMuted).
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
	const copy = useCopy();
	return (
		<Link to={paths.contacts()} className="icon-btn" aria-label={copy.folders.contacts}>
			<ContactsGlyph />
		</Link>
	);
}

function Loading() {
	const { t } = useI18n();
	return (
		<p className="status pad">
			<span className="spin" aria-hidden="true" />
			{t.common.loading}
		</p>
	);
}

function Starting() {
	const { t } = useI18n();
	return (
		<main className="welcome" aria-busy="true">
			<p className="status">
				<span className="spin" aria-hidden="true" />
				{t.common.loading}
			</p>
		</main>
	);
}

function StartFailed({ onRetry }: { onRetry: () => void }) {
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

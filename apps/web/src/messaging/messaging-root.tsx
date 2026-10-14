// Entry of the signed-in app (chat list, chats, contacts, settings), loaded
// lazily after sign-in so the welcome screen stays small. It starts the client
// core once per signed-in session and keeps it alive across the chat, settings
// and moderation screens.
import type { Transport } from "@connectrpc/connect";
import { Suspense, lazy, useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";
import type { SelfUser } from "../api/adapters.ts";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, navigate, paths, type Route, type SettingsTab } from "../router.tsx";
import { Settings } from "../screens/settings/settings.tsx";
import { Shell } from "../screens/shell.tsx";
import "../styles/messaging.css";
import { useCopy } from "./copy/use-copy.ts";
import { webConnector, type MessagingClient, type MessagingConnector } from "./data/connector.ts";
import { Drafts } from "./data/drafts.ts";
import type { PendingBackend } from "./data/pending-backend.ts";
import { createRemote } from "./data/remote.ts";
import { ServicesContext, Toasts, type Services } from "./data/services.tsx";
import { ChatStore } from "./data/store.ts";
import { ChatScreen } from "./ui/chat-screen.tsx";
import { ContactsGlyph } from "./ui/contacts-glyph.tsx";
import { Toast } from "./ui/parts.tsx";

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

	useEffect(() => {
		let active = true;
		let started: { client: MessagingClient; store: ChatStore; backend: PendingBackend } | null = null;
		Promise.resolve(
			connector({
				onSessionEnded: () => signedOut(),
				onNotificationClick: (chatId) => navigate(paths.chat(chatId)),
				onError: reportError,
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

	// Moderators get a link to the queue in settings (no RPC yet: see pending-backend).
	const [moderator, setModerator] = useState(false);
	useEffect(() => {
		if (start.status !== "ready") return;
		let active = true;
		start.services.backend.moderationScope().then(
			(scope) => {
				if (active) setModerator(scope !== null);
			},
			() => undefined,
		);
		return () => {
			active = false;
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
				moderator={moderator}
				blockedList={services.backend.features.has("blockedList")}
			/>
			<Toast />
		</ServicesContext>
	);
}

interface ScreenProps {
	self: SelfUser;
	route: Route;
	onSelfChange: (self: SelfUser) => void;
	onSignOut: () => void;
	moderator: boolean;
	/** The server lists blocked people (the settings tab needs it). */
	blockedList: boolean;
}

function Screen({ self, route, onSelfChange, onSignOut, moderator, blockedList }: ScreenProps) {
	switch (route.name) {
		case "home":
		case "chat":
		case "invite":
		case "contacts":
			return <ChatScreen self={self} route={route} />;
		case "settings":
			return (
				<Shell self={self} route={route} nav={<ContactsLink />}>
					<Settings
						tab={route.tab}
						self={self}
						onSelfChange={onSelfChange}
						messaging={{
							onSignOut,
							moderation: moderator,
							blockedList,
							render: (tab: SettingsTab): ReactNode => (
								<Suspense fallback={<Loading />}>
									<SettingsExtra tab={tab} />
								</Suspense>
							),
						}}
					/>
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

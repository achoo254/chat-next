import { Code, type Transport } from "@connectrpc/connect";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { SelfUser } from "./api/adapters.ts";
import { ApiContext } from "./api/api-context.tsx";
import { createApi, createWebTransport, errorCode, sameOriginFetch, type RpcFetch } from "./api/client.ts";
import { forgetSelf, lastSelf, rememberSelf } from "./api/offline-self.ts";
import { PageLoader } from "./components/brand-loader.tsx";
import { Icon } from "./components/icon.tsx";
import { UpdateBar } from "./components/update-bar.tsx";
import { I18nProvider, useI18n } from "./i18n/i18n.tsx";
import { matchLegal, matchRoute, navigate, paths, usePathname } from "./router.tsx";
import type { MessagingConnector } from "./messaging/data/connector.ts";

// The signed-in app is its own chunk, so the welcome screen stays small.
const MessagingRoot = lazy(() => import("./messaging/messaging-root.tsx"));
// Shown instead of the app while the account waits for deletion.
const DeletionPending = lazy(() => import("./screens/deletion-pending.tsx"));
// Only a signed-out start shows it, so a signed-in start does not load it.
const Welcome = lazy(() => import("./screens/welcome.tsx").then((module) => ({ default: module.Welcome })));
// Privacy policy, terms and account deletion: public, so they never wait for sign-in.
const LegalScreen = lazy(() => import("./screens/legal/legal-screen.tsx"));

export interface AppProps {
	/** How RPCs reach the server; tests and the visual harness serve them in memory. */
	rpcFetch?: RpcFetch | undefined;
	/** Tests and the visual harness provide the chat client; production uses the web worker. */
	messagingConnector?: MessagingConnector | undefined;
}

type Boot =
	| { status: "loading" }
	| { status: "signedOut" }
	| { status: "error" }
	| { status: "ready"; self: SelfUser }
	| { status: "deletionPending"; self: SelfUser };

export function App({ rpcFetch = sameOriginFetch, messagingConnector }: AppProps) {
	const legal = matchLegal(usePathname());
	return (
		// The provider suspends only when the remembered language is English and
		// its copy is still loading; the page's own splash stays up meanwhile.
		<Suspense fallback={null}>
			<I18nProvider>
				{legal === null ? (
					<Root rpcFetch={rpcFetch} messagingConnector={messagingConnector} />
				) : (
					<Suspense fallback={<PageLoader />}>
						<LegalScreen page={legal} />
					</Suspense>
				)}
				<UpdateBar />
			</I18nProvider>
		</Suspense>
	);
}

function Root({ rpcFetch, messagingConnector }: { rpcFetch: RpcFetch; messagingConnector: MessagingConnector | undefined }) {
	const [boot, setBoot] = useState<Boot>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const signedOut = useCallback(() => {
		forgetSelf();
		setBoot({ status: "signedOut" });
	}, []);
	const transport = useMemo(() => createWebTransport(rpcFetch), [rpcFetch]);
	const api = useMemo(() => createApi(transport, rpcFetch, signedOut), [transport, rpcFetch, signedOut]);

	useEffect(() => {
		let active = true;
		api.getSelf().then(
			(self) => {
				if (self.deletion !== undefined) {
					// Locked: nothing of the app opens, not even offline.
					forgetSelf();
					if (active) setBoot({ status: "deletionPending", self });
					return;
				}
				rememberSelf(self);
				if (active) setBoot({ status: "ready", self });
			},
			(err: unknown) => {
				// Unauthenticated already switched to the welcome screen through the api hook.
				if (!active || errorCode(err) === Code.Unauthenticated) return;
				// No answer (offline, server down): open the chats stored on this device
				// when there are some; the client core reconnects on its own.
				const known = lastSelf();
				setBoot(known === null ? { status: "error" } : { status: "ready", self: known });
			},
		);
		return () => {
			active = false;
		};
	}, [api, attempt]);

	const retry = () => {
		setBoot({ status: "loading" });
		setAttempt((n) => n + 1);
	};
	// Profile edits return the user without the operator flag; it stays what sign-in said.
	const setSelf = useCallback(
		(self: SelfUser) =>
			setBoot((current) => {
				const next = current.status === "ready" ? { ...self, isOperator: current.self.isOperator } : self;
				rememberSelf(next);
				return { status: "ready", self: next };
			}),
		[],
	);

	switch (boot.status) {
		case "loading":
			return <PageLoader />;
		case "signedOut":
			return (
				<Suspense fallback={<PageLoader />}>
					<Welcome />
				</Suspense>
			);
		case "error":
			return <BootError onRetry={retry} />;
		case "deletionPending":
			return (
				<Suspense fallback={<PageLoader />}>
					<DeletionPending self={boot.self} rpcFetch={rpcFetch} onRestored={retry} />
				</Suspense>
			);
		case "ready":
			return (
				<ApiContext value={api}>
					<SignedIn
						self={boot.self}
						onSelfChange={setSelf}
						onSignedOut={signedOut}
						transport={transport}
						messagingConnector={messagingConnector}
					/>
				</ApiContext>
			);
	}
}

interface SignedInProps {
	self: SelfUser;
	onSelfChange: (self: SelfUser) => void;
	onSignedOut: () => void;
	transport: Transport;
	messagingConnector: MessagingConnector | undefined;
}

function SignedIn({ self, onSelfChange, onSignedOut, transport, messagingConnector }: SignedInProps) {
	const pathname = usePathname();
	const route = matchRoute(pathname);
	const known = route !== null;

	useEffect(() => {
		if (!known) navigate(paths.home, { replace: true });
	}, [known]);

	if (!route) return null;
	return (
		<Suspense fallback={<PageLoader />}>
			<MessagingRoot
				self={self}
				route={route}
				transport={transport}
				onSelfChange={onSelfChange}
				onSignedOut={onSignedOut}
				{...(messagingConnector === undefined ? {} : { connector: messagingConnector })}
			/>
		</Suspense>
	);
}

function BootError({ onRetry }: { onRetry: () => void }) {
	"use no memo";
	const { t } = useI18n();
	return (
		<main className="welcome">
			<div className="boot-error">
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{t.common.networkError}</span>
					<button type="button" className="btn btn-sm" onClick={onRetry}>
						{t.common.retry}
					</button>
				</div>
			</div>
		</main>
	);
}

import { Code, type Transport } from "@connectrpc/connect";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { SelfUser } from "./api/adapters.ts";
import { ApiContext } from "./api/api-context.tsx";
import { createApi, createWebTransport, errorCode, sameOriginFetch, type RpcFetch } from "./api/client.ts";
import { PageLoader } from "./components/brand-loader.tsx";
import { Icon } from "./components/icon.tsx";
import { I18nProvider, useI18n } from "./i18n/i18n.tsx";
import { matchRoute, navigate, paths, usePathname } from "./router.tsx";
import { Welcome } from "./screens/welcome.tsx";
import type { MessagingConnector } from "./messaging/data/connector.ts";

// The signed-in app is its own chunk, so the welcome screen stays small.
const MessagingRoot = lazy(() => import("./messaging/messaging-root.tsx"));

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
	| { status: "ready"; self: SelfUser };

export function App({ rpcFetch = sameOriginFetch, messagingConnector }: AppProps) {
	return (
		<I18nProvider>
			<Root rpcFetch={rpcFetch} messagingConnector={messagingConnector} />
		</I18nProvider>
	);
}

function Root({ rpcFetch, messagingConnector }: { rpcFetch: RpcFetch; messagingConnector: MessagingConnector | undefined }) {
	const [boot, setBoot] = useState<Boot>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const signedOut = useCallback(() => setBoot({ status: "signedOut" }), []);
	const transport = useMemo(() => createWebTransport(rpcFetch), [rpcFetch]);
	const api = useMemo(() => createApi(transport, rpcFetch, signedOut), [transport, rpcFetch, signedOut]);

	useEffect(() => {
		let active = true;
		api.getSelf().then(
			(self) => {
				if (active) setBoot({ status: "ready", self });
			},
			(err: unknown) => {
				// Unauthenticated already switched to the welcome screen through the api hook.
				if (active && errorCode(err) !== Code.Unauthenticated) setBoot({ status: "error" });
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
		(self: SelfUser) => setBoot((current) => ({ status: "ready", self: current.status === "ready" ? { ...self, isOperator: current.self.isOperator } : self })),
		[],
	);

	switch (boot.status) {
		case "loading":
			return <PageLoader />;
		case "signedOut":
			return <Welcome />;
		case "error":
			return <BootError onRetry={retry} />;
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

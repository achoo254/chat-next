import { Code, type Transport } from "@connectrpc/connect";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { SelfUser } from "./api/adapters.ts";
import { ApiContext } from "./api/api-context.tsx";
import { createApi, errorCode } from "./api/client.ts";
import { Icon } from "./components/icon.tsx";
import { I18nProvider, useI18n } from "./i18n/i18n.tsx";
import { matchRoute, navigate, paths, usePathname } from "./router.tsx";
import { Welcome } from "./screens/welcome.tsx";
import type { MessagingConnector } from "./messaging/data/connector.ts";

// The signed-in app is its own chunk, so the welcome screen stays small.
const MessagingRoot = lazy(() => import("./messaging/messaging-root.tsx"));

export interface AppProps {
	transport: Transport;
	/** Tests and the visual harness provide the chat client; production uses the web worker. */
	messagingConnector?: MessagingConnector | undefined;
}

type Boot =
	| { status: "loading" }
	| { status: "signedOut" }
	| { status: "error" }
	| { status: "ready"; self: SelfUser };

export function App({ transport, messagingConnector }: AppProps) {
	return (
		<I18nProvider>
			<Root transport={transport} messagingConnector={messagingConnector} />
		</I18nProvider>
	);
}

function Root({ transport, messagingConnector }: AppProps) {
	const [boot, setBoot] = useState<Boot>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const signedOut = useCallback(() => setBoot({ status: "signedOut" }), []);
	const api = useMemo(() => createApi(transport, signedOut), [transport, signedOut]);

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
			return <Loading />;
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
		<Suspense fallback={<Loading />}>
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

function Loading() {
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

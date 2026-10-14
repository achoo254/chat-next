import { Code, type Transport } from "@connectrpc/connect";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelfUser } from "./api/adapters.ts";
import { ApiContext } from "./api/api-context.tsx";
import { createApi, errorCode } from "./api/client.ts";
import { Icon } from "./components/icon.tsx";
import { I18nProvider, useI18n } from "./i18n/i18n.tsx";
import { matchRoute, navigate, paths, usePathname } from "./router.tsx";
import { Home } from "./screens/home.tsx";
import { Settings } from "./screens/settings/settings.tsx";
import { Shell } from "./screens/shell.tsx";
import { Welcome } from "./screens/welcome.tsx";

type Boot =
	| { status: "loading" }
	| { status: "signedOut" }
	| { status: "error" }
	| { status: "ready"; self: SelfUser };

export function App({ transport }: { transport: Transport }) {
	return (
		<I18nProvider>
			<Root transport={transport} />
		</I18nProvider>
	);
}

function Root({ transport }: { transport: Transport }) {
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
	const setSelf = useCallback((self: SelfUser) => setBoot({ status: "ready", self }), []);

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
					<SignedIn self={boot.self} onSelfChange={setSelf} />
				</ApiContext>
			);
	}
}

function SignedIn({ self, onSelfChange }: { self: SelfUser; onSelfChange: (self: SelfUser) => void }) {
	const pathname = usePathname();
	const route = matchRoute(pathname);
	const known = route !== null;

	useEffect(() => {
		if (!known) navigate(paths.home, { replace: true });
	}, [known]);

	if (!route) return null;
	return (
		<Shell self={self} route={route}>
			{route.name === "home" ? (
				<Home self={self} />
			) : (
				<Settings tab={route.tab} self={self} onSelfChange={onSelfChange} />
			)}
		</Shell>
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

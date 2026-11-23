// Settings › Kết nối ứng dụng (Chat Bridge, ADR 0022): connect an account of
// another app (Telegram first), choose which conversations Chat copies in and
// how much history, see their progress, and disconnect. Everything is a page in
// the settings frame (docs/settings-menu.md); a confirmation is inline, never a
// dialog standing in for the page. The phone number, code and password go to
// the server in the call that needs them and are never kept here. Connecting
// never asks to sign in to Chat again: the other app's own proof is enough.
import { lazy, Suspense, useEffect, useEffectEvent, useState } from "react";
import { initials } from "../../components/avatar.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useServices } from "../data/services.tsx";
import type { BridgeAccount, BridgeApi, BridgeError, BridgeLoginProps, BridgeStatus } from "./bridge-api.ts";
import { bridgeClient, bridgeError } from "./bridge-client.ts";
import { BridgeFieldsLogin } from "./bridge-fields-login.tsx";
import { BridgeQrLogin } from "./bridge-qr-login.tsx";
import { PRIVATE_TEXT_APPS, QR_LOGIN_APPS } from "./qr-login-model.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import "./bridge-settings.css";

const BridgeAccountTools = lazy(() => import("./bridge-account-tools.tsx").then((m) => ({ default: m.BridgeAccountTools })));

/** How often the progress of an import is read while one runs. */
const PROGRESS_POLL_MS = 3000;

type Load = { status: "loading" } | { status: "error"; disabled: boolean } | { status: "ready"; value: BridgeStatus };

export default function BridgeSettings() {
	const t = useBridgeCopy();
	const { transport } = useServices();
	const api = bridgeClient(transport);
	const [load, setLoad] = useState<Load>({ status: "loading" });
	/** The app being signed in to (a new connection, or an account that needs a new login). */
	const [signingIn, setSigningIn] = useState<string | null>(null);

	const refresh = () => {
		api.status().then(
			(value) => setLoad({ status: "ready", value }),
			(err: unknown) => setLoad({ status: "error", disabled: bridgeError(err).kind === "disabled" }),
		);
	};
	const poll = useEffectEvent(refresh);
	useEffect(() => {
		poll();
	}, []);
	const importing = load.status === "ready" && load.value.accounts.some((a) => a.syncState === "syncing" || a.chats.some((c) => !c.caughtUp));
	useEffect(() => {
		if (!importing) return;
		const timer = setInterval(poll, PROGRESS_POLL_MS);
		return () => clearInterval(timer);
	}, [importing]);

	const onError = bridgeError;

	if (load.status === "loading") return <div className="set-body" aria-busy="true" />;
	if (load.status === "error") {
		return (
			<div className="set-body">
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{load.disabled ? t.disabled : t.loadFailed}</span>
					{!load.disabled && (
						<button type="button" className="btn btn-sm" onClick={() => { setLoad({ status: "loading" }); refresh(); }}>
							{t.retry}
						</button>
					)}
				</div>
			</div>
		);
	}
	const { apps, accounts } = load.value;
	const appName = (source: string): string => t.apps[source] ?? t.appFallback(source);
	return (
		<div className="set-body">
			<p className="lede">
				<Icon name="plug" small />
				{t.lede}
			</p>
			{accounts.map((account) => (
				<AccountCard
					key={account.id}
					account={account}
					api={api}
					appName={appName(account.source)}
					onChange={refresh}
					onError={onError}
					onSignIn={() => setSigningIn(account.source)}
				/>
			))}
			{signingIn !== null && (
				<SignInCard
					qr={QR_LOGIN_APPS.has(signingIn)}
					key={signingIn}
					api={api}
					source={signingIn}
					appName={appName(signingIn)}
					onDone={() => {
						setSigningIn(null);
						refresh();
					}}
					onCancel={() => setSigningIn(null)}
					onError={onError}
				/>
			)}
			{signingIn === null && (
				<section className="card br-account" data-id="bridge-apps">
					<h2 className="br-title br-title-first">{t.sources.title}</h2>
					{apps.length === 0 && <p className="note pad-x">{t.sources.none}</p>}
					{apps.map((source) => (
						<div className="br-chat br-source" key={source}>
							<span className="avatar av-blue" aria-hidden="true">
								{initials(appName(source))}
							</span>
							<span className="grow br-text">
								<b>{appName(source)}</b>
							</span>
							<button type="button" className="btn btn-sm btn-primary" onClick={() => setSigningIn(source)}>
								{t.sources.connect}
							</button>
						</div>
					))}
					{apps.length > 0 && (
						<p className="br-readonly">
							<Icon name="lock" small />
							<small className="muted">{t.sources.note}</small>
						</p>
					)}
				</section>
			)}
		</div>
	);
}

/** A QR app (Zalo) signs in with its own card (a notice first, then the code); the others ask for fields. Both share one frame. */
function SignInCard({ qr, ...props }: BridgeLoginProps & { qr: boolean }) {
	return qr ? <BridgeQrLogin {...props} /> : <BridgeFieldsLogin {...props} />;
}

function AccountCard({
	account,
	api,
	appName,
	onChange,
	onError,
	onSignIn,
}: {
	account: BridgeAccount;
	api: BridgeApi;
	appName: string;
	onChange: () => void;
	onError: (err: unknown) => BridgeError;
	onSignIn: () => void;
}) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const [disconnecting, setDisconnecting] = useState(false);
	const [busy, setBusy] = useState(false);
	const fail = () => {
		setBusy(false);
		toasts.show(t.failed);
	};
	const disconnect = (deleteChats: boolean) => {
		setBusy(true);
		api.disconnect(account.id, deleteChats).then(() => {
			setBusy(false);
			setDisconnecting(false);
			toasts.show(t.disconnect.done);
			onChange();
		}, fail);
	};
	return (
		<section className="card br-account" data-id="bridge-account">
			<div className="br-head">
				<span className="avatar av-blue" aria-hidden="true">
					{initials(appName)}
				</span>
				<span className="grow br-text">
					<b>{appName}</b>
					<small className="br-status" data-state={account.status}>
						<i aria-hidden="true" />
						{t.account.status[account.status]}
					</small>
					{account.lastError !== "" && <small>{t.account.lastError(account.lastError)}</small>}
				</span>
				{account.status === "needs_login" && (
					<button type="button" className="btn btn-sm" onClick={onSignIn}>
						{t.account.reconnect}
					</button>
				)}
				{account.status !== "stopped" && !disconnecting && (
					<button type="button" className="btn btn-sm" onClick={() => setDisconnecting(true)}>
						{t.disconnect.button}
					</button>
				)}
			</div>
			{disconnecting && (
				<div className="callout pad-x" role="group" aria-label={t.disconnect.title}>
					<p>
						<b>{t.disconnect.title}</b> {t.disconnect.body}
					</p>
					<div className="row">
						<button type="button" className="btn btn-sm" disabled={busy} onClick={() => disconnect(false)}>
							{t.disconnect.keep}
						</button>
						<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => disconnect(true)}>
							{t.disconnect.deleteAll}
						</button>
						<button type="button" className="btn btn-sm" onClick={() => setDisconnecting(false)}>
							{t.disconnect.cancel}
						</button>
					</div>
				</div>
			)}
			<SyncPanel account={account} api={api} appName={appName} onChange={onChange} />
			<Suspense fallback={null}>
				<BridgeAccountTools accountId={account.id} api={api} onChange={onChange} onError={onError} />
			</Suspense>
		</section>
	);
}

/**
 * The account's one switch (ADR 0024): asked once after the sign-in, then a progress bar
 * over every conversation while the first import runs, then the live state.
 */
function SyncPanel({
	account,
	api,
	appName,
	onChange,
}: {
	account: BridgeAccount;
	api: BridgeApi;
	appName: string;
	onChange: () => void;
}) {
	const t = useBridgeCopy();
	// What the user is promised depends on what the app syncs: one that syncs only private text says so.
	const words = PRIVATE_TEXT_APPS.has(account.source) ? { ...t.sync, ...t.sync.privateText } : t.sync;
	const { toasts } = useServices();
	const { locale } = useI18n();
	const [later, setLater] = useState(false);
	const [busy, setBusy] = useState(false);
	const count = (n: number) => n.toLocaleString(locale);
	const start = () => {
		setBusy(true);
		api.startSync(account.id).then(
			() => {
				setBusy(false);
				onChange();
			},
			() => {
				setBusy(false);
				toasts.show(t.failed);
			},
		);
	};
	if (account.status !== "active" && account.syncState === "off") return null;
	if (account.syncState === "off") {
		if (later) {
			return (
				<div className="br-sync" data-state="later">
					<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={start}>
						{words.startLater(appName)}
					</button>
				</div>
			);
		}
		return (
			<div className="callout br-sync" data-state="off" role="group" aria-label={words.ask(appName)}>
				<p>
					<b>{words.ask(appName)}</b>
				</p>
				<p className="muted">{words.askBody}</p>
				<div className="row">
					<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={start}>
						{t.sync.start}
					</button>
					<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setLater(true)}>
						{t.sync.later}
					</button>
				</div>
			</div>
		);
	}
	const p = account.progress;
	if (account.syncState === "syncing") {
		const share = p.messagesExpected > 0 ? Math.min(1, p.messages / p.messagesExpected) : 0;
		return (
			<div className="br-sync" data-state="syncing">
				<p>
					<b>{t.sync.syncing}</b>
				</p>
				<progress className="br-progress" max={1} value={share} aria-label={t.sync.syncing} />
				<small className="muted">{t.sync.progress(p.conversationsDone, p.conversations, count(p.messages), count(p.messagesExpected))}</small>
			</div>
		);
	}
	return (
		<div className="br-sync" data-state="live">
			<small className="br-status" data-state="active">
				<i aria-hidden="true" />
				{t.sync.live}
			</small>
			<small className="muted">{words.liveBody(p.conversations)}</small>
		</div>
	);
}

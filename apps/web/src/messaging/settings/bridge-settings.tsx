// Settings › Kết nối ứng dụng (Chat Bridge, ADR 0022): connect an account of
// another app (Telegram first), choose which conversations Chat copies in and
// how much history, see their progress, and disconnect. Everything is a page in
// the settings frame (docs/settings-menu.md); a confirmation is inline, never a
// dialog standing in for the page. The phone number, code and password go to
// the server in the call that needs them and are never kept here.
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { signInUrl } from "@achoo254/chat-core";
import { initials } from "../../components/avatar.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";
import {
	BridgeError,
	type BridgeAccount,
	type BridgeApi,
	type BridgeStatus,
	type LoginStep,
} from "./bridge-api.ts";
import { bridgeClient, bridgeError } from "./bridge-client.ts";
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
	// How many times an action was refused for a sign-in that is too old.
	const [reauth, setReauth] = useState(0);
	const reauthBanner = useRef<HTMLDivElement>(null);
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

	const onError = (err: unknown): BridgeError => {
		const error = bridgeError(err);
		if (error.kind === "reauth") setReauth((n) => n + 1);
		return error;
	};
	// The refused action may be far below the banner (the chat picker): bring the banner into view each time, or the click looks like it did nothing.
	useEffect(() => {
		if (reauth > 0) reauthBanner.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
	}, [reauth]);

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
			{reauth > 0 && (
				<div ref={reauthBanner}>
					<ReauthBanner />
				</div>
			)}
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
				<LoginCard
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

/** The sign-in that carries on here after the reauthentication. */
function ReauthBanner() {
	const t = useBridgeCopy();
	const { locale } = useI18n();
	return (
		<div className="banner" role="alert">
			<Icon name="lock" small />
			<span className="grow">{t.reauth.body}</span>
			<a className="btn btn-sm" href={signInUrl(locale, { reauth: true, returnTo: paths.settings("bridge") })}>
				{t.reauth.signIn}
			</a>
		</div>
	);
}

/**
 * What a failed login step says to the user. A reauthentication needs no text
 * here: the page banner already carries the "sign in again" link.
 */
function loginErrorText(error: BridgeError, t: ReturnType<typeof useBridgeCopy>): string {
	switch (error.kind) {
		case "reauth":
			return "";
		case "wrong_input":
			return t.login.errors[error.detail] ?? t.failed;
		case "rate_limited":
			return t.login.rateLimited;
		case "account_taken":
			return t.login.accountTaken;
		default:
			return t.failed;
	}
}

/** The steps of a login: each shows the fields the app asks for (phone, code, two-step password). */
function LoginCard({
	api,
	source,
	appName,
	onDone,
	onCancel,
	onError,
}: {
	api: BridgeApi;
	source: string;
	appName: string;
	onDone: () => void;
	onCancel: () => void;
	onError: (err: unknown) => BridgeError;
}) {
	const t = useBridgeCopy();
	const [step, setStep] = useState<LoginStep | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const advance = (next: LoginStep) => {
		if (next.kind === "done") return onDone();
		setStep(next);
		setValues({});
		setError("");
	};
	const begin = useEffectEvent(() => {
		api.startLogin(source).then(advance, (err: unknown) => setError(loginErrorText(onError(err), t)));
	});
	useEffect(() => {
		begin();
	}, []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (step === null || step.kind === "done") return;
		setBusy(true);
		setError("");
		api.continueLogin(step.loginId, values).then(
			(next) => {
				setBusy(false);
				advance(next);
			},
			(err: unknown) => {
				setBusy(false);
				setError(loginErrorText(onError(err), t));
			},
		);
	};
	const fields = step?.kind === "input" ? step.fields : [];
	const ready = fields.length > 0 && fields.every((f) => (values[f.name] ?? "").trim() !== "");
	return (
		<form className="card pad" data-id="bridge-login" onSubmit={submit}>
			<h2 className="card-title flush">{t.login.title(appName)}</h2>
			{step !== null && step.kind !== "done" && step.prompt !== "" && <p className="note">{step.prompt}</p>}
			{step?.kind === "qr" && <p className="note">{t.login.scan}</p>}
			{step?.kind === "confirm" && <p className="note">{t.login.confirm}</p>}
			{fields.map((field) => (
				<label className="field" key={field.name}>
					<span>{t.login.fields[field.name] ?? field.label}</span>
					<input
						className="input"
						name={field.name}
						type={field.name === "phone" ? "tel" : field.secret ? "password" : "text"}
						inputMode={field.name === "code" ? "numeric" : undefined}
						autoComplete="off"
						value={values[field.name] ?? ""}
						onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
					/>
				</label>
			))}
			{error !== "" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{error}</span>
				</div>
			)}
			<div className="row">
				<button type="submit" className="btn primary" disabled={busy || !ready}>
					{t.login.next}
				</button>
				<button type="button" className="btn" onClick={onCancel}>
					{t.login.cancel}
				</button>
			</div>
		</form>
	);
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
	const fail = (err: unknown) => {
		setBusy(false);
		if (onError(err).kind !== "reauth") toasts.show(t.failed);
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
			<SyncPanel account={account} api={api} appName={appName} onChange={onChange} onError={onError} />
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
	onError,
}: {
	account: BridgeAccount;
	api: BridgeApi;
	appName: string;
	onChange: () => void;
	onError: (err: unknown) => BridgeError;
}) {
	const t = useBridgeCopy();
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
			(err: unknown) => {
				setBusy(false);
				if (onError(err).kind !== "reauth") toasts.show(t.failed);
			},
		);
	};
	if (account.status !== "active" && account.syncState === "off") return null;
	if (account.syncState === "off") {
		if (later) {
			return (
				<div className="br-sync" data-state="later">
					<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={start}>
						{t.sync.startLater(appName)}
					</button>
				</div>
			);
		}
		return (
			<div className="callout br-sync" data-state="off" role="group" aria-label={t.sync.ask(appName)}>
				<p>
					<b>{t.sync.ask(appName)}</b>
				</p>
				<p className="muted">{t.sync.askBody}</p>
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
			<small className="muted">{t.sync.liveBody(p.conversations)}</small>
		</div>
	);
}

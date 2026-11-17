// Settings › Kết nối ứng dụng (Chat Bridge, ADR 0022): connect an account of
// another app (Telegram first), choose which conversations Chat copies in and
// how much history, see their progress, and disconnect. Everything is a page in
// the settings frame (docs/settings-menu.md); a confirmation is inline, never a
// dialog standing in for the page. The phone number, code and password go to
// the server in the call that needs them and are never kept here.
import { useEffect, useEffectEvent, useState, type FormEvent } from "react";
import { signInUrl } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";
import { Choice } from "../ui/parts.tsx";
import {
	BridgeError,
	DEFAULT_HISTORY_WINDOW,
	HISTORY_WINDOWS,
	type BridgeAccount,
	type BridgeApi,
	type BridgeChat,
	type BridgeConversation,
	type BridgeStatus,
	type LoginStep,
} from "./bridge-api.ts";
import { bridgeClient, bridgeError } from "./bridge-client.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";

/** How often the progress of an import is read while one runs. */
const PROGRESS_POLL_MS = 3000;

type Load = { status: "loading" } | { status: "error"; disabled: boolean } | { status: "ready"; value: BridgeStatus };

export default function BridgeSettings() {
	const t = useBridgeCopy();
	const { transport } = useServices();
	const api = bridgeClient(transport);
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [reauth, setReauth] = useState(false);
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
	const importing = load.status === "ready" && load.value.accounts.some((a) => a.chats.some((c) => !c.caughtUp));
	useEffect(() => {
		if (!importing) return;
		const timer = setInterval(poll, PROGRESS_POLL_MS);
		return () => clearInterval(timer);
	}, [importing]);

	const onError = (err: unknown): BridgeError => {
		const error = bridgeError(err);
		if (error.kind === "reauth") setReauth(true);
		return error;
	};

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
			{reauth && <ReauthBanner />}
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
				<div className="card" data-id="bridge-apps">
					<h2 className="card-title">{t.sources.title}</h2>
					{apps.length === 0 && <p className="note pad-x">{t.sources.none}</p>}
					{apps.map((source) => (
						<div className="row pad-x" key={source}>
							<span className="grow">{appName(source)}</span>
							<button type="button" className="btn btn-sm" onClick={() => setSigningIn(source)}>
								{t.sources.connect}
							</button>
						</div>
					))}
					{apps.length > 0 && <p className="note pad-x">{t.sources.note}</p>}
				</div>
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

/** What a failed login step says to the user. */
function loginErrorText(error: BridgeError, t: ReturnType<typeof useBridgeCopy>): string {
	switch (error.kind) {
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
		<section className="card" data-id="bridge-account">
			<div className="row pad-x">
				<span className="grow">
					<b>{appName}</b>
					<small>{t.account.status[account.status]}</small>
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
						<button type="button" className="btn btn-sm danger" disabled={busy} onClick={() => disconnect(true)}>
							{t.disconnect.deleteAll}
						</button>
						<button type="button" className="btn btn-sm" onClick={() => setDisconnecting(false)}>
							{t.disconnect.cancel}
						</button>
					</div>
				</div>
			)}
			<h3 className="card-title">{t.chats.title}</h3>
			{account.chats.length === 0 ? (
				<p className="note pad-x">{t.chats.none}</p>
			) : (
				account.chats.map((chat) => <SyncedChat key={chat.conversationId} account={account} chat={chat} api={api} onChange={onChange} onError={onError} />)
			)}
			{account.chats.length > 0 && <p className="note pad-x">{t.chats.readOnly}</p>}
			{account.status === "active" && <ChatPicker account={account} api={api} onChange={onChange} onError={onError} />}
		</section>
	);
}

function SyncedChat({
	account,
	chat,
	api,
	onChange,
	onError,
}: {
	account: BridgeAccount;
	chat: BridgeChat;
	api: BridgeApi;
	onChange: () => void;
	onError: (err: unknown) => BridgeError;
}) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const remove = () => {
		setBusy(true);
		api.remove(account.id, chat.conversationId).then(onChange, (err: unknown) => {
			setBusy(false);
			if (onError(err).kind !== "reauth") toasts.show(t.failed);
		});
	};
	return (
		<div className="row pad-x" data-id="bridge-chat">
			<span className="grow">
				{chat.title}
				<small>
					{t.chats.window(chat.historyWindow)} · {chat.caughtUp ? t.chats.caughtUp : t.chats.importing}
				</small>
			</span>
			{confirming ? (
				<>
					<span className="note">{t.chats.removeConfirm}</span>
					<button type="button" className="btn btn-sm danger" disabled={busy} onClick={remove}>
						{t.chats.removeYes}
					</button>
					<button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
						{t.pick.cancel}
					</button>
				</>
			) : (
				<>
					<Link to={paths.chat(chat.chatId)} className="btn btn-sm">
						{t.chats.open}
					</Link>
					<button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
						{t.chats.remove}
					</button>
				</>
			)}
		</div>
	);
}

/** The conversations of the account, to pick the ones to copy and how much history of each. */
function ChatPicker({
	account,
	api,
	onChange,
	onError,
}: {
	account: BridgeAccount;
	api: BridgeApi;
	onChange: () => void;
	onError: (err: unknown) => BridgeError;
}) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const [list, setList] = useState<readonly BridgeConversation[] | "loading" | null>(null);
	const [query, setQuery] = useState("");
	const [choosing, setChoosing] = useState<string | null>(null);
	const [window, setWindow] = useState(DEFAULT_HISTORY_WINDOW);
	const [busy, setBusy] = useState(false);
	const fail = (err: unknown) => {
		setBusy(false);
		if (onError(err).kind !== "reauth") toasts.show(t.failed);
	};
	const load = () => {
		setList("loading");
		api.conversations(account.id).then(setList, (err: unknown) => {
			setList(null);
			fail(err);
		});
	};
	if (list === null) {
		return (
			<div className="row pad-x">
				<button type="button" className="btn" onClick={load}>
					{t.pick.load}
				</button>
			</div>
		);
	}
	if (list === "loading") return <p className="note pad-x">{t.pick.loading}</p>;
	const needle = query.trim().toLocaleLowerCase();
	const shown = list.filter((c) => needle === "" || c.title.toLocaleLowerCase().includes(needle));
	const start = (conversation: BridgeConversation) => {
		setBusy(true);
		api.enable(account.id, conversation.id, window).then(() => {
			setBusy(false);
			setChoosing(null);
			toasts.show(t.pick.started);
			setList(null);
			onChange();
		}, fail);
	};
	return (
		<div data-id="bridge-picker">
			<h3 className="card-title">{t.pick.title}</h3>
			<div className="row pad-x">
				<input className="input grow" type="search" aria-label={t.pick.search} placeholder={t.pick.search} value={query} onChange={(event) => setQuery(event.target.value)} />
			</div>
			{shown.length === 0 && <p className="note pad-x">{t.pick.empty}</p>}
			{shown.map((conversation) => (
				<div key={conversation.id}>
					<div className="row pad-x">
						<span className="grow">
							{conversation.title}
							<small>{t.pick.kind[conversation.kind]}</small>
						</span>
						{conversation.chatId !== 0 ? (
							<span className="tag">{t.pick.synced}</span>
						) : (
							<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setChoosing(choosing === conversation.id ? null : conversation.id)}>
								{t.pick.sync}
							</button>
						)}
					</div>
					{choosing === conversation.id && (
						<div className="callout pad-x">
							<p>{t.pick.window}</p>
							<Choice<string>
								label={t.pick.window}
								value={String(window)}
								options={HISTORY_WINDOWS.map((n) => ({ value: String(n), label: t.pick.windowOption(n) }))}
								onChange={(value) => setWindow(Number(value))}
							/>
							<p className="note">{t.pick.windowNote}</p>
							<div className="row">
								<button type="button" className="btn btn-sm primary" disabled={busy} onClick={() => start(conversation)}>
									{t.pick.start}
								</button>
								<button type="button" className="btn btn-sm" onClick={() => setChoosing(null)}>
									{t.pick.cancel}
								</button>
							</div>
						</div>
					)}
				</div>
			))}
		</div>
	);
}

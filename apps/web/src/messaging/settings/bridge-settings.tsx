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
import { Link, paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";
import { Choice, Switch } from "../ui/parts.tsx";
import {
	BridgeError,
	DEFAULT_HISTORY_WINDOW,
	HISTORY_WINDOWS,
	type BridgeAccount,
	type BridgeApi,
	type BridgeChat,
	type BridgeConversation,
	type BridgeStatus,
	type ConversationKind,
	type LoginStep,
} from "./bridge-api.ts";
import { forgetBridgeStatus } from "./bridge-delivery.ts";
import { bridgeClient, bridgeError } from "./bridge-client.ts";
import { savePending, takePending } from "./bridge-pending.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import "./bridge-settings.css";

const BridgeAccountTools = lazy(() => import("./bridge-account-tools.tsx").then((m) => ({ default: m.BridgeAccountTools })));
const BridgeFeatures = lazy(() => import("./bridge-features.tsx").then((m) => ({ default: m.BridgeFeatures })));

/** Initials for an avatar from a title that may carry emoji or symbols. */
function titleInitials(title: string): string {
	return initials(title.replace(/[^\p{L}\p{N}\s]/gu, ""));
}

/** The kinds of conversation in the order the filter lists them, and the avatar tone of each. */
const KIND_ORDER: readonly ConversationKind[] = ["private", "group", "bot", "channel"];
const KIND_TONE: Record<ConversationKind, string> = { private: "av-blue", group: "av-violet", bot: "av-amber", channel: "av-green" };

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
	const importing = load.status === "ready" && load.value.accounts.some((a) => a.chats.some((c) => !c.caughtUp));
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
			<h3 className="br-title">{t.chats.title}</h3>
			{account.status === "active" && <BulkSend account={account} api={api} appName={appName} onChange={onChange} onError={onError} />}
			<Suspense fallback={null}>
				<BridgeAccountTools accountId={account.id} api={api} appName={appName} chatCount={account.chats.length} onChange={onChange} onError={onError} />
			</Suspense>
			{account.chats.length === 0 ? (
				<p className="note br-pad">{t.chats.none}</p>
			) : (
				account.chats.map((chat) => <SyncedChat key={chat.conversationId} account={account} chat={chat} api={api} appName={appName} onChange={onChange} onError={onError} />)
			)}
			{account.chats.some((c) => c.direction !== "both") && (
				<p className="note br-readonly">
					<Icon name="lock" small />
					{t.chats.readOnly}
				</p>
			)}
			{account.status === "active" && <ChatPicker account={account} api={api} appName={appName} onChange={onChange} onError={onError} />}
		</section>
	);
}

/** Turns sending on (after one confirmation) or off for every synced chat of the account at once; one call per chat, as the switches make. */
function BulkSend({
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
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const off = account.chats.filter((c) => c.direction !== "both");
	const on = account.chats.filter((c) => c.direction === "both");
	if (off.length === 0 && on.length === 0) return null;
	const run = async (chats: readonly BridgeChat[], direction: "both" | "in") => {
		setBusy(true);
		setConfirming(false);
		for (const chat of chats) {
			try {
				await api.setDirection(account.id, chat.conversationId, direction);
			} catch (err) {
				const error = onError(err);
				if (error.kind === "send_unsupported") toasts.show(t.chats.sendUnsupported);
				else if (error.kind !== "reauth") toasts.show(t.failed);
				break;
			}
		}
		forgetBridgeStatus();
		setBusy(false);
		onChange();
	};
	return (
		<div className="br-bulk" data-id="bridge-bulk">
			{confirming ? (
				<span className="br-actions">
					<span className="note">{t.chats.bulkConfirm(off.length, appName)}</span>
					<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(off, "both")}>
						{t.chats.bulkYes}
					</button>
					<button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
						{t.pick.cancel}
					</button>
				</span>
			) : (
				<span className="br-actions">
					{off.length > 0 && (
						<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setConfirming(true)}>
							{t.chats.enableAll(off.length)}
						</button>
					)}
					{on.length > 0 && (
						<button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => void run(on, "in")}>
							{t.chats.disableAll}
						</button>
					)}
				</span>
			)}
		</div>
	);
}

function SyncedChat({
	account,
	chat,
	api,
	appName,
	onChange,
	onError,
}: {
	account: BridgeAccount;
	chat: BridgeChat;
	api: BridgeApi;
	appName: string;
	onChange: () => void;
	onError: (err: unknown) => BridgeError;
}) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [featuresOpen, setFeaturesOpen] = useState(false);
	const both = chat.direction === "both";
	const setSendOn = (on: boolean) => {
		setBusy(true);
		api.setDirection(account.id, chat.conversationId, on ? "both" : "in").then(
			() => {
				forgetBridgeStatus();
				setBusy(false);
				onChange();
			},
			(err: unknown) => {
				setBusy(false);
				const error = onError(err);
				if (error.kind === "send_unsupported") toasts.show(t.chats.sendUnsupported);
				else if (error.kind !== "reauth") toasts.show(t.failed);
			},
		);
	};
	const remove = () => {
		setBusy(true);
		api.remove(account.id, chat.conversationId).then(() => {
			forgetBridgeStatus();
			onChange();
		}, (err: unknown) => {
			setBusy(false);
			if (onError(err).kind !== "reauth") toasts.show(t.failed);
		});
	};
	return (
		<div className="br-chat" data-id="bridge-chat">
			<span className="avatar sm av-violet" aria-hidden="true">
				{titleInitials(chat.title)}
			</span>
			<span className="grow br-text">
				<b>
					{chat.title}
					{chat.topicsSplit && <span className="tag-neutral br-topics-tag">{t.chats.topics}</span>}
				</b>
				<small className="br-status" data-state={chat.caughtUp ? "active" : "importing"}>
					<i aria-hidden="true" />
					{chat.caughtUp ? t.chats.caughtUp : t.chats.importing}
					<span className="br-sep" aria-hidden="true">
						·
					</span>
					{t.chats.window(chat.historyWindow)}
				</small>
			</span>
			{confirming ? (
				<span className="br-actions">
					<span className="note">{t.chats.removeConfirm}</span>
					<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={remove}>
						{t.chats.removeYes}
					</button>
					<button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
						{t.pick.cancel}
					</button>
				</span>
			) : (
				<span className="br-actions">
					<span className="br-send" title={t.chats.sendOnHint(appName)}>
						<span className="br-send-label" aria-hidden="true">
							{t.chats.sendOn}
						</span>
						<Switch checked={both} label={`${t.chats.sendOn}: ${chat.title}`} disabled={busy || account.status !== "active"} onChange={setSendOn} />
					</span>
					<button type="button" className="btn btn-sm" aria-expanded={featuresOpen} onClick={() => setFeaturesOpen(!featuresOpen)}>
						{t.features.open}
					</button>
					<Link to={paths.chat(chat.chatId)} className="btn btn-sm">
						{t.chats.open}
					</Link>
					<button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirming(true)}>
						{t.chats.remove}
					</button>
				</span>
			)}
			{featuresOpen && !confirming && (
				<Suspense fallback={null}>
					<BridgeFeatures
						accountId={account.id}
						conversationId={chat.conversationId}
						chatTitle={chat.title}
						appName={appName}
						api={api}
						disabled={busy || account.status !== "active"}
						onChanged={() => {
							forgetBridgeStatus();
							onChange();
						}}
						onError={onError}
					/>
				</Suspense>
			)}
		</div>
	);
}

/** The conversations of the account, to pick the ones to copy (several at once, one history choice for all) and how much history of each. */
function ChatPicker({
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
	const [list, setList] = useState<readonly BridgeConversation[] | "loading" | null>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [kind, setKind] = useState<ConversationKind | "all">("all");
	const [window, setWindow] = useState(DEFAULT_HISTORY_WINDOW);
	// New chats send both ways by default; the person can leave it off for the batch (and switch each chat later).
	const [sendOn, setSendOn] = useState(true);
	/** The forum whose copy is being offered a new sync by topic (waiting for the confirmation). */
	const [resyncFor, setResyncFor] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// How many chats wait for the sign-in to carry on by themselves.
	const [waiting, setWaiting] = useState(0);
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
	// A forum copied before topics were read has all its topics mixed in one stream: removing the copy and enabling the
	// conversation again, with the same window and direction, splits them. Remove and enable are the calls the page already makes.
	const resync = async (conversation: BridgeConversation) => {
		const copy = account.chats.find((c) => c.conversationId === conversation.id);
		if (copy === undefined) return;
		setBusy(true);
		setResyncFor(null);
		try {
			await api.remove(account.id, conversation.id);
		} catch (err) {
			setBusy(false);
			fail(err);
			return;
		}
		forgetBridgeStatus();
		try {
			await api.enable(account.id, conversation.id, copy.historyWindow, copy.direction);
			toasts.show(t.pick.started);
		} catch (err) {
			if (onError(err).kind !== "reauth") toasts.show(t.pick.resyncHalf);
		}
		forgetBridgeStatus();
		api.conversations(account.id).then(setList, () => setList(null));
		setBusy(false);
		onChange();
	};
	// One sign-in covers the whole batch: the chats go one after another within seconds. A refusal for an old sign-in
	// stops it, keeps what is not done selected and remembers it for this tab: after signing in again the page opens
	// anew and the batch carries on by itself (resume below).
	const runBatch = async (conversations: readonly BridgeConversation[], ids: readonly string[], howMany: number) => {
		setBusy(true);
		setWaiting(0);
		const todo = conversations.filter((c) => ids.includes(c.id) && c.chatId === 0);
		const left = new Set(todo.map((c) => c.id));
		let started = 0;
		let stopped = false;
		for (const conversation of todo) {
			try {
				await api.enable(account.id, conversation.id, howMany, sendOn ? "both" : "in");
				left.delete(conversation.id);
				started++;
			} catch (err) {
				fail(err);
				if (bridgeError(err).kind === "reauth") {
					stopped = true;
					break;
				}
			}
		}
		setBusy(false);
		setSelected(left);
		savePending({ account: account.id, ids: stopped ? [...left] : [], window: howMany });
		setWaiting(stopped ? left.size : 0);
		if (started > 0) {
			toasts.show(t.pick.started);
			api.conversations(account.id).then(setList, () => setList(null));
			onChange();
		}
	};
	const resume = useEffectEvent(() => {
		const pending = takePending(account.id);
		if (pending === null || pending.ids.length === 0) return;
		// The list shows the batch as chosen and busy right away (set from a callback, not from the effect itself).
		queueMicrotask(() => {
			setBusy(true);
			setList("loading");
			setWindow(pending.window);
			setSelected(new Set(pending.ids));
		});
		api.conversations(account.id).then(
			(all) => {
				setList(all);
				return runBatch(all, pending.ids, pending.window);
			},
			(err: unknown) => {
				setList(null);
				fail(err);
			},
		);
	});
	useEffect(() => {
		resume();
	}, []);
	if (list === null) {
		return (
			<div className="br-pad">
				<button type="button" className="btn" onClick={load}>
					{t.pick.load}
				</button>
			</div>
		);
	}
	if (list === "loading") return <p className="note br-pad">{t.pick.loading}</p>;
	const needle = query.trim().toLocaleLowerCase();
	const byName = list.filter((c) => needle === "" || c.title.toLocaleLowerCase().includes(needle));
	const shown = byName.filter((c) => kind === "all" || c.kind === kind);
	const kinds = KIND_ORDER.filter((k) => byName.some((c) => c.kind === k));
	const chosen = list.filter((c) => selected.has(c.id) && c.chatId === 0);
	// "Select all" acts on what the filter and search show, so a filter is also the quick way to pick one kind of chat.
	const selectable = shown.filter((c) => c.chatId === 0);
	const pickedShown = selectable.filter((c) => selected.has(c.id)).length;
	const allShownPicked = selectable.length > 0 && pickedShown === selectable.length;
	const toggleShown = () =>
		setSelected((now) => {
			const next = new Set(now);
			for (const c of selectable) {
				if (allShownPicked) next.delete(c.id);
				else next.add(c.id);
			}
			return next;
		});
	const toggle = (id: string) =>
		setSelected((now) => {
			const next = new Set(now);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	return (
		<div className="br-picker" data-id="bridge-picker">
			<h3 className="br-title">{t.pick.title}</h3>
			<div className="br-pad">
				<input className="input" type="search" aria-label={t.pick.search} placeholder={t.pick.search} value={query} onChange={(event) => setQuery(event.target.value)} />
			</div>
			<div className="br-filters" role="group" aria-label={t.pick.title}>
				<button type="button" className="btn btn-sm br-chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
					{t.pick.all} <span>{byName.length}</span>
				</button>
				{kinds.map((k) => (
					<button key={k} type="button" className="btn btn-sm br-chip" aria-pressed={kind === k} onClick={() => setKind(kind === k ? "all" : k)}>
						{t.pick.kind[k]} <span>{byName.filter((c) => c.kind === k).length}</span>
					</button>
				))}
			</div>
			{selectable.length > 0 && (
				<div className="br-selectbar">
					<button type="button" className="btn btn-sm" disabled={busy} onClick={toggleShown} data-id="bridge-select-shown">
						{allShownPicked ? t.pick.unselectShown : t.pick.selectShown(selectable.length)}
					</button>
					<small className="muted">{t.pick.shownCount(pickedShown, selectable.length)}</small>
				</div>
			)}
			{shown.length === 0 && <p className="note br-pad">{t.pick.empty}</p>}
			<div className="br-list" role="list">
				{shown.map((conversation) => {
					const synced = conversation.chatId !== 0;
					const checked = selected.has(conversation.id);
					const Row = synced ? "div" : "label";
					return (
						<div key={conversation.id} className="br-conv" data-selected={checked && !synced} data-id="bridge-conversation" role="listitem">
							<Row className="br-conv-main">
								{synced ? (
									<span className="br-check-gap" aria-hidden="true" />
								) : (
									<input type="checkbox" className="br-check" checked={checked} disabled={busy} onChange={() => toggle(conversation.id)} />
								)}
								<span className={`avatar sm ${KIND_TONE[conversation.kind]}`} aria-hidden="true">
									{titleInitials(conversation.title)}
								</span>
								<span className="grow br-text">
									<b>{conversation.title}</b>
									<small>{t.pick.kind[conversation.kind]}</small>
								</span>
								{conversation.forum && <span className="tag-neutral">{!synced ? t.pick.forum : conversation.topicsSplit ? t.pick.split : t.pick.flat}</span>}
								{synced && <span className="tag-neutral">{t.pick.synced}</span>}
								{synced && conversation.forum && !conversation.topicsSplit && (
									<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setResyncFor(conversation.id)}>
										{t.pick.resync}
									</button>
								)}
							</Row>
							{resyncFor === conversation.id && (
								<div className="br-actions br-resync" role="group" aria-label={t.pick.resync}>
									<span className="note">{t.pick.resyncConfirm}</span>
									<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void resync(conversation)}>
										{t.pick.resyncYes}
									</button>
									<button type="button" className="btn btn-sm" onClick={() => setResyncFor(null)}>
										{t.pick.cancel}
									</button>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{chosen.length > 0 && (
				<div className="br-bar" data-id="bridge-start" role="group" aria-label={t.pick.selected(chosen.length)}>
					<div className="br-bar-top">
						<b>{t.pick.selected(chosen.length)}</b>
						<button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={() => {
								setSelected(new Set());
								setWaiting(0);
							}}>
							{t.pick.clear}
						</button>
					</div>
					<div className="br-window">
						<span className="label">{t.pick.window}</span>
						<Choice<string>
							label={t.pick.window}
							value={String(window)}
							disabled={busy}
							options={HISTORY_WINDOWS.map((n) => ({ value: String(n), label: t.pick.windowOption(n) }))}
							onChange={(value) => setWindow(Number(value))}
						/>
					</div>
					<p className="note">{t.pick.windowNote}</p>
					<label className="br-sendon">
						<input type="checkbox" className="br-check" checked={sendOn} disabled={busy} onChange={() => setSendOn((on) => !on)} />
						<span>{t.pick.sendOn(appName)}</span>
					</label>
					{sendOn && <p className="note">{t.pick.sendNote}</p>}
					{waiting > 0 && (
						<p className="note br-resume" role="status">
							{t.pick.resume(waiting)}
						</p>
					)}
					<div className="br-actions end">
						<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void runBatch(list, [...selected], window)}>
							{t.pick.start(chosen.length)}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

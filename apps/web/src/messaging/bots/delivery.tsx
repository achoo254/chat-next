// The Developer Console's delivery tabs (mockups/console.html #webhook,
// #dead-letter, #stats): how the bot receives updates (webhook or long poll)
// with the live delivery state, the updates given up after 10 attempts with
// Thử lại / Bỏ, and the counters of the last 24 hours. Part of the console's
// lazily loaded code. A webhook secret is never read back: the field stays
// empty to keep the secret in use (same URL only; a new URL needs a new
// secret), "Tạo mới" fills in a random one to copy. Saving a webhook needs a
// recent sign-in: what was entered waits in the tab's sessionStorage during
// the sign-in, and `?after=webhook` brings it back in a confirmation that
// saves only from its button.
import { useEffect, useEffectEvent, useState, type FormEvent, type ReactNode } from "react";
import { useLoader } from "../../components/delayed-loader.tsx";
import { resource, useLoad } from "../../components/preload.ts";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { clock, shortDate } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { copyText, Switch, useDomId } from "../ui/parts.tsx";
import {
	BotError,
	botErrorKind,
	type BotDelivery,
	type Bots,
	type BotWebhook,
	type DeadLetter,
	type OwnBot,
	type UpdateKind,
} from "./api.ts";
import { ConfirmDialog, ReauthDialog, reauthUrl, useConfirmShown, type TabProps } from "./dialogs.tsx";
import { useBotsCopy } from "./use-bots-copy.ts";

/** Update kinds a bot can receive, in the Console's order. */
export const UPDATE_KINDS: readonly UpdateKind[] = ["message", "message_edited", "channel_post", "callback", "member_changed", "reaction", "inline_query"];

/** Webhook limits (bot_admin.proto SetBotWebhookRequest). */
export const WEBHOOK_LIMITS = { secretMax: 256, maxConnectionsMax: 100, maxConnectionsDefault: 40, urlMax: 2048 } as const;

/** Why SetBotWebhook refused (the server's code at the start of the message). */
export type WebhookProblem =
	| "url_invalid"
	| "url_blocked"
	| "url_unresolved"
	| "secret_invalid"
	| "secret_required"
	| "allowed_updates_invalid"
	| "max_connections_invalid";

const WEBHOOK_PROBLEMS: readonly WebhookProblem[] = [
	"url_invalid",
	"url_blocked",
	"url_unresolved",
	"secret_invalid",
	"secret_required",
	"allowed_updates_invalid",
	"max_connections_invalid",
];

/** The webhook problem of a failed setWebhook, or null for another failure. */
export function webhookProblem(err: unknown): WebhookProblem | null {
	if (!(err instanceof BotError) || err.kind !== "invalid") return null;
	return WEBHOOK_PROBLEMS.find((code) => err.message.startsWith(`${code}:`)) ?? null;
}

/** A webhook secret the bot's server checks: 1 to 256 of A-Z, a-z, 0-9, _ and -. */
export function validSecret(secret: string): boolean {
	return /^[A-Za-z0-9_-]{1,256}$/.test(secret);
}

/** 32 random characters of the secret alphabet. */
export function newSecret(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
	// 64 symbols: a byte modulo 64 is uniform.
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => alphabet[n % alphabet.length]).join("");
}

/** What the URL field says before saving: https only (the server checks addresses). */
export function webhookUrlProblem(url: string): "empty" | "scheme" | "invalid" | null {
	const value = url.trim();
	if (value === "") return "empty";
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return "invalid";
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "invalid";
	if (parsed.protocol !== "https:") return "scheme";
	if (parsed.hostname === "" || value.length > WEBHOOK_LIMITS.urlMax) return "invalid";
	return null;
}

/**
 * The long poll as a shell command anyone can run once <token> is
 * replaced, one option per line (a trailing "\" continues it): the first
 * call takes every pending update, waiting up to 50 seconds for one.
 */
export function pollCommand(origin: string): string {
	return ["curl -sS -G \\", '  -H "Authorization: Bearer <token>" \\', "  -d offset=0 \\", "  -d timeout=50 \\", `  ${origin}/bot/v1/updates`].join("\n");
}

/** `text` with a line-break opportunity after each "/" inside a path (not in "://"), so a narrow box wraps a URL between its parts, never inside a word. */
export function breakAfterSlashes(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	let start = 0;
	for (let i = 1; i < text.length - 1; i++) {
		const inPath = text[i] === "/" && text[i - 1] !== "/" && text[i - 1] !== ":" && text[i + 1] !== "/" && text[i + 1]?.trim() !== "";
		if (inPath) {
			out.push(text.slice(start, i + 1), <wbr key={i} />);
			start = i + 1;
		}
	}
	out.push(text.slice(start));
	return out;
}

/** What the webhook form had when SetBotWebhook asked for a recent sign-in, kept in this tab until the user comes back. */
interface WebhookDraft {
	readonly url: string;
	readonly secret: string;
	readonly kinds: readonly string[];
	readonly maxText: string;
	readonly drop: boolean;
}

/** A draft older than this (an abandoned sign-in) is not offered again. */
const DRAFT_TTL_MS = 15 * 60_000;

function draftKey(botId: number): string {
	return `console:webhook-draft:${botId}`;
}

/**
 * Keeps the form for the reauth round trip. sessionStorage: this tab only,
 * gone with it; the secret is the bot owner's own (their server holds it
 * too), and the entry is removed as soon as the page reads it back.
 */
function keepDraft(botId: number, draft: WebhookDraft): void {
	try {
		sessionStorage.setItem(draftKey(botId), JSON.stringify({ ...draft, at: Date.now() }));
	} catch {
		// Storage refused (private mode, quota): the user enters it again.
	}
}

/** The kept draft of the bot, or null (none, too old, or not one of ours). Does not remove it. */
export function readDraft(botId: number): WebhookDraft | null {
	let value: unknown;
	try {
		value = JSON.parse(sessionStorage.getItem(draftKey(botId)) ?? "null");
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const d = value as Record<string, unknown>;
	const kinds = d.kinds;
	if (
		typeof d.url !== "string" ||
		typeof d.secret !== "string" ||
		typeof d.maxText !== "string" ||
		typeof d.drop !== "boolean" ||
		typeof d.at !== "number" ||
		!Array.isArray(kinds) ||
		!kinds.every((k): k is UpdateKind => (UPDATE_KINDS as readonly unknown[]).includes(k)) ||
		Date.now() - d.at > DRAFT_TTL_MS
	) {
		return null;
	}
	return { url: d.url, secret: d.secret, kinds, maxText: d.maxText, drop: d.drop };
}

function dropDraft(botId: number): void {
	try {
		sessionStorage.removeItem(draftKey(botId));
	} catch {
		// Nothing kept, or storage unavailable.
	}
}

/** How often an open delivery tab reads the state again. */
export const DELIVERY_REFRESH_MS = 5000;

/** "02/10 14:20" in the user's time zone. */
export function when(unixSeconds: number, locale: string): string {
	return `${shortDate(unixSeconds, locale)} ${clock(unixSeconds, locale)}`;
}

function deliveryData(bots: Bots, botId: number) {
	return resource(bots, `delivery:${botId}`, () => bots.delivery(botId));
}

/** The bot's delivery, read again every DELIVERY_REFRESH_MS while shown; a failed refresh keeps what is shown. */
function useDelivery(botId: number) {
	const { bots } = useServices();
	const [state, reload, update] = useLoad(deliveryData(bots, botId));
	const refreshNow = () => {
		bots.delivery(botId).then(
			(value) => update(() => value),
			() => undefined,
		);
	};
	const tick = useEffectEvent(refreshNow);
	const ready = state.status === "ready";
	useEffect(() => {
		if (!ready) return;
		const timer = setInterval(tick, DELIVERY_REFRESH_MS);
		return () => clearInterval(timer);
	}, [ready]);
	return { state, reload, update, refreshNow };
}

function LoadError({ onRetry }: { onRetry: () => void }) {
	const copy = useCopy();
	return (
		<div className="banner error" role="alert">
			<Icon name="alert" small />
			<span className="grow">{copy.common.loadFailed}</span>
			<button type="button" className="btn btn-sm" onClick={onRetry}>
				{copy.common.retry}
			</button>
		</div>
	);
}

// ----------------------------------------------------------------- updates

/** "Nhận update": choose webhook or long poll, with the delivery state beside; `confirmNow` (back from the reauth sign-in) offers the kept webhook once. */
export function UpdatesTab({ bot, onChanged, confirmNow, onConfirmShown }: TabProps & { onChanged: (bot: OwnBot) => void }) {
	const copy = useCopy();
	const { state, reload, update, refreshNow } = useDelivery(bot.id);
	const loader = useLoader(state.status === "loading", copy.common.loading);
	// The form starts from the saved settings and starts again after a save,
	// from what the server answered (the status catches up on the refresh).
	const [round, setRound] = useState(0);
	if (loader !== null) return loader;
	if (state.status === "error") return <LoadError onRetry={reload} />;
	if (state.status !== "ready") return null;
	const delivery = state.value;
	return (
		<div className="c-grid">
			<DeliveryForm
				key={round}
				bot={bot}
				delivery={delivery}
				confirmNow={round === 0 && confirmNow}
				onConfirmShown={onConfirmShown}
				onSaved={(webhook, dropped) => {
					update((value) => ({ ...value, webhook, status: dropped ? { ...value.status, pending: 0 } : value.status }));
					onChanged({ ...bot, webhook: webhook.url !== "" });
					setRound((n) => n + 1);
					refreshNow();
				}}
			/>
			<DeliveryStatusCard bot={bot} delivery={delivery} />
		</div>
	);
}

type Mode = "webhook" | "poll";

function DeliveryForm({
	bot,
	delivery,
	onSaved,
	confirmNow,
	onConfirmShown,
}: TabProps & { delivery: BotDelivery; onSaved: (webhook: BotWebhook, dropped: boolean) => void }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { locale } = useI18n();
	const { bots, toasts } = useServices();
	const saved = delivery.webhook;
	const hasWebhook = saved.url !== "";
	// Back from the reauth sign-in: the form as it was, and its confirmation.
	const [draft] = useState(() => (confirmNow ? readDraft(bot.id) : null));
	useEffect(() => {
		if (confirmNow) dropDraft(bot.id);
	}, [confirmNow, bot.id]);
	useConfirmShown(confirmNow, onConfirmShown);
	const [mode, setMode] = useState<Mode>(draft !== null || hasWebhook ? "webhook" : "poll");
	const [url, setUrl] = useState(draft?.url ?? saved.url);
	const [secret, setSecret] = useState(draft?.secret ?? "");
	const [showSecret, setShowSecret] = useState(false);
	const [kinds, setKinds] = useState<readonly string[]>(draft?.kinds ?? saved.allowedUpdates);
	const [maxText, setMaxText] = useState(draft?.maxText ?? String(hasWebhook ? saved.maxConnections : WEBHOOK_LIMITS.maxConnectionsDefault));
	const [drop, setDrop] = useState(draft?.drop ?? false);
	const [dialog, setDialog] = useState<"confirm" | "reauth" | null>(draft !== null ? "confirm" : null);
	const [saving, setSaving] = useState(false);
	const [touched, setTouched] = useState(false);
	const [serverError, setServerError] = useState<{ field: "url" | "secret" | "max" | "form"; text: string } | null>(null);
	const formId = useDomId("delivery");
	const modeId = useDomId("dl-mode");
	const urlId = useDomId("dl-url");
	const secretId = useDomId("dl-secret");
	const kindsId = useDomId("dl-kinds");
	const maxId = useDomId("dl-max");

	const maxConnections = Number(maxText);
	const urlProblem = mode === "webhook" ? webhookUrlProblem(url) : null;
	const urlError = urlProblem === null ? "" : t.delivery.urlProblem[urlProblem];
	// The secret in use stays only with the URL it was set for.
	const keepsSecret = hasWebhook && url.trim() === saved.url;
	const secretMissing = !hasWebhook ? t.delivery.secretRequired : keepsSecret ? "" : t.delivery.secretNewUrl;
	const secretError = mode !== "webhook" ? "" : secret === "" ? secretMissing : validSecret(secret) ? "" : t.delivery.secretBad;
	const maxError =
		mode === "webhook" && (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > WEBHOOK_LIMITS.maxConnectionsMax)
			? t.delivery.maxBad
			: "";
	const invalid = urlError !== "" || secretError !== "" || maxError !== "";
	const sameKinds = kinds.length === saved.allowedUpdates.length && kinds.every((k) => saved.allowedUpdates.includes(k));
	const dirty =
		mode === "webhook"
			? !hasWebhook || url.trim() !== saved.url || secret !== "" || !sameKinds || maxConnections !== saved.maxConnections || drop
			: hasWebhook || drop;
	// A malformed value is flagged as typed; a missing one after the first save attempt; the server's verdict until edited.
	const shownError = (field: "url" | "secret" | "max", local: string, live: boolean) => {
		if (local !== "" && (live || touched)) return local;
		return serverError?.field === field ? serverError.text : "";
	};

	const toggleKind = (kind: UpdateKind) => {
		setKinds((now) => (now.includes(kind) ? now.filter((k) => k !== kind) : UPDATE_KINDS.filter((k) => k === kind || now.includes(k))));
	};

	/** Sends what the form holds; a refusal is shown on its field, a missing recent sign-in asks for one (keeping the form). */
	const send = async () => {
		setSaving(true);
		setServerError(null);
		try {
			let webhook: BotWebhook = { url: "", allowedUpdates: [], maxConnections: WEBHOOK_LIMITS.maxConnectionsDefault };
			if (mode === "webhook") {
				webhook = await bots.setWebhook(bot.id, {
					url,
					secret,
					allowedUpdates: UPDATE_KINDS.filter((k) => kinds.includes(k)),
					maxConnections,
					dropPending: drop,
				});
			} else {
				await bots.deleteWebhook(bot.id, drop);
			}
			setDialog(null);
			toasts.show(t.delivery.saved);
			onSaved(webhook, drop);
		} catch (err) {
			if (botErrorKind(err) === "reauth_required") {
				keepDraft(bot.id, { url, secret, kinds, maxText, drop });
				setDialog("reauth");
				return;
			}
			setDialog(null);
			const problem = webhookProblem(err);
			if (problem === "url_invalid" || problem === "url_blocked" || problem === "url_unresolved") {
				setServerError({ field: "url", text: t.delivery.urlProblem[problem] });
			} else if (problem === "secret_invalid") {
				setServerError({ field: "secret", text: t.delivery.secretBad });
			} else if (problem === "secret_required") {
				setServerError({ field: "secret", text: secretMissing === "" ? t.delivery.secretRequired : secretMissing });
			} else if (problem === "max_connections_invalid") {
				setServerError({ field: "max", text: t.delivery.maxBad });
			} else {
				setServerError({ field: "form", text: copy.common.failed });
			}
		} finally {
			setSaving(false);
		}
	};

	const save = (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (invalid || !dirty || saving) return;
		void send();
	};

	const urlShown = shownError("url", urlError, url.trim() !== "");
	const secretShown = shownError("secret", secretError, secret !== "");
	const maxShown = shownError("max", maxError, true);
	const pending = delivery.status.pending;
	return (
		<form className="card form" aria-labelledby={formId} onSubmit={save} noValidate>
			<h2 id={formId}>{t.console.tab.updates}</h2>
			<div className="field">
				<span className="label" id={modeId}>
					{t.delivery.modeLabel}
				</span>
				<div className="choice" role="group" aria-labelledby={modeId}>
					{(["webhook", "poll"] as const).map((item) => (
						<button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>
							{item === "webhook" ? t.delivery.webhook : t.delivery.longPoll}
						</button>
					))}
				</div>
			</div>
			{mode === "webhook" ? (
				<>
					<div className="field">
						<label htmlFor={urlId}>{t.delivery.url}</label>
						<input
							id={urlId}
							className="input mono"
							type="url"
							inputMode="url"
							value={url}
							maxLength={WEBHOOK_LIMITS.urlMax}
							spellCheck={false}
							autoComplete="off"
							placeholder="https://"
							aria-invalid={urlShown !== ""}
							aria-describedby={`${urlId}-msg`}
							onChange={(event) => {
								setUrl(event.target.value);
								if (serverError?.field === "url") setServerError(null);
							}}
						/>
						<span id={`${urlId}-msg`} className={urlShown !== "" ? "error-text" : "hint"}>
							{urlShown !== "" ? urlShown : t.delivery.urlHint}
						</span>
					</div>
					<div className="field">
						<label htmlFor={secretId}>{t.delivery.secret}</label>
						<div className="inline-row">
							<input
								id={secretId}
								className="input mono"
								type={showSecret ? "text" : "password"}
								value={secret}
								maxLength={WEBHOOK_LIMITS.secretMax}
								spellCheck={false}
								autoComplete="off"
								placeholder={keepsSecret ? t.delivery.secretKeep : hasWebhook ? t.delivery.secretForNewUrl : t.delivery.secretNew}
								aria-invalid={secretShown !== ""}
								aria-describedby={`${secretId}-msg`}
								onChange={(event) => {
									setSecret(event.target.value);
									if (serverError?.field === "secret") setServerError(null);
								}}
							/>
							<button
								type="button"
								className="icon-btn"
								aria-pressed={showSecret}
								aria-label={showSecret ? t.delivery.hideSecret : t.delivery.showSecret}
								onClick={() => setShowSecret((now) => !now)}
							>
								<Icon name={showSecret ? "eye-off" : "eye"} />
							</button>
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => {
									setSecret(newSecret());
									setShowSecret(true);
									toasts.show(t.delivery.generated);
								}}
							>
								{t.delivery.generate}
							</button>
						</div>
						<span id={`${secretId}-msg`} className={secretShown !== "" ? "error-text" : "hint"}>
							{secretShown !== "" ? secretShown : t.delivery.secretHint}
						</span>
					</div>
					<div className="field">
						<span className="label" id={kindsId}>
							{t.delivery.kinds}
						</span>
						<div className="chips" role="group" aria-labelledby={kindsId}>
							{UPDATE_KINDS.map((kind) => (
								<button key={kind} type="button" aria-pressed={kinds.includes(kind)} onClick={() => toggleKind(kind)}>
									{kind}
								</button>
							))}
						</div>
						<span className="hint">{t.delivery.kindsHint}</span>
					</div>
					<div className="field">
						<label htmlFor={maxId}>{t.delivery.maxConnections}</label>
						<input
							id={maxId}
							className="input narrow"
							type="number"
							inputMode="numeric"
							min={1}
							max={WEBHOOK_LIMITS.maxConnectionsMax}
							value={maxText}
							aria-invalid={maxShown !== ""}
							aria-describedby={`${maxId}-msg`}
							onChange={(event) => setMaxText(event.target.value)}
						/>
						<span id={`${maxId}-msg`} className={maxShown !== "" ? "error-text" : "hint"}>
							{maxShown !== "" ? maxShown : t.delivery.maxHint}
						</span>
					</div>
				</>
			) : (
				<>
					<p className="note">{t.delivery.pollNote}</p>
					<PollCommand />
					<p className="note">{t.delivery.pollNext}</p>
				</>
			)}
			<div className="setting">
				<div>
					<strong>{t.delivery.drop}</strong>
					<small>{t.delivery.dropHint(pending)}</small>
				</div>
				<Switch checked={drop} label={t.delivery.drop} onChange={setDrop} />
			</div>
			{serverError?.field === "form" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{serverError.text}</span>
				</div>
			)}
			{touched && invalid && <p className="error-text">{t.delivery.fixFirst}</p>}
			<div className="card-foot">
				<button type="submit" className="btn btn-primary" disabled={!dirty || saving} aria-busy={saving}>
					{saving ? t.delivery.saving : t.delivery.save}
				</button>
			</div>
			{dialog === "confirm" && (
				<ConfirmDialog
					title={t.delivery.confirmTitle}
					body={
						<>
							<p className="dlg-lede">{t.delivery.confirmBody(bot.name)}</p>
							<p className="mono confirm-url">{url.trim()}</p>
						</>
					}
					action={t.delivery.save}
					busyLabel={t.delivery.saving}
					busy={saving}
					danger={false}
					onConfirm={() => void send()}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "reauth" && (
				<ReauthDialog body={t.reauth.bodyWebhook} warning="" href={reauthUrl(locale, bot.id, "updates", "webhook")} onClose={() => setDialog(null)} />
			)}
		</form>
	);
}

/** The long poll command with "Sao chép" (mockups/console.html#webhook). */
function PollCommand() {
	const t = useBotsCopy();
	const copy = useCopy();
	const { toasts } = useServices();
	const command = pollCommand(window.location.origin);
	return (
		<div className="command">
			<pre className="snippet" aria-label={t.delivery.command}>
				{breakAfterSlashes(command)}
			</pre>
			<div>
				<button
					type="button"
					className="btn btn-sm"
					onClick={() => {
						void copyText(command).then((ok) => toasts.show(ok ? t.delivery.commandCopied : copy.common.failed));
					}}
				>
					<Icon name="copy" small />
					{t.delivery.copyCommand}
				</button>
			</div>
		</div>
	);
}

/** The webhook's state: failing when the newest failure is newer than the newest success. */
function webhookState(delivery: BotDelivery): "ok" | "failing" | "idle" {
	const { lastErrorAt, lastSuccessAt } = delivery.status;
	if (lastErrorAt > 0 && lastErrorAt >= lastSuccessAt) return "failing";
	return lastSuccessAt > 0 ? "ok" : "idle";
}

function DeliveryStatusCard({ bot, delivery }: { bot: OwnBot; delivery: BotDelivery }) {
	const t = useBotsCopy();
	const { locale } = useI18n();
	const titleId = useDomId("dl-status");
	const status = delivery.status;
	const hooked = delivery.webhook.url !== "";
	const state = webhookState(delivery);
	const deadLink =
		status.deadLetters > 0 ? (
			<Link to={paths.consoleBot(bot.id, "dead-letters")} className="btn btn-sm">
				{t.delivery.viewDead(status.deadLetters)}
			</Link>
		) : (
			t.delivery.none
		);
	return (
		<section className="card side-card" aria-labelledby={titleId}>
			<h2 id={titleId}>{hooked ? t.delivery.statusTitle : t.delivery.pollStatusTitle}</h2>
			{hooked ? (
				<>
					<span className={`dot ${state === "ok" ? "ok" : state === "failing" ? "err" : ""}`} role="status">
						{t.delivery.state[state]}
					</span>
					<dl className="kv">
						<dt>{t.delivery.lastError}</dt>
						<dd>
							{status.lastError === "" ? (
								t.delivery.none
							) : (
								<>
									{t.delivery.failure(status.lastError)}
									<span className="cell-sub">{when(status.lastErrorAt, locale)}</span>
								</>
							)}
						</dd>
						<dt>{t.delivery.pending}</dt>
						<dd>{status.pending}</dd>
						<dt>{t.delivery.lastSuccess}</dt>
						<dd>
							{status.lastSuccessAt === 0 ? (
								t.delivery.none
							) : (
								<>
									{t.delivery.ms(status.lastSuccessMs)}
									<span className="cell-sub">{t.delivery.at(when(status.lastSuccessAt, locale))}</span>
								</>
							)}
						</dd>
						<dt>{t.delivery.open}</dt>
						<dd>
							{status.openConnections} / {delivery.webhook.maxConnections}
						</dd>
						<dt>{t.delivery.deadLetters}</dt>
						<dd>{deadLink}</dd>
					</dl>
					<p>{t.delivery.retryNote}</p>
				</>
			) : (
				<dl className="kv">
					<dt>{t.delivery.pending}</dt>
					<dd>{status.pending}</dd>
					<dt>{t.delivery.lastFetch}</dt>
					<dd>{bot.lastUpdateAt > 0 ? when(bot.lastUpdateAt, locale) : t.delivery.never}</dd>
					<dt>{t.delivery.deadLetters}</dt>
					<dd>{deadLink}</dd>
				</dl>
			)}
		</section>
	);
}

// ------------------------------------------------------------ dead letters

function deadLettersData(bots: Bots, botId: number) {
	return resource(bots, `dead-letters:${botId}`, () => bots.deadLetters(botId));
}

/** "Update lỗi": the dead letters with Thử lại / Bỏ, one or all shown. */
export function DeadLettersTab({ bot }: { bot: OwnBot }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { locale } = useI18n();
	const { bots, toasts } = useServices();
	const [state, reload, update] = useLoad(deadLettersData(bots, bot.id));
	const loader = useLoader(state.status === "loading", copy.common.loading);
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const titleId = useDomId("dead");
	if (loader !== null) return loader;
	if (state.status === "error") return <LoadError onRetry={reload} />;
	if (state.status !== "ready") return null;
	const { list, total } = state.value;
	const idle = list.filter((d) => !busy.has(d.updateId));

	const act = async (ids: readonly number[], retry: boolean) => {
		if (ids.length === 0) return;
		setBusy((now) => new Set([...now, ...ids]));
		try {
			const n = retry ? await bots.retryDeadLetters(bot.id, ids) : await bots.discardDeadLetters(bot.id, ids);
			update((value) => ({ list: value.list.filter((d) => !ids.includes(d.updateId)), total: Math.max(0, value.total - n) }));
			toasts.show(retry ? t.deadLetters.retried(ids.length) : t.deadLetters.dropped(ids.length));
		} catch {
			toasts.show(copy.common.failed);
		} finally {
			setBusy((now) => new Set([...now].filter((id) => !ids.includes(id))));
		}
	};

	return (
		<section className="stack-page" aria-labelledby={titleId}>
			<div className="c-title">
				<h2 id={titleId}>
					{t.deadLetters.title} <span className="muted">({total})</span>
				</h2>
				{list.length > 0 && (
					<>
						<button type="button" className="btn btn-sm" disabled={idle.length === 0} onClick={() => void act(idle.map((d) => d.updateId), true)}>
							{t.deadLetters.retryAll}
						</button>
						<button type="button" className="btn btn-sm danger-outline" disabled={idle.length === 0} onClick={() => void act(idle.map((d) => d.updateId), false)}>
							{t.deadLetters.dropAll}
						</button>
					</>
				)}
			</div>
			{list.length === 0 ? (
				<div className="card pad">
					<div className="empty">
						<Icon name="inbox" />
						<strong>{t.deadLetters.emptyTitle}</strong>
						<span>{t.deadLetters.emptyBody}</span>
					</div>
				</div>
			) : (
				<>
					<p className="note">{t.deadLetters.note}</p>
					<div className="card table-card">
						<table className="data">
							<thead>
								<tr>
									<th>{t.deadLetters.columns.id}</th>
									<th>{t.deadLetters.columns.kind}</th>
									<th>{t.deadLetters.columns.chat}</th>
									<th>{t.deadLetters.columns.error}</th>
									<th>{t.deadLetters.columns.at}</th>
									<th>
										<span className="sr-only">{t.deadLetters.columns.actions}</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{list.map((d) => (
									<DeadLetterRow key={d.updateId} letter={d} busy={busy.has(d.updateId)} locale={locale} onAct={(retry) => void act([d.updateId], retry)} />
								))}
							</tbody>
						</table>
					</div>
					{total > list.length && <p className="note">{t.deadLetters.more(list.length, total)}</p>}
				</>
			)}
		</section>
	);
}

function DeadLetterRow({ letter, busy, locale, onAct }: { letter: DeadLetter; busy: boolean; locale: string; onAct: (retry: boolean) => void }) {
	const t = useBotsCopy();
	const columns = t.deadLetters.columns;
	return (
		<tr aria-busy={busy}>
			<td data-label={columns.id} className="mono">
				{letter.updateId}
			</td>
			<td data-label={columns.kind} className="mono">
				{letter.kind}
			</td>
			<td data-label={columns.chat}>{letter.chatTitle === "" ? letter.chatId : letter.chatTitle}</td>
			<td data-label={columns.error} className={busy ? "" : "err-text"}>
				{busy ? t.deadLetters.retrying : t.delivery.failure(letter.lastError)}
			</td>
			<td data-label={columns.at}>{when(letter.lastErrorAt, locale)}</td>
			<td className="actions-cell">
				<span className="actions">
					<button type="button" className="btn btn-sm" disabled={busy} aria-label={t.deadLetters.retryName(letter.updateId)} onClick={() => onAct(true)}>
						{t.deadLetters.retry}
					</button>
					<button type="button" className="btn btn-sm btn-ghost" disabled={busy} aria-label={t.deadLetters.dropName(letter.updateId)} onClick={() => onAct(false)}>
						{t.deadLetters.drop}
					</button>
				</span>
			</td>
		</tr>
	);
}

// ------------------------------------------------------------------ stats

/** "Số liệu": the delivery counters of the last 24 hours and the bot's tier. */
export function StatsTab({ bot }: { bot: OwnBot }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { locale } = useI18n();
	const { state, reload } = useDelivery(bot.id);
	const loader = useLoader(state.status === "loading", copy.common.loading);
	const titleId = useDomId("stats");
	if (loader !== null) return loader;
	if (state.status === "error") return <LoadError onRetry={reload} />;
	if (state.status !== "ready") return null;
	const stats = state.value.stats;
	const number = new Intl.NumberFormat(locale);
	const tiles = [
		[t.stats.received, stats.received, t.stats.receivedHint],
		[t.stats.delivered, stats.delivered, t.stats.deliveredHint],
		[t.stats.failed, stats.failed, t.stats.failedHint],
		[t.stats.dead, stats.deadLettered, t.stats.deadHint],
	] as const;
	return (
		<section className="stack-page" aria-labelledby={titleId}>
			<div className="c-title">
				<h2 id={titleId}>{t.stats.title}</h2>
			</div>
			<div className="stats">
				{tiles.map(([label, value, hint]) => (
					<div key={label} className="stat">
						<span>{label}</span>
						<b>{number.format(value)}</b>
						<span>{hint}</span>
					</div>
				))}
			</div>
			<div className="card">
				<div className="c-title">
					<h2 className="grow">{t.stats.tierTitle}</h2>
					<span className={`tier ${bot.tier}`}>{bot.tier}</span>
				</div>
				<p>{t.stats.tierBody[bot.tier]}</p>
				<p>{t.stats.tierNote}</p>
			</div>
		</section>
	);
}

// "Tài khoản" (mockups/settings.html#export-delete): personal data export
// (background build, download here, 30 days, once per 7 days), auto-delete
// when unused, and deletion of the chat account. Deleting needs a recent
// IdP sign-in (ADR 0006): without one the tab sends the browser to the
// reauth sign-in and, back here with ?after=delete, opens the confirmation
// once; only its own button deletes.
import { signInUrl } from "@achoo254/chat-core";
import { useEffect, useEffectEvent, useState } from "react";
import { brand } from "../../brand.ts";
import { useLoader } from "../../components/delayed-loader.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { useLoad } from "../../components/preload.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths, useSearch } from "../../router.tsx";
import { ReauthDialog } from "../bots/dialogs.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock } from "../data/format.ts";
import { accountData } from "../data/screen-data.ts";
import { useServices } from "../data/services.tsx";
import { formatBytes } from "../media/media-format.ts";
import { Choice, DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import { privacyClient, privacyErrorKind } from "./privacy-client.ts";
import {
	RECENT_SIGN_IN_SECONDS,
	type AutoDeleteMonths,
	type DataExport,
	type DeletionInfo,
	type ExportState,
} from "./privacy-api.ts";

/** How often a running export's progress is read. */
const PROGRESS_POLL_MS = 3000;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** dd/mm/yyyy (vi) or the locale's short date. */
function dateOf(unixSeconds: number, locale: string): string {
	const date = new Date(unixSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	if (locale === "vi") return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
	return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/** Whether ?after=delete asks for the confirmation (back from the reauth sign-in). */
function afterDelete(search: string): boolean {
	return new URLSearchParams(search).get("after") === "delete";
}

export function AccountSettings() {
	const copy = useScreensCopy();
	const { transport } = useServices();
	// The first load is started by the route with this tab's code (messaging-root.tsx).
	const [load, reload, update] = useLoad(accountData(transport));
	const loader = useLoader(load.status === "loading", copy.common.loading);
	if (loader !== null) return loader;
	if (load.status !== "ready") {
		return (
			<div className="set-body">
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{copy.common.loadFailed}</span>
					<button type="button" className="btn btn-sm" onClick={reload}>
						{copy.common.retry}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="set-body">
			<ExportCard state={load.value.exports} onState={(exports) => update((current) => ({ ...current, exports }))} />
			<AutoDeleteCard
				months={load.value.deletion.autoDeleteMonths}
				onMonths={(autoDeleteMonths) => update((current) => ({ ...current, deletion: { ...current.deletion, autoDeleteMonths } }))}
			/>
			<DeleteCard info={load.value.deletion} onStale={reload} />
		</div>
	);
}

function ExportCard({ state, onState }: { state: ExportState; onState: (state: ExportState) => void }) {
	const copy = useScreensCopy();
	const t = copy.account;
	const { locale } = useI18n();
	const { transport, toasts } = useServices();
	const account = privacyClient(transport);
	const [busy, setBusy] = useState<"request" | "download" | null>(null);
	const latest = state.latest;
	const building = latest !== null && (latest.status === "pending" || latest.status === "running");

	const refresh = () => {
		account.exportState().then(onState, () => undefined);
	};
	// While it builds, read the progress every few seconds.
	const poll = useEffectEvent(refresh);
	useEffect(() => {
		if (!building) return;
		const timer = setInterval(poll, PROGRESS_POLL_MS);
		return () => clearInterval(timer);
	}, [building]);

	const request = () => {
		setBusy("request");
		account.requestExport().then(
			(next) => {
				setBusy(null);
				onState(next);
				toasts.show(t.requested);
			},
			(err: unknown) => {
				setBusy(null);
				const kind = privacyErrorKind(err);
				toasts.show(kind === "rate_limited" ? t.rateLimited : kind === "unavailable" ? t.unavailable : copy.common.failed);
				refresh();
			},
		);
	};

	const download = (ready: DataExport) => {
		setBusy("download");
		account.exportUrl(ready.id).then(
			(url) => {
				setBusy(null);
				// The media host answers with Content-Disposition: attachment, so
				// the browser saves the file and stays on this page.
				const a = document.createElement("a");
				a.href = url;
				a.rel = "noopener";
				a.download = ready.fileName;
				document.body.append(a);
				a.click();
				a.remove();
			},
			() => {
				setBusy(null);
				toasts.show(copy.common.failed);
				refresh();
			},
		);
	};

	const next = state.nextRequestAt > nowSeconds() ? state.nextRequestAt : 0;
	return (
		<div className="card">
			<h2 className="card-title">{t.exportTitle}</h2>
			<p className="note pad-x">{t.exportNote}</p>
			{latest !== null && latest.status === "ready" && (
				<div className="row pad-x top-line export-file">
					<span className="device" aria-hidden="true">
						<Icon name="file" />
					</span>
					<span className="grow">
						<span className="mono break">{latest.fileName}</span>
						<small>{t.exportReady(formatBytes(latest.size, locale), dateOf(latest.expiresAt, locale))}</small>
					</span>
					<button type="button" className="btn btn-sm" disabled={busy !== null} aria-busy={busy === "download"} onClick={() => download(latest)}>
						<Icon name="download" small />
						{busy === "download" ? t.downloading : t.download}
					</button>
				</div>
			)}
			{building && (
				<div className="row pad-x top-line">
					<span className="device" aria-hidden="true">
						<Icon name="clock" />
					</span>
					<span className="grow">
						{latest.status === "running" ? t.exportRunning(latest.progress) : t.exportQueued}
						<small>{t.exportStarted(clock(latest.createdAt, locale))}</small>
						<progress className="meter" max={100} value={latest.progress} aria-label={t.exportProgress} />
					</span>
				</div>
			)}
			{latest !== null && latest.status === "failed" && (
				<div className="banner warn top-line" role="status">
					<Icon name="alert" small />
					<span className="grow">{t.exportFailed}</span>
				</div>
			)}
			{latest !== null && latest.status === "expired" && <p className="note pad-x top-line">{t.exportExpired(dateOf(latest.createdAt, locale))}</p>}
			<div className="row pad-x top-line">
				<span className="grow">
					{t.requestTitle}
					<small>{!state.available ? t.unavailable : next !== 0 ? t.requestNext(`${dateOf(next, locale)} ${clock(next, locale)}`) : t.requestEvery}</small>
				</span>
				<button
					type="button"
					className="btn btn-sm"
					disabled={!state.available || next !== 0 || building || busy !== null}
					aria-busy={busy === "request"}
					onClick={request}
				>
					{busy === "request" ? t.requesting : t.request}
				</button>
			</div>
		</div>
	);
}

const MONTHS: readonly AutoDeleteMonths[] = [0, 6, 12, 24];

function AutoDeleteCard({ months, onMonths }: { months: AutoDeleteMonths; onMonths: (months: AutoDeleteMonths) => void }) {
	const copy = useScreensCopy();
	const t = copy.account;
	const { transport, toasts } = useServices();
	const account = privacyClient(transport);
	const save = (value: string) => {
		const chosen = MONTHS.find((m) => String(m) === value) ?? 0;
		const previous = months;
		onMonths(chosen);
		account.setAutoDelete(chosen).then(
			(saved) => {
				onMonths(saved);
				toasts.show(t.autoDeleteSaved);
			},
			() => {
				onMonths(previous);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<div className="card">
			<div className="row opt-row">
				<span className="grow">
					{t.autoDelete}
					<small>{t.autoDeleteHint}</small>
				</span>
				<Choice<string>
					label={t.autoDelete}
					value={String(months)}
					options={MONTHS.map((m) => ({ value: String(m), label: m === 0 ? t.autoDeleteOff : t.months(m) }))}
					onChange={save}
				/>
			</div>
		</div>
	);
}

function DeleteCard({ info, onStale }: { info: DeletionInfo; onStale: () => void }) {
	const copy = useScreensCopy();
	const t = copy.account;
	const { locale } = useI18n();
	const search = useSearch();
	// ?after=delete is taken once: the confirmation opens, the URL loses it.
	const [dialog, setDialog] = useState<"confirm" | "reauth" | null>(() => (afterDelete(search) && info.ownedChats.length === 0 ? "confirm" : null));
	useEffect(() => {
		if (afterDelete(search)) navigate(window.location.pathname, { replace: true });
	}, [search]);
	const blocked = info.ownedChats.length > 0;
	const recent = info.signedInAt > 0 && nowSeconds() - info.signedInAt < RECENT_SIGN_IN_SECONDS;
	const reauthHref = signInUrl(locale, { reauth: true, returnTo: `${paths.settings("account")}?after=delete` });
	return (
		<div className="card danger-zone">
			<h2 className="card-title">{t.deleteTitle}</h2>
			<ul className="ticks pad-x">
				{t.deleteTicks(info.graceDays, brand.idpHost).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			{blocked && (
				<>
					<div className="banner warn top-line" role="status">
						<Icon name="alert" small />
						<span className="grow">{t.ownsChats(info.ownedChats.length)}</span>
					</div>
					<ul className="plain">
						{info.ownedChats.map((chat) => (
							<li className="row pad-x" key={chat.chatId}>
								<span className="device" aria-hidden="true">
									<Icon name={chat.isChannel ? "megaphone" : "users"} />
								</span>
								<span className="grow">
									<span className="break">{chat.title}</span>
									<small>{chat.isChannel ? t.channelMembers(chat.memberCount) : t.groupMembers(chat.memberCount)}</small>
								</span>
								<Link to={paths.chatAdmin(chat.chatId)} className="btn btn-sm">
									{chat.isChannel ? t.openChannel : t.openGroup}
								</Link>
							</li>
						))}
					</ul>
				</>
			)}
			{info.bots.length > 0 && (
				<div className="callout pad-x">
					<Icon name="robot" small />
					<p>{t.botsStop(info.bots.length, info.bots.map((bot) => bot.name).join(", "), info.graceDays)}</p>
				</div>
			)}
			<div className="row pad-x top-line">
				<span className="grow">
					<small>{t.needsSignIn}</small>
				</span>
				<button
					type="button"
					className="btn btn-danger"
					disabled={blocked}
					title={blocked ? t.blockedByChats : undefined}
					onClick={() => setDialog(recent ? "confirm" : "reauth")}
				>
					{t.deleteButton}
				</button>
			</div>
			{dialog === "reauth" && <ReauthDialog body={t.reauthBody} warning="" href={reauthHref} onClose={() => setDialog(null)} />}
			{dialog === "confirm" && (
				<ConfirmDelete
					info={info}
					onReauth={() => setDialog("reauth")}
					onStale={() => {
						setDialog(null);
						onStale();
					}}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}

/** Typed confirmation (mockups/settings.html#export-delete, confirm frame). */
function ConfirmDelete({ info, onReauth, onStale, onClose }: { info: DeletionInfo; onReauth: () => void; onStale: () => void; onClose: () => void }) {
	const copy = useScreensCopy();
	const t = copy.account;
	const { locale } = useI18n();
	const { self, transport, toasts, signOut } = useServices();
	const account = privacyClient(transport);
	const id = useDomId("delete-account");
	const fieldId = useDomId("delete-confirm");
	const [typed, setTyped] = useState("");
	const [busy, setBusy] = useState(false);
	const [mismatch, setMismatch] = useState(false);
	const matches = typed.trim().replace(/^@/, "").toLowerCase() === self.username.toLowerCase() && self.username !== "";
	const purgeAt = nowSeconds() + info.graceDays * 24 * 3600;

	const submit = () => {
		if (!matches || busy) return;
		setBusy(true);
		account.deleteAccount(typed.trim()).then(
			() => {
				// Every session of the account has ended: wipe this device and leave.
				signOut();
			},
			(err: unknown) => {
				setBusy(false);
				const kind = privacyErrorKind(err);
				if (kind === "reauth_required") onReauth();
				else if (kind === "owns_chats") onStale();
				else if (kind === "invalid") setMismatch(true);
				else toasts.show(copy.common.failed);
			},
		);
	};

	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<DialogHead id={id} title={t.confirmTitle} onClose={onClose} />
				{info.signedInAt > 0 && (
					<div className="banner ok">
						<Icon name="check" small />
						<span className="grow">{t.confirmedAt(brand.idpHost, clock(info.signedInAt, locale))}</span>
					</div>
				)}
				<div className="dlg-body flow">
					<p>{t.confirmBody(dateOf(purgeAt, locale))}</p>
					<div className="field">
						<label htmlFor={fieldId}>{t.typeLabel(self.username)}</label>
						<input
							id={fieldId}
							className="input"
							autoComplete="off"
							spellCheck={false}
							placeholder={self.username}
							value={typed}
							aria-invalid={mismatch}
							onChange={(event) => {
								setTyped(event.target.value);
								setMismatch(false);
							}}
						/>
						{mismatch && <span className="status bad">{t.mismatch}</span>}
					</div>
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-danger" disabled={!matches || busy} aria-busy={busy}>
						{busy ? t.deleting : t.confirm}
					</button>
				</div>
			</form>
		</Modal>
	);
}

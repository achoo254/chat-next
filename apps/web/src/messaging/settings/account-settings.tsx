// "Tài khoản" (mockups/settings.html#export-delete): personal data export
// (background build, download here, 30 days, once per 7 days), and lines
// leading to the IdP's account page, the only place where the account's
// sign-ins are listed and ended (ADR 0006) and where it is deleted (ADR 0016).
import { useEffect, useEffectEvent, useState } from "react";
import { brand } from "../../brand.ts";
import { useLoader } from "../../components/delayed-loader.tsx";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { useLoad } from "../../components/preload.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { clock } from "../data/format.ts";
import { accountData } from "../data/screen-data.ts";
import { useServices } from "../data/services.tsx";
import { formatBytes } from "../media/media-format.ts";
import { privacyClient, privacyErrorKind } from "./privacy-client.ts";
import type { DataExport, ExportState } from "./privacy-api.ts";

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
			<AtIdpCard />
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

/**
 * Account-wide things live at the IdP (docs/settings-menu.md, rule 8): where
 * the account is signed in (ADR 0006) and its deletion (ADR 0016), one line
 * each that leads there.
 */
function AtIdpCard() {
	const t = useScreensCopy().account;
	return (
		<div className="card">
			<p className="note pad-x">
				{t.sessionsNote}{" "}
				<ExternalLink className="link" href={brand.sessionsUrl}>
					{t.sessionsLink}
				</ExternalLink>
			</p>
			<p className="note pad-x pad-b">
				{t.deleteNote}{" "}
				<ExternalLink className="link" href={brand.deleteAccountUrl}>
					{t.deleteLink}
				</ExternalLink>
			</p>
		</div>
	);
}

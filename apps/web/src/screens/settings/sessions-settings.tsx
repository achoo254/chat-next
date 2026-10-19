import { Code } from "@connectrpc/connect";
import { useState } from "react";
import type { SessionView } from "../../api/adapters.ts";
import { useApi } from "../../api/api-context.tsx";
import { errorCode } from "../../api/client.ts";
import { brand } from "../../brand.ts";
import { ExternalLink } from "../../components/external-link.tsx";
import { useLoader } from "../../components/delayed-loader.tsx";
import { useLoad } from "../../components/preload.ts";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { SignOutForm } from "../../components/sign-out-form.tsx";
import { useI18n, type Locale } from "../../i18n/i18n.tsx";
import type { Messages } from "../../i18n/vi.ts";
import { recentTime } from "../../messaging/data/format.ts";
import { sessionsData } from "./sessions-data.ts";

type Notice = { kind: "ok" | "error"; text: string } | null;
type Busy = number | "others" | null;

const PLATFORM_ICONS: Record<SessionView["platform"], IconName> = {
	web: "globe",
	ios: "mobile",
	android: "mobile",
	desktop: "laptop",
	unknown: "laptop",
};

function sessionLabel(session: SessionView, t: Messages["sessions"]): string {
	const device = session.deviceName || t.platform[session.platform];
	return session.appVersion ? `${device} · ${session.appVersion}` : device;
}

/** "Hà Nội · hôm qua 21:52": where, and when the session was last used (mockups/settings.html#sessions). */
function sessionDetail(session: SessionView, t: Messages["sessions"], locale: Locale, now: Date): string {
	const parts = [session.location];
	if (session.current) parts.push(t.activeNow);
	else if (session.lastActiveAt > 0) parts.push(recentTime(session.lastActiveAt, now, locale, t));
	const detail = parts.filter(Boolean).join(" · ");
	return detail.charAt(0).toLocaleUpperCase(locale) + detail.slice(1);
}

function SessionInfo({ session }: { session: SessionView }) {
	const { t, locale } = useI18n();
	const [now] = useState(() => new Date());
	return (
		<>
			<span className="device">
				<Icon name={PLATFORM_ICONS[session.platform]} />
			</span>
			<span className="grow">
				{sessionLabel(session, t.sessions)}
				{session.current && <span className="current">{t.sessions.thisSession}</span>}
				{session.newLogin && !session.current && <span className="fresh">{t.sessions.newLogin}</span>}
				<small>{sessionDetail(session, t.sessions, locale, now)}</small>
			</span>
		</>
	);
}

export function SessionsSettings() {
	const api = useApi();
	const { t } = useI18n();
	// The first load is started by the settings route with this screen's code (messaging-root.tsx).
	const [load, retry, update] = useLoad(sessionsData(api));
	// Unauthenticated already sent the app back to the welcome screen: keep loading until it shows.
	const signedOut = load.status === "error" && errorCode(load.error) === Code.Unauthenticated;
	const loader = useLoader(load.status === "loading" || signedOut, t.common.loading);
	const [busy, setBusy] = useState<Busy>(null);
	const [notice, setNotice] = useState<Notice>(null);

	const keepOnly = (keep: (session: SessionView) => boolean) => update((sessions) => sessions.filter(keep));

	const failure = (err: unknown): Notice => {
		const code = errorCode(err);
		if (code === Code.Unauthenticated) return null;
		if (code === Code.PermissionDenied || code === Code.FailedPrecondition) {
			return { kind: "error", text: t.sessions.needsRecentSignIn };
		}
		return { kind: "error", text: t.common.networkError };
	};

	const revoke = async (session: SessionView) => {
		setBusy(session.id);
		setNotice(null);
		try {
			await api.revokeSession(session.id);
			keepOnly((s) => s.id !== session.id);
			setNotice({ kind: "ok", text: t.sessions.revoked(sessionLabel(session, t.sessions)) });
		} catch (err) {
			if (errorCode(err) === Code.NotFound) {
				// Already gone (expired or revoked elsewhere): the row is stale.
				keepOnly((s) => s.id !== session.id);
			} else {
				setNotice(failure(err));
			}
		}
		setBusy(null);
	};

	const revokeOthers = async () => {
		setBusy("others");
		setNotice(null);
		try {
			const count = await api.revokeOtherSessions();
			keepOnly((s) => s.current);
			setNotice({ kind: "ok", text: t.sessions.revokedOthers(count) });
		} catch (err) {
			setNotice(failure(err));
		}
		setBusy(null);
	};

	if (loader !== null) return loader;

	if (load.status !== "ready") {
		return (
			<div className="set-body">
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{t.common.networkError}</span>
					<button type="button" className="btn btn-sm" onClick={retry}>
						{t.common.retry}
					</button>
				</div>
			</div>
		);
	}

	const current = load.value.filter((s) => s.current);
	const others = load.value.filter((s) => !s.current);

	return (
		<div className="set-body">
			<div role="status">
				{notice?.kind === "ok" && (
					<div className="banner ok">
						<Icon name="check" small />
						<span className="grow">{notice.text}</span>
					</div>
				)}
			</div>
			{notice?.kind === "error" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{notice.text}</span>
				</div>
			)}

			{current.length > 0 && (
				<section className="card" aria-labelledby="sessions-current">
					<h2 className="card-title" id="sessions-current">
						{t.sessions.thisSession}
					</h2>
					<ul className="plain">
						{current.map((session) => (
							<li key={session.id} className="row pad-x">
								<SessionInfo session={session} />
								<SignOutForm className="btn btn-sm">{t.sessions.revoke}</SignOutForm>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="card" aria-labelledby="sessions-others">
				<h2 className="card-title" id="sessions-others">
					{t.sessions.otherDevices}
				</h2>
				{others.length === 0 ? (
					<p className="note pad-x pad-b">{t.sessions.noOthers}</p>
				) : (
					<>
						<ul className="plain">
							{others.map((session) => (
								<li key={session.id} className="row pad-x">
									<SessionInfo session={session} />
									<button
										type="button"
										className="btn btn-sm"
										disabled={busy !== null}
										aria-busy={busy === session.id}
										aria-label={`${t.sessions.revoke}: ${sessionLabel(session, t.sessions)}`}
										onClick={() => void revoke(session)}
									>
										{busy === session.id ? t.sessions.revoking : t.sessions.revoke}
									</button>
								</li>
							))}
						</ul>
						<div className="row pad-x top-line">
							<span className="grow">
								{t.sessions.revokeOthers}
								<small>{t.sessions.revokeOthersHint(brand.idpHost)}</small>
							</span>
							<button
								type="button"
								className="btn danger-outline"
								disabled={busy !== null}
								aria-busy={busy === "others"}
								onClick={() => void revokeOthers()}
							>
								{busy === "others" ? t.sessions.revoking : t.sessions.revokeOthersButton(others.length)}
							</button>
						</div>
					</>
				)}
			</section>

			<section className="card">
				<div className="row pad-x">
					<span className="device">
						<Icon name="shield" />
					</span>
					<span className="grow">
						{t.sessions.account}
						<small>{t.sessions.accountHint}</small>
					</span>
					<ExternalLink className="btn" href={brand.accountUrl}>
						{t.sessions.manageAccount}
					</ExternalLink>
				</div>
			</section>
		</div>
	);
}

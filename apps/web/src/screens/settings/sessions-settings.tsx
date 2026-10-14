import { Code } from "@connectrpc/connect";
import { useEffect, useState } from "react";
import type { SessionView } from "../../api/adapters.ts";
import { useApi } from "../../api/api-context.tsx";
import { errorCode } from "../../api/client.ts";
import { brand } from "../../brand.ts";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon, type IconName } from "../../components/icon.tsx";
import { SignOutForm } from "../../components/sign-out-form.tsx";
import { useI18n, type Locale } from "../../i18n/i18n.tsx";
import type { Messages } from "../../i18n/vi.ts";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; sessions: SessionView[] };
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

function sessionDetail(session: SessionView, t: Messages["sessions"], locale: Locale): string {
	const parts = [session.location];
	if (session.current) parts.push(t.activeNow);
	else if (session.lastActiveAt > 0) {
		const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
			session.lastActiveAt * 1000,
		);
		parts.push(t.lastActive(when));
	}
	return parts.filter(Boolean).join(" · ");
}

function SessionInfo({ session }: { session: SessionView }) {
	const { t, locale } = useI18n();
	return (
		<>
			<span className="device">
				<Icon name={PLATFORM_ICONS[session.platform]} />
			</span>
			<span className="grow">
				{sessionLabel(session, t.sessions)}
				{session.current && <span className="current">{t.sessions.thisSession}</span>}
				{session.newLogin && <span className="fresh">{t.sessions.newLogin}</span>}
				<small>{sessionDetail(session, t.sessions, locale)}</small>
			</span>
		</>
	);
}

export function SessionsSettings() {
	const api = useApi();
	const { t } = useI18n();
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [busy, setBusy] = useState<Busy>(null);
	const [notice, setNotice] = useState<Notice>(null);

	useEffect(() => {
		let active = true;
		api.listSessions().then(
			(sessions) => {
				if (active) setLoad({ status: "ready", sessions });
			},
			(err: unknown) => {
				// Unauthenticated already sent the app back to the welcome screen.
				if (active && errorCode(err) !== Code.Unauthenticated) setLoad({ status: "error" });
			},
		);
		return () => {
			active = false;
		};
	}, [api, attempt]);

	const retry = () => {
		setLoad({ status: "loading" });
		setAttempt((n) => n + 1);
	};

	const keepOnly = (keep: (session: SessionView) => boolean) =>
		setLoad((prev) => (prev.status === "ready" ? { ...prev, sessions: prev.sessions.filter(keep) } : prev));

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
		} finally {
			setBusy(null);
		}
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
		} finally {
			setBusy(null);
		}
	};

	if (load.status === "loading") {
		return (
			<div className="set-body" aria-busy="true">
				<p className="status">
					<span className="spin" aria-hidden="true" />
					{t.common.loading}
				</p>
			</div>
		);
	}

	if (load.status === "error") {
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

	const current = load.sessions.filter((s) => s.current);
	const others = load.sessions.filter((s) => !s.current);

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

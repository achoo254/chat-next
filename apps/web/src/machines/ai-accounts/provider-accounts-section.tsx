// One AI's block on "Tài khoản AI" (ai-accounts-screen.tsx): the AI's own
// sign-in on the machine ("Mặc định hệ thống", or "Đăng nhập hiện tại của …"
// for an AI whose current sign-in can be kept as an account), the accounts the
// machine keeps for it with the one in use, their status and last plan usage,
// and what the AI offers on them (AccountActions): picking one, reading usage
// again, removing one, adding one by signing in from this device or keeping
// the account the AI is signed in as on the machine now. The machine never
// sends a credential, only what the AI reports.
import { useCallback, useState } from "react";
import { AccountStatus, type AiAccount } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { ConfirmDialog } from "../../messaging/bots/dialogs.tsx";
import { Usage } from "../account-menu.tsx";
import type { MachineLink } from "../link/machine-link.ts";
import { usable, type Profiles } from "../machine-profile.ts";
import { SignInCodeDialog } from "../sign-in-code-dialog.tsx";
import { planName, usageOf } from "../status-line.ts";
import { errorText, useNow } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

type FrameBody = Parameters<MachineLink["request"]>[0];

export interface ProviderAccountsSectionProps {
	link: MachineLink;
	online: boolean;
	/** The AI's name, as the machine reports it. */
	ai: string;
	/** The AI's accounts and what it offers on them (machine-profile.ts). */
	profiles: Profiles;
}

export function ProviderAccountsSection({ link, online, ai, profiles }: ProviderAccountsSectionProps) {
	const t = useMachinesCopy();
	const a = t.aiAccounts;
	const { locale } = useI18n();
	const { provider, list } = profiles;
	/** What is running: "select:<id>", "usage:<id>", "remove:<id>", "capture"; "" when idle. */
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<AiAccount | null>(null);
	const actions = list?.actions;

	const run = useCallback(
		(what: string, body: FrameBody) => {
			setBusy(what);
			setError("");
			setNotice("");
			return profiles.request(body).then(
				() => {
					setBusy("");
					return true;
				},
				(err: unknown) => {
					setBusy("");
					setError(errorText(t, err, ai));
					return false;
				},
			);
		},
		[profiles, t, ai],
	);

	const now = useNow(60_000);
	const at = (ms: number) => new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
	/** The AI's own sign-in: one it keeps as accounts reads as its current sign-in, else the system's default. */
	const ownName = actions?.captureCurrent === true ? a.ownCurrent(ai) : a.systemDefault;
	const slug = provider.replace(/[^a-z0-9-]/gi, "-");

	return (
		<section className="card pad mx-card" aria-labelledby={`ai-accounts-${slug}`} data-id={`ai-accounts-${slug}`}>
			<h3 id={`ai-accounts-${slug}`}>{ai}</h3>
			{online && list === null && error === "" && <p className="muted">{a.loading}</p>}
			{list !== null && list.damaged !== "" && (
				<p className="mx-error" role="alert">
					{a.damaged(ai)}
				</p>
			)}
			{list !== null && list.accounts.length > 0 && (
				<ul className="mx-device-list">
					{list.accounts.map((account) => {
						const own = account.id === "";
						const selected = account.id === list.selectedId;
						const signedOut = account.status === AccountStatus.NEEDS_SIGN_IN;
						const unknown = account.status === AccountStatus.ERROR;
						// A saved account keeps its e-mail when it needs to sign in again; the AI's own sign-in shows what the AI says now.
						const name = account.email !== "" && (!signedOut || !own) ? account.email : account.label !== "" ? account.label : own ? ownName : a.notSignedIn;
						const five = usageOf(account.usage?.fiveHour, now);
						const week = usageOf(account.usage?.sevenDay, now);
						const updated = Number(account.usageUpdatedAt);
						const expires = Number(account.loginExpiresAt);
						const sub = [own && name !== ownName ? ownName : "", account.organization, planName(account.plan)].filter((x) => x !== "");
						return (
							<li key={account.id || "own"} className="mx-device" data-id={`ai-accounts-${slug}-item-${account.id || "own"}`}>
								<span className="tx">
									<b>{name}</b>
									<small>
										{selected && <span className="mx-tag">{a.selected}</span>}
										{signedOut && <span className="chip mx-chip warn">{a.needsSignIn}</span>}
										{unknown && <span className="chip mx-chip warn">{a.statusError}</span>}
										{sub.join(" · ")}
									</small>
									{five === null && week === null ? (
										// An AI that never reads usage has nothing to say about it.
										actions?.usage === true && <small>{a.usageUnknown}</small>
									) : (
										<span className="mx-profile-usage">
											{five !== null && <Usage label={t.agent.status.fiveHour} pct={five.pct} />}
											{week !== null && <Usage label={t.agent.status.week} pct={week.pct} />}
										</span>
									)}
									{(updated > 0 || expires > 0) && (
										<small>
											{[updated > 0 ? a.updatedAt(at(updated)) : "", expires > 0 ? (expires > now ? a.loginEnds(at(expires)) : a.loginEnded(at(expires))) : ""]
												.filter((x) => x !== "")
												.join(" · ")}
										</small>
									)}
									{signedOut && !own && <small role="note">{a.needsSignInHint(ai)}</small>}
									{unknown && <small role="note">{a.statusErrorHint(ai)}</small>}
								</span>
								<span className="acts">
									{!selected && (
										<button
											type="button"
											className="btn btn-sm btn-primary"
											title={a.selectHint(ai)}
											disabled={!online || busy !== "" || !usable(account)}
											onClick={() => void run(`select:${account.id}`, { case: "accountSelect", value: { id: account.id, provider } })}
										>
											{busy === `select:${account.id}` ? <span className="spin" aria-hidden="true" /> : null}
											{a.select}
										</button>
									)}
									{actions?.usage === true && (
										<button
											type="button"
											className="btn btn-sm"
											disabled={!online || busy !== "" || (own && signedOut)}
											onClick={() => void run(`usage:${account.id}`, { case: "usageRefresh", value: { id: account.id, provider } })}
										>
											<Icon name="refresh" small />
											{a.refresh}
										</button>
									)}
									{!own && (
										<button type="button" className="btn btn-sm danger-outline" disabled={!online || busy !== ""} onClick={() => setRemoving(account)}>
											<Icon name="trash" small />
											{a.remove}
										</button>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{actions?.captureCurrent === true && <p className="note">{a.captureHint(ai)}</p>}
			{(actions?.signIn === true || actions?.captureCurrent === true) && (
				<div className="acts">
					{actions.signIn && (
						<button type="button" className="btn btn-sm" disabled={!online || busy !== ""} onClick={() => setAdding(true)} data-id={`ai-accounts-${slug}-add`}>
							<Icon name="plus" small />
							{a.add}
						</button>
					)}
					{actions.captureCurrent && (
						<button
							type="button"
							className="btn btn-sm"
							disabled={!online || busy !== ""}
							onClick={() =>
								void run("capture", { case: "accountCaptureCurrent", value: { provider } }).then((ok) => {
									if (ok) setNotice(a.captured);
								})
							}
							data-id={`ai-accounts-${slug}-capture`}
						>
							{busy === "capture" ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" small />}
							{a.capture}
						</button>
					)}
				</div>
			)}
			{notice !== "" && <p role="status">{notice}</p>}
			{error !== "" && removing === null && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{adding && <SignInCodeDialog link={link} ai={ai} provider={provider} onAdded={profiles.reload} onClose={() => setAdding(false)} />}
			{removing !== null && (
				<ConfirmDialog
					title={a.removeTitle(removing.email || removing.label)}
					body={
						<>
							<p>{a.removeBody(ai)}</p>
							{error !== "" && (
								<p className="mx-error" role="alert">
									{error}
								</p>
							)}
						</>
					}
					action={a.remove}
					busyLabel={a.removing}
					busy={busy.startsWith("remove:")}
					danger
					onConfirm={() =>
						void run(`remove:${removing.id}`, { case: "accountRemove", value: { id: removing.id, provider } }).then((ok) => {
							if (ok) setRemoving(null);
						})
					}
					onClose={() => {
						setRemoving(null);
						setError("");
					}}
				/>
			)}
		</section>
	);
}

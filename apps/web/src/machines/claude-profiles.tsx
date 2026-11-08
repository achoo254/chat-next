// The Claude accounts of a machine, on the machine's page: who each profile
// is signed in as, its last plan usage and when that was read, which one new
// sessions use, and picking, refreshing usage, adding (sign-in-code-dialog)
// and removing one. Everything goes to the machine over the encrypted link;
// the machine never sends a credential, only what claude reports.
import { useCallback, useEffect, useState } from "react";
import type { ClaudeProfile, Frame, ProfileListResult } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { SignInCodeDialog } from "./sign-in-code-dialog.tsx";
import { planName, usageOf } from "./status-line.ts";
import { errorText, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface ClaudeProfilesProps {
	link: MachineLink;
	online: boolean;
	ai: string;
}

type FrameBody = Parameters<MachineLink["request"]>[0];

function listOf(frame: Frame): ProfileListResult | null {
	return frame.body.case === "profileListResult" ? frame.body.value : null;
}

export function ClaudeProfiles({ link, online, ai }: ClaudeProfilesProps) {
	const t = useMachinesCopy();
	const p = t.profiles;
	const { locale } = useI18n();
	const [list, setList] = useState<ProfileListResult | null>(null);
	/** What is running: "select:<id>", "usage:<id>", "remove:<id>"; "" when idle. */
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] = useState<ClaudeProfile | null>(null);

	const run = useCallback(
		(what: string, body: FrameBody) => {
			setBusy(what);
			setError("");
			return link.request(body).then(
				(frame) => {
					setBusy("");
					const next = listOf(frame);
					if (next !== null) setList(next);
					return true;
				},
				(err: unknown) => {
					setBusy("");
					setError(errorText(t, err, ai));
					return false;
				},
			);
		},
		[link, t, ai],
	);

	useEffect(() => {
		if (!online) return;
		let active = true;
		link.request({ case: "profileList", value: {} }).then(
			(frame) => {
				const next = listOf(frame);
				if (active && next !== null) setList(next);
			},
			(err: unknown) => {
				if (active) setError(errorText(t, err, ai));
			},
		);
		return () => {
			active = false;
		};
	}, [link, online, t, ai]);

	const now = useNow(60_000);
	const at = (ms: number) => new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
	const pct = (w: Parameters<typeof usageOf>[0]) => {
		const u = usageOf(w, now);
		return u === null ? "?" : `${u.pct}%`;
	};

	return (
		<section className="card pad mx-card" data-id="claude-profiles">
			<h3>{p.title}</h3>
			<p className="note">{p.note}</p>
			{online && list === null && error === "" && <p className="muted">{p.loading}</p>}
			{list !== null && (
				<ul className="mx-device-list">
					{list.profiles.map((profile) => {
						const selected = profile.id === list.selectedId;
						// An added profile keeps its e-mail when it needs to sign in again; the default one shows what claude says now.
						const name = profile.email !== "" && (profile.signedIn || profile.id !== "") ? profile.email : p.notSignedIn;
						const needsSignIn = profile.id !== "" && !profile.signedIn;
						const usage = profile.lastUsage;
						const updated = Number(profile.usageUpdatedAt);
						const expires = Number(profile.loginExpiresAt);
						return (
							<li key={profile.id || "default"} className="mx-device" data-id={`claude-profiles-item-${profile.id || "default"}`}>
								<span className="tx">
									<b>{name}</b>
									<small>
										{selected && <span className="mx-tag">{p.selected}</span>}
										{profile.id === "" && `${p.defaultName} · `}
										{[profile.organization, planName(profile.plan)].filter((x) => x !== "").join(" · ")}
									</small>
									<small>
										{usage === undefined ? p.usageUnknown : p.usage(pct(usage.fiveHour), pct(usage.sevenDay))}
										{updated > 0 && ` · ${p.updatedAt(at(updated))}`}
									</small>
									{expires > 0 && <small>{expires > now ? p.loginEnds(at(expires)) : p.loginEnded(at(expires))}</small>}
									{needsSignIn && (
										<small role="note">
											<span className="chip mx-chip warn">{p.needsSignIn}</span> {p.needsSignInHint}
										</small>
									)}
								</span>
								<span className="acts">
									{!selected && (
										<button
											type="button"
											className="btn btn-sm"
											disabled={!online || busy !== "" || needsSignIn}
											onClick={() => void run(`select:${profile.id}`, { case: "profileSelect", value: { id: profile.id } })}
										>
											{p.select}
										</button>
									)}
									<button
										type="button"
										className="btn btn-sm"
										disabled={!online || busy !== "" || (profile.id === "" && !profile.signedIn)}
										onClick={() => void run(`usage:${profile.id}`, { case: "usageRefresh", value: { id: profile.id } })}
									>
										{p.refresh}
									</button>
									{profile.id !== "" && (
										<button type="button" className="btn btn-sm btn-danger" disabled={!online || busy !== ""} onClick={() => setRemoving(profile)}>
											{p.remove}
										</button>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			<div className="acts">
				<button type="button" className="btn btn-sm" disabled={!online || busy !== ""} onClick={() => setAdding(true)} data-id="claude-profiles-add">
					{p.add}
				</button>
			</div>
			{error !== "" && removing === null && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{adding && (
				<SignInCodeDialog
					link={link}
					ai={ai}
					onAdded={() => void run("load", { case: "profileList", value: {} })}
					onClose={() => setAdding(false)}
				/>
			)}
			{removing !== null && (
				<ConfirmDialog
					title={p.removeTitle(removing.email)}
					body={
						<>
							<p>{p.removeBody}</p>
							{error !== "" && (
								<p className="mx-error" role="alert">
									{error}
								</p>
							)}
						</>
					}
					action={p.remove}
					busyLabel={p.removing}
					busy={busy.startsWith("remove:")}
					danger
					onConfirm={() =>
						void run(`remove:${removing.id}`, { case: "profileRemove", value: { id: removing.id } }).then((ok) => {
							if (ok) setRemoving(null);
						})
					}
					onClose={() => setRemoving(null)}
				/>
			)}
		</section>
	);
}

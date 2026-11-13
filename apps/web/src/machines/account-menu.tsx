// The account item of the status bar: who the session's Claude is signed in
// as, and a menu of the machine's profiles (account, plan, 5-hour and weekly
// usage, when it was read, whether it must sign in again). Picking another
// one switches the whole machine in one tap: idle sessions move at once,
// running ones after their turn (the machine does it and announces it to
// every device). Adding an account opens the sign-in dialog; the machine's
// page keeps the full management.
import { useState } from "react";
import type { AiAccount } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, paths } from "../router.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { signedIn, usable, type Profiles } from "./machine-profile.ts";
import { SignInCodeDialog } from "./sign-in-code-dialog.tsx";
import { planName, usageOf } from "./status-line.ts";
import { errorText, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

interface AccountMenuProps {
	ai: string;
	machine: string;
	link: MachineLink;
	profiles: Profiles;
	/** The profile the session runs with ("" for the default one). */
	current: string;
	/** The account the session reports, while the profile list is not known. */
	fallbackEmail: string;
	disabled: boolean;
}

/** "me@x.com · Max", or the profile's kind when no account is known. */
export function profileName(t: MachinesCopy, profile: AiAccount | undefined, fallback: string): string {
	const email = profile?.email || fallback;
	if (email === "") return profile?.id === "" ? t.agent.account.defaultName : t.agent.account.notSignedIn;
	const plan = planName(profile?.plan ?? "");
	return plan === "" ? email : `${email} · ${plan}`;
}

export function AccountMenu({ ai, machine, link, profiles, current, fallbackEmail, disabled }: AccountMenuProps) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [adding, setAdding] = useState(false);
	const list = profiles.list;
	const mine = list?.accounts.find((p) => p.id === current);
	const label = profileName(t, mine, fallbackEmail);
	if (list === null && fallbackEmail === "") return null;
	const pick = (profile: AiAccount) => {
		if (profile.id === list?.selectedId) return setOpen(false);
		setBusy(profile.id);
		setError("");
		profiles.request({ case: "accountSelect", value: { id: profile.id, provider: profiles.provider } }).then(
			() => {
				setBusy(null);
				setOpen(false);
			},
			(err: unknown) => {
				setBusy(null);
				setError(errorText(t, err, ai));
			},
		);
	};
	return (
		<div className="mx-model mx-account" ref={ref}>
			<button
				type="button"
				className="mx-st-btn"
				title={t.agent.account.label(label)}
				aria-label={t.agent.account.label(label)}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled || list === null}
				onClick={() => setOpen((v) => !v)}
			>
				<MachineIcon name="user" small />
				<span>{label}</span>
				<MachineIcon name="chevron-down" small />
			</button>
			{open && list !== null && (
				<div className="mx-menu up mx-pop mx-profiles" role="menu" aria-label={t.agent.account.title}>
					<h5>{t.agent.account.title}</h5>
					<p className="mx-menu-hint">{t.agent.account.note}</p>
					{list.accounts.map((profile) => (
						<ProfileItem
							key={profile.id || "default"}
							profile={profile}
							selected={profile.id === list.selectedId}
							busy={busy === profile.id}
							disabled={busy !== null || !usable(profile)}
							onPick={() => pick(profile)}
						/>
					))}
					<hr />
					<button
						type="button"
						role="menuitem"
						className="mx-menu-row"
						disabled={busy !== null}
						onClick={() => {
							setOpen(false);
							setAdding(true);
						}}
					>
						<Icon name="plus" small />
						<span>{t.agent.account.add}</span>
					</button>
					<Link to={paths.machineInfo(machine)} className="mx-menu-link">
						<Icon name="settings" small />
						<span>{t.agent.account.manage}</span>
					</Link>
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
			{adding && <SignInCodeDialog link={link} ai={ai} provider={profiles.provider} onAdded={profiles.reload} onClose={() => setAdding(false)} />}
		</div>
	);
}

interface ProfileItemProps {
	profile: AiAccount;
	selected: boolean;
	busy: boolean;
	disabled: boolean;
	onPick: () => void;
}

function ProfileItem({ profile, selected, busy, disabled, onPick }: ProfileItemProps) {
	const t = useMachinesCopy();
	const a = t.agent.account;
	const { locale } = useI18n();
	const now = useNow(60_000);
	const five = usageOf(profile.usage?.fiveHour, now);
	const week = usageOf(profile.usage?.sevenDay, now);
	const updated = Number(profile.usageUpdatedAt);
	const needsSignIn = profile.id !== "" && !signedIn(profile);
	const email = profile.email !== "" ? profile.email : profile.id === "" ? a.defaultName : a.notSignedIn;
	const sub = [profile.id === "" ? a.defaultName : "", profile.organization, planName(profile.plan)].filter((x) => x !== "" && x !== email).join(" · ");
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={selected}
			className="mx-profile"
			disabled={disabled && !selected}
			title={selected ? a.current : a.switchTo(email)}
			aria-label={selected ? `${email} · ${a.current}` : a.switchTo(email)}
			onClick={onPick}
		>
			{selected ? <Icon name="check" small /> : busy ? <span className="spin" aria-hidden="true" /> : <span className="mx-menu-gap" />}
			<span className="tx">
				<b>{email}</b>
				{sub !== "" && <small>{sub}</small>}
				{needsSignIn ? (
					<small className="warn">{a.needsSignIn}</small>
				) : five === null && week === null ? (
					<small>{a.unknown}</small>
				) : (
					<span className="mx-profile-usage">
						{five !== null && <Usage label={t.agent.status.fiveHour} pct={five.pct} />}
						{week !== null && <Usage label={t.agent.status.week} pct={week.pct} />}
					</span>
				)}
				{updated > 0 && !needsSignIn && <small>{a.updatedAt(new Date(updated).toLocaleString(locale, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }))}</small>}
			</span>
		</button>
	);
}

function Usage({ label, pct }: { label: string; pct: number }) {
	return (
		<span className={pct >= 80 ? "mx-st-item warn" : "mx-st-item"}>
			<span>{label}</span>
			<span className="mx-bar" aria-hidden="true">
				<i style={{ width: `${pct}%` }} />
			</span>
			<span>{pct}%</span>
		</span>
	);
}

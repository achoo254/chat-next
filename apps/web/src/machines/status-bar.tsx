// The slim line above the composer, like the user's terminal statusline:
// folder, git branch, model and effort, context used, the signed-in account,
// its 5-hour and weekly usage with the time until they reset, lines changed,
// and the session's permission mode, which a device can change from here.
// Whatever is not known yet is left out.
import { useState } from "react";
import type { ThreadInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { permissionMode, planName, usageOf } from "./status-line.ts";
import { errorText, folderName, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

interface StatusBarProps {
	ai: string;
	/** The session's folder on the machine; "" when unknown. */
	dir: string;
	/** The model's display name; "" for the AI's default. */
	model: string;
	/** Share of the context window used (0-1); null when unknown. */
	context: number | null;
	info: ThreadInfo | undefined;
	link: MachineLink;
	threadId: string;
	online: boolean;
}

export function StatusBar({ ai, dir, model, context, info, link, threadId, online }: StatusBarProps) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const now = useNow(30_000);
	const five = usageOf(info?.rateLimits?.fiveHour, now);
	const week = usageOf(info?.rateLimits?.sevenDay, now);
	const at = (ms: number, withDay: boolean) =>
		ms > 0 ? new Date(ms).toLocaleString(locale, withDay ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) : "";
	const pct = context === null ? null : Math.round(context * 100);
	const mode = info === undefined || info.permissionMode === "" ? null : info.permissionMode;
	const effort = info === undefined || info.effort === "" ? "" : (t.chat.efforts[info.effort] ?? info.effort);
	const account = info?.account;
	return (
		<div className="mx-status" role="group" aria-label={t.statusBar.label}>
			<div className="mx-status-row">
				{dir !== "" && (
					<span className="mx-st-item" title={t.statusBar.folder(dir)}>
						<MachineIcon name="folder" small />
						<span className="mono">{folderName(dir)}</span>
					</span>
				)}
				{info !== undefined && info.gitBranch !== "" && (
					<span className="mx-st-item" title={t.statusBar.branch(info.gitBranch)}>
						<MachineIcon name="branch" small />
						<span className="mono">{info.gitBranch}</span>
					</span>
				)}
				<span className="mx-st-item" title={t.statusBar.model(model || t.statusBar.defaultModel)}>
					<MachineIcon name="cpu" small />
					<span>{model || t.statusBar.defaultModel}</span>
				</span>
				{effort !== "" && (
					<span className="mx-st-item" title={t.statusBar.effort(effort)}>
						<MachineIcon name="gauge" small />
						<span>{effort}</span>
					</span>
				)}
				{pct !== null && (
					<span className="mx-st-item mx-ctx" title={t.statusBar.context(pct)}>
						<span className="bar" aria-hidden="true">
							<i style={{ width: `${pct}%` }} />
						</span>
						<span>{pct}%</span>
						<span className="sr-only">{t.statusBar.context(pct)}</span>
					</span>
				)}
				{account !== undefined && account.email !== "" && (
					<span className="mx-st-item" title={t.statusBar.accountHint(ai, account.organization)}>
						<MachineIcon name="user" small />
						<span>{t.statusBar.account(account.email, planName(account.plan))}</span>
					</span>
				)}
				{five !== null && (
					<span className="mx-st-item" title={t.statusBar.fiveHourHint(five.pct, at(five.resetsAt, false))}>
						{t.statusBar.fiveHour(five.pct)}
						{five.left !== null && ` · ${t.statusBar.resetIn(five.left.days, five.left.hours, five.left.minutes)}`}
					</span>
				)}
				{week !== null && (
					<span className="mx-st-item" title={t.statusBar.weekHint(week.pct, at(week.resetsAt, true))}>
						{t.statusBar.week(week.pct)}
						{week.left !== null && ` · ${t.statusBar.resetIn(week.left.days, week.left.hours, week.left.minutes)}`}
					</span>
				)}
				{info !== undefined && (info.linesAdded > 0 || info.linesRemoved > 0) && (
					<span className="mx-st-item mx-st-lines" title={t.statusBar.lines(info.linesAdded, info.linesRemoved)}>
						<span className="add">+{info.linesAdded}</span>
						<span className="del">−{info.linesRemoved}</span>
					</span>
				)}
				{mode !== null && <ModeMenu ai={ai} mode={mode} modes={info?.permissionModes ?? []} link={link} threadId={threadId} disabled={!online} />}
			</div>
		</div>
	);
}

interface ModeMenuProps {
	ai: string;
	mode: string;
	/** Modes the machine lets a device pick; empty on an agent too old to switch. */
	modes: readonly string[];
	link: MachineLink;
	threadId: string;
	disabled: boolean;
}

/** The session's permission mode; a menu of the allowed modes when the machine offers any. */
function ModeMenu({ ai, mode, modes, link, threadId, disabled }: ModeMenuProps) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const label = (m: string) => {
		const known = permissionMode(m);
		return known === null ? m : t.statusBar.modes[known];
	};
	const className = permissionMode(mode) === "bypassPermissions" ? "mx-mode warn" : "mx-mode";
	if (modes.length === 0) {
		return (
			<span className={className}>
				<MachineIcon name="shield" small />
				{label(mode)}
			</span>
		);
	}
	const pick = (next: string) => {
		if (next === mode) return setOpen(false);
		setBusy(true);
		setError("");
		link.request({ case: "threadSetPermissionMode", value: { threadId, mode: next } }).then(
			() => {
				setBusy(false);
				setOpen(false);
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	return (
		<div className="mx-model" ref={ref}>
			<button type="button" className={className} title={t.statusBar.modeHint(ai)} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
				<MachineIcon name="shield" small />
				{label(mode)}
				<MachineIcon name="chevron-down" small />
			</button>
			{open && (
				<div className="mx-menu up" role="menu" aria-label={t.statusBar.modeMenu}>
					<h5>{t.statusBar.modeMenu}</h5>
					{modes.map((m) => {
						const known = permissionMode(m);
						return (
							<button key={m} type="button" role="menuitemradio" aria-checked={m === mode} disabled={busy} onClick={() => pick(m)}>
								{m === mode ? <Icon name="check" small /> : <span className="mx-menu-gap" />}
								<span>
									{label(m)}
									{known !== null && <small>{t.statusBar.modeHints[known]}</small>}
								</span>
							</button>
						);
					})}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

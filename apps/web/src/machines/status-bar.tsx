// The slim line above the composer: the model (a menu of models and
// effort), the session's permission mode (a menu of the modes the machine
// allows) and the account's 5-hour usage as a bar, the weekly one too once
// it nears its limit. Everything else the user's terminal statusline shows
// (folder, branch, effort, context used, account, both usage windows with
// their reset, lines changed) sits in "Chi tiết", labelled. One line on
// phones. Whatever is not known yet is left out.
import { useState, type ReactNode } from "react";
import type { MachineInfo, ThreadInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { ModelMenu } from "./model-menu.tsx";
import { modeKey, modeLabel, planName, usageOf, type Countdown } from "./status-line.ts";
import { defaultModelName, errorText, modelName, providerOf, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

/** At this share of a usage window the bar warns. */
export const USAGE_WARN = 80;

interface StatusBarProps {
	ai: string;
	/** The session's folder on the machine; "" when unknown. */
	dir: string;
	/** What the machine reports about itself (models, providers). */
	machine: MachineInfo | null;
	provider: string;
	/** The model id answering now; "" for the AI's default. */
	model: string;
	/** The model that answered the latest turn (the default resolved); "" when none did yet. */
	answered: string;
	/** Share of the context window used (0-1); null when unknown. */
	context: number | null;
	info: ThreadInfo | undefined;
	link: MachineLink;
	threadId: string;
	online: boolean;
	/** The account item (account-menu.tsx); absent when the AI reports no account. */
	account?: ReactNode;
	/** The account the session moves to after this turn; "" when it stays. */
	switchingTo?: string;
}

/** "mặc định · Opus 5.5", or "mặc định" while which model it is is not known. */
function defaultLabel(t: MachinesCopy, name: string): string {
	return name === "" ? t.statusBar.defaultModel : t.statusBar.defaultIs(name);
}

function countdown(t: MachinesCopy, left: Countdown | null): string {
	return left === null ? "" : t.statusBar.resetIn(left.days, left.hours, left.minutes);
}

function Bar({ pct }: { pct: number }) {
	return (
		<span className="mx-bar" aria-hidden="true">
			<i style={{ width: `${pct}%` }} />
		</span>
	);
}

export function StatusBar({ ai, dir, machine, provider, model, answered, context, info, link, threadId, online, account, switchingTo = "" }: StatusBarProps) {
	const t = useMachinesCopy();
	const now = useNow(30_000);
	const five = usageOf(info?.rateLimits?.fiveHour, now);
	const week = usageOf(info?.rateLimits?.sevenDay, now);
	const mode = info === undefined || info.permissionMode === "" ? null : info.permissionMode;
	return (
		<div className="mx-status" role="group" aria-label={t.statusBar.label}>
			{switchingTo !== "" && (
				<p className="mx-status-note" role="status">
					<MachineIcon name="ai-account" small />
					{t.agent.account.pending(switchingTo)}
				</p>
			)}
			<div className="mx-status-row">
				<ModelMenu link={link} info={machine} threadId={threadId} provider={provider} model={model} answered={answered} effort={info?.effort ?? ""} disabled={!online} />
				{mode !== null && (
					<ModeMenu ai={ai} mode={mode} modes={info?.permissionModes ?? []} bypass={providerOf(machine, provider)?.capabilities?.bypassModeId ?? ""} link={link} threadId={threadId} disabled={!online} />
				)}
				{account}
				{five !== null && five.pct >= USAGE_WARN && (
					<span
						className={five.pct >= USAGE_WARN ? "mx-st-item mx-usage warn" : "mx-st-item mx-usage"}
						title={t.agent.status.usageValue(five.pct, countdown(t, five.left))}
					>
						<span className="lbl">{t.agent.status.fiveHour}</span>
						<Bar pct={five.pct} />
						<span>{five.pct}%</span>
						<span className="sr-only">{`${t.agent.status.usage} ${t.agent.status.fiveHour}: ${t.agent.status.usageValue(five.pct, countdown(t, five.left))}`}</span>
					</span>
				)}
				{week !== null && week.pct >= USAGE_WARN && (
					<span className="mx-st-item mx-usage warn" title={t.agent.status.usageValue(week.pct, countdown(t, week.left))}>
						<span className="lbl">{t.agent.status.week}</span>
						<Bar pct={week.pct} />
						<span>{week.pct}%</span>
						<span className="sr-only">{`${t.agent.status.usage} ${t.agent.status.week}: ${t.agent.status.usageValue(week.pct, countdown(t, week.left))}`}</span>
					</span>
				)}
				<Details ai={ai} dir={dir} machine={machine} provider={provider} model={model} answered={answered} context={context} info={info} now={now} />
			</div>
		</div>
	);
}

interface DetailsProps {
	ai: string;
	dir: string;
	machine: MachineInfo | null;
	provider: string;
	model: string;
	answered: string;
	context: number | null;
	info: ThreadInfo | undefined;
	now: number;
}

/** "Chi tiết": every statusline value with its name. */
function Details({ ai, dir, machine, provider, model, answered, context, info, now }: DetailsProps) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const { open, setOpen, ref } = usePopover();
	const five = usageOf(info?.rateLimits?.fiveHour, now);
	const week = usageOf(info?.rateLimits?.sevenDay, now);
	const pct = context === null ? null : Math.round(context * 100);
	const effort = info === undefined || info.effort === "" ? "" : (t.chat.efforts[info.effort] ?? info.effort);
	const account = info?.account;
	const at = (ms: number, withDay: boolean) =>
		ms > 0 ? new Date(ms).toLocaleString(locale, withDay ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) : "";
	const usage = (label: string, u: NonNullable<typeof five>, withDay: boolean) => (
		<>
			<dt>{label}</dt>
			<dd className="mx-dd-usage" title={at(u.resetsAt, withDay)}>
				<Bar pct={u.pct} />
				<span>{t.agent.status.usageValue(u.pct, countdown(t, u.left))}</span>
			</dd>
		</>
	);
	return (
		<div className="mx-model mx-details" ref={ref}>
			<button type="button" className="mx-st-btn" aria-label={t.agent.status.details} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<Icon name="info" small />
				<span className="hide-narrow">{t.agent.status.details}</span>
			</button>
			{open && (
				<div className="mx-menu up mx-pop" role="dialog" aria-label={t.agent.status.detailsTitle}>
					<h5>{t.agent.status.detailsTitle}</h5>
					<dl className="mx-kv">
						{dir !== "" && (
							<>
								<dt>{t.agent.status.folder}</dt>
								<dd className="mono">{dir}</dd>
							</>
						)}
						{info !== undefined && info.gitBranch !== "" && (
							<>
								<dt>{t.agent.status.branch}</dt>
								<dd className="mono">{info.gitBranch}</dd>
							</>
						)}
						<dt>{t.agent.status.model}</dt>
						<dd>{model === "" ? defaultLabel(t, defaultModelName(machine, provider, answered)) : `${ai} · ${modelName(machine, provider, model)}`}</dd>
						{effort !== "" && (
							<>
								<dt>{t.agent.status.effort}</dt>
								<dd>{effort}</dd>
							</>
						)}
						{pct !== null && (
							<>
								<dt>{t.agent.status.context}</dt>
								<dd className="mx-dd-usage">
									<Bar pct={pct} />
									<span>{t.agent.status.contextValue(pct)}</span>
								</dd>
							</>
						)}
						{account !== undefined && account.email !== "" && (
							<>
								<dt>{t.agent.status.account}</dt>
								<dd title={t.statusBar.accountHint(ai, account.organization)}>{t.statusBar.account(account.email, planName(account.plan))}</dd>
							</>
						)}
						{five !== null && usage(`${t.agent.status.usage} ${t.agent.status.fiveHour}`, five, false)}
						{week !== null && usage(`${t.agent.status.usage} ${t.agent.status.week}`, week, true)}
						{info !== undefined && (info.linesAdded > 0 || info.linesRemoved > 0) && (
							<>
								<dt>{t.agent.status.lines}</dt>
								<dd className="mx-st-lines">
									<span className="add">+{info.linesAdded}</span> <span className="del">−{info.linesRemoved}</span>
								</dd>
							</>
						)}
					</dl>
				</div>
			)}
		</div>
	);
}

interface ModeMenuProps {
	ai: string;
	mode: string;
	/** Modes the machine lets a device pick; empty on an agent too old to switch. */
	modes: readonly string[];
	/** The AI's mode that skips every prompt (ProviderCapabilities.bypass_mode_id); "" when it has none. */
	bypass: string;
	link: MachineLink;
	threadId: string;
	disabled: boolean;
}

/** The session's permission mode; a menu of the allowed modes when the machine offers any. */
function ModeMenu({ ai, mode, modes, bypass, link, threadId, disabled }: ModeMenuProps) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const label = (m: string) => modeLabel(t.statusBar.modes, m, bypass);
	const className = modeKey(mode, bypass) === "bypass" ? "mx-mode warn" : "mx-mode";
	if (modes.length === 0) {
		return (
			<span className={className} title={t.agent.status.mode}>
				<MachineIcon name="ai-permission" small />
				<span>{label(mode)}</span>
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
				<MachineIcon name="ai-permission" small />
				<span>{label(mode)}</span>
				<MachineIcon name="chevron-down" small />
			</button>
			{open && (
				<div className="mx-menu up" role="menu" aria-label={t.statusBar.modeMenu}>
					<h5>{t.statusBar.modeMenu}</h5>
					{modes.map((m) => {
						const known = modeKey(m, bypass);
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

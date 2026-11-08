// The slim line above the composer, like the user's terminal statusline:
// folder, git branch, model, context used, the account's 5-hour and weekly
// usage with the time until they reset, lines changed, and the session's
// permission mode (read-only: it follows the AI's settings on the machine).
// Whatever is not known yet is left out.
import type { ThreadInfo } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { permissionMode, usageOf } from "./status-line.ts";
import { folderName, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface StatusBarProps {
	ai: string;
	/** The session's folder on the machine; "" when unknown. */
	dir: string;
	/** The model's display name; "" for the AI's default. */
	model: string;
	/** Share of the context window used (0-1); null when unknown. */
	context: number | null;
	info: ThreadInfo | undefined;
}

export function StatusBar({ ai, dir, model, context, info }: StatusBarProps) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const now = useNow(30_000);
	const five = usageOf(info?.rateLimits?.fiveHour, now);
	const week = usageOf(info?.rateLimits?.sevenDay, now);
	const at = (ms: number, withDay: boolean) =>
		ms > 0 ? new Date(ms).toLocaleString(locale, withDay ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) : "";
	const pct = context === null ? null : Math.round(context * 100);
	const mode = info === undefined || info.permissionMode === "" ? null : info.permissionMode;
	const known = mode === null ? null : permissionMode(mode);
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
				{pct !== null && (
					<span className="mx-st-item mx-ctx" title={t.statusBar.context(pct)}>
						<span className="bar" aria-hidden="true">
							<i style={{ width: `${pct}%` }} />
						</span>
						<span>{pct}%</span>
						<span className="sr-only">{t.statusBar.context(pct)}</span>
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
				{mode !== null && (
					<span className={known === "bypassPermissions" ? "mx-mode warn" : "mx-mode"} title={t.statusBar.modeHint(ai)}>
						<MachineIcon name="shield" small />
						{known === null ? mode : t.statusBar.modes[known]}
					</span>
				)}
			</div>
		</div>
	);
}

// On a machine's page, next to the tunelo version: whether a newer tunelo
// exists, and the button that updates the machine from this device
// (AgentUpdateStart). The machine downloads and checks the signed file itself,
// reports each step, then restarts; the link reconnects to the new version.
import { useState, type ReactElement } from "react";
import type { AgentUpdateProgress, MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { machineErrorText } from "./machine-errors.ts";
import { updateView } from "./agent-update-view.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface AgentUpdateSettingProps {
	link: Pick<MachineLink, "request">;
	info: MachineInfo;
	/** The newest AgentUpdateProgress of this link; null before any. */
	progress: AgentUpdateProgress | null;
	online: boolean;
}

export function AgentUpdateSetting({ link, info, progress, online }: AgentUpdateSettingProps): ReactElement {
	const t = useMachinesCopy();
	const u = t.update;
	const view = updateView(info, progress);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState("");

	const run = (body: Parameters<MachineLink["request"]>[0]) => {
		setBusy(true);
		setError("");
		link.request(body).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(machineErrorText(t, err, ""));
			},
		);
	};
	const start = () => {
		setConfirming(false);
		run({ case: "agentUpdateStart", value: {} });
	};
	const sessions = info.openSessions;

	return (
		<div className="mx-update" data-id="machine-update">
			{view.kind === "manual" && <span className="note">{u.manual}</span>}
			{view.kind === "unsupported" && <span className="note">{u.unsupported}</span>}
			{view.kind === "upToDate" && <span className="note">{u.upToDate}</span>}
			{view.kind === "available" && (
				<span className="chip mx-chip warn" data-id="machine-update-available">
					{u.available(view.version)}
				</span>
			)}
			{view.kind === "working" && (
				<div className="mx-wait" role="status" data-id="machine-update-progress">
					{view.percent !== null && <progress max={100} value={view.percent} aria-label={u.working.downloading(view.percent)} />}
					<span>{u.working[view.phase](view.percent)}</span>
				</div>
			)}
			{view.kind === "restarting" && (
				<div className="mx-wait" role="status" data-id="machine-update-restarting">
					<span className="spin" aria-hidden="true" />
					{u.restarting(view.version)}
				</div>
			)}
			{view.kind === "failed" && (
				<p className="mx-error" role="alert" data-id="machine-update-failed">
					{u.failed(view.message)}
				</p>
			)}
			{(view.kind === "available" || view.kind === "failed") && !confirming && (
				<div>
					<button
						type="button"
						className="btn btn-sm"
						disabled={!online || busy}
						data-id="machine-update-start"
						onClick={() => (sessions > 0 ? setConfirming(true) : start())}
					>
						{view.kind === "failed" ? u.retry : u.update}
					</button>
				</div>
			)}
			{confirming && (
				<div className="mx-hint warn" role="note" data-id="machine-update-confirm">
					<span>{u.sessionsWarn(sessions)}</span>
					<div className="acts">
						<button type="button" className="btn btn-sm" disabled={!online || busy} data-id="machine-update-confirm-yes" onClick={start}>
							{u.confirm}
						</button>
						<button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
							{u.cancel}
						</button>
					</div>
				</div>
			)}
			{(view.kind === "upToDate" || view.kind === "unsupported") && (
				<div>
					<button
						type="button"
						className="btn btn-sm"
						disabled={!online || busy}
						data-id="machine-update-check"
						onClick={() => run({ case: "agentUpdateCheck", value: {} })}
					>
						{busy ? u.checking : u.check}
					</button>
				</div>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

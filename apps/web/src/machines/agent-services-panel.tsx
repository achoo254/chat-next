// tunelo's services on a machine's page: each one's state at a glance (runs,
// off, port taken, error and why), what it is for, why it is needed and what
// turning it off does, and the buttons to turn it on or off, restart it, close
// a tunnel or restart tunelo itself (AgentServiceControl, AgentRestart).
import { useState, type ReactElement } from "react";
import { AgentServiceAction, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import { type ServiceRow, serviceCounts, serviceRows } from "./agent-services-view.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { machineErrorText } from "./machine-errors.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Props = {
	link: Pick<MachineLink, "request">;
	info: MachineInfo;
	machineName: string;
	online: boolean;
	/** tunelo was asked to restart and has not come back yet (machine-detail.tsx keeps it across the reconnection). */
	restarting: boolean;
	onRestartAsked: () => void;
};

type Confirming = { kind: "restartAgent" } | { kind: "closeTunnel"; row: ServiceRow };

const CHIP: Readonly<Record<ServiceRow["state"], string>> = {
	running: "chip mx-chip ok",
	off: "chip mx-chip",
	portTaken: "chip mx-chip warn",
	failed: "chip mx-chip error",
};

export function AgentServicesPanel({ link, info, machineName, online, restarting, onRestartAsked }: Props): ReactElement | null {
	const t = useMachinesCopy();
	const s = t.services;
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	const runtime = info.runtime;
	if (runtime === undefined) return null;
	const rows = serviceRows(runtime);
	const counts = serviceCounts(rows);

	const send = (key: string, body: Parameters<MachineLink["request"]>[0], after?: () => void) => {
		setBusy(key);
		setError("");
		link.request(body).then(
			() => {
				setBusy(null);
				after?.();
			},
			(err: unknown) => {
				setBusy(null);
				setError(machineErrorText(t, err, ""));
			},
		);
	};
	const control = (row: ServiceRow, action: AgentServiceAction) =>
		send(`${row.key}:${action}`, { case: "agentServiceControl", value: { kind: row.portKind, action, tunnelId: row.tunnelId } });
	const restartAgent = () => {
		setConfirming(null);
		send("agent", { case: "agentRestart", value: {} }, onRestartAsked);
	};

	return (
		<section className="mx-svc" aria-labelledby="mx-svc-title" data-id="agent-services">
			<div className="mx-svc-head">
				<div className="mx-svc-title">
					<h4 id="mx-svc-title">{s.title}</h4>
					{rows.length > 0 && (
						<span className={counts.problems > 0 ? "mx-svc-count warn" : "mx-svc-count"} data-id="agent-services-summary">
							{s.summary(counts.running, counts.total, counts.problems)}
						</span>
					)}
				</div>
				{runtime.restartable && (
					<button
						type="button"
						className="btn btn-sm"
						disabled={!online || busy !== null || restarting}
						data-id="agent-services-restart-agent"
						onClick={() => setConfirming({ kind: "restartAgent" })}
					>
						<Icon name="refresh" small />
						{busy === "agent" ? s.working : s.restartAgent}
					</button>
				)}
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			<ul className="mx-svc-list">
				{rows.map((row) => (
					<ServiceItem key={row.key} row={row} name={t.detail.portKind[row.kind]} s={s} busy={busy} disabled={!online || busy !== null || restarting} onControl={control} onClose={(r) => setConfirming({ kind: "closeTunnel", row: r })} />
				))}
			</ul>
			{confirming?.kind === "restartAgent" && (
				<ConfirmDialog
					title={s.restartTitle(machineName)}
					body={
						<>
							<p>{s.restartBody}</p>
							{info.openSessions > 0 && <p className="mx-warn">{s.restartSessions(info.openSessions)}</p>}
						</>
					}
					action={s.restartAgent}
					busyLabel={s.working}
					busy={busy === "agent"}
					danger={false}
					onConfirm={restartAgent}
					onClose={() => setConfirming(null)}
				/>
			)}
			{confirming?.kind === "closeTunnel" && (
				<ConfirmDialog
					title={s.closeTitle(
						rows
							.filter((r) => r.tunnelId === confirming.row.tunnelId)
							.map((r) => r.port)
							.join(", "),
					)}
					body={<p>{s.closeBody}</p>}
					action={s.closeTunnel}
					busyLabel={s.working}
					busy={busy !== null}
					danger
					onConfirm={() => {
						const row = confirming.row;
						setConfirming(null);
						control(row, AgentServiceAction.STOP);
					}}
					onClose={() => setConfirming(null)}
				/>
			)}
		</section>
	);
}

function ServiceItem({
	row,
	name,
	s,
	busy,
	disabled,
	onControl,
	onClose,
}: {
	row: ServiceRow;
	name: string;
	s: MachinesCopy["services"];
	busy: string | null;
	disabled: boolean;
	onControl: (row: ServiceRow, action: AgentServiceAction) => void;
	onClose: (row: ServiceRow) => void;
}): ReactElement {
	const text = s.kind[row.kind];
	const tunnel = row.kind === "tunnelHttp" || row.kind === "tunnelTcp";
	const problem = row.state === "portTaken" ? s.problem.portTaken(row.port) : row.problem === undefined ? undefined : s.problem[row.problem];
	const label = (action: AgentServiceAction): string =>
		busy === `${row.key}:${action}` ? s.working : action === AgentServiceAction.START ? s.start : action === AgentServiceAction.RESTART ? s.restart : tunnel ? s.closeTunnel : s.stop;
	return (
		<li className={`mx-svc-item ${row.state}`} data-id={`agent-service-${row.kind}-${row.port}`}>
			<div className="mx-svc-row">
				<span className={CHIP[row.state]}>{s.state[row.state]}</span>
				<span className="mx-svc-name">{name}</span>
				<span className="mono mx-svc-port">{row.port > 0 ? row.port : s.noPort}</span>
				{row.controls.length > 0 && (
					<span className="mx-svc-acts">
						{row.controls.map((action) => (
							<button
								key={action}
								type="button"
								className={action === AgentServiceAction.STOP && tunnel ? "btn btn-sm danger-outline" : "btn btn-sm"}
								disabled={disabled}
								aria-label={`${label(action)} · ${name}${row.port > 0 ? ` ${row.port}` : ""}`}
								data-id={`agent-service-${row.kind}-${row.port}-${AgentServiceAction[action].toLowerCase()}`}
								onClick={() => (action === AgentServiceAction.STOP && tunnel ? onClose(row) : onControl(row, action))}
							>
								{action === AgentServiceAction.RESTART && <Icon name="refresh" small />}
								{label(action)}
							</button>
						))}
					</span>
				)}
			</div>
			<p className="mx-svc-purpose">{text.purpose}</p>
			{row.urls.map((url) => (
				<a key={url} className="mono mx-port-url" href={url} target="_blank" rel="noreferrer">
					{url}
				</a>
			))}
			{problem !== undefined && (
				<p className={row.state === "failed" ? "mx-svc-problem error" : "mx-svc-problem warn"} data-id={`agent-service-${row.kind}-${row.port}-problem`}>
					<Icon name="alert-triangle" small />
					<span>{problem}</span>
				</p>
			)}
			<details className="mx-svc-more">
				<summary>{s.more}</summary>
				<dl>
					<dt>{s.why}</dt>
					<dd>{text.why}</dd>
					<dt>{s.ifOff}</dt>
					<dd>
						{text.ifOff}
						{row.controls.length === 0 && !tunnel && <> {s.onlyWithTunelo}</>}
					</dd>
				</dl>
			</details>
		</li>
	);
}


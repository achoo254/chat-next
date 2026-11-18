// The inspector panel: what the office wire says about the person you opened,
// worded in the viewer's language (the record itself, office-inspector.ts, has
// no text). Read only: no chat and no control over the agent. A column beside
// the scene on a wide screen, a sheet under it on a phone (office.css); the
// scene shrinks to make room, so the person chosen is never behind it. Not
// modal: the office keeps running and the panel follows it.
import type { CSSProperties, ReactNode } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { HeldInspected, InspectorEntry, InspectorModel } from "./office-inspector.ts";
import { personColor, personName, type MarkerStatus, type OfficeCopy } from "./office-names.ts";
import type { TimelineResult } from "./office-timeline.ts";

type ColorStyle = CSSProperties & { "--of-color": string };

/** The status line of the person: what the dot means, in words. */
function statusText(t: OfficeCopy, model: InspectorModel): string {
	if (model.mode === "life" && model.life !== null) return t.life[model.life.act];
	const status: MarkerStatus = model.status;
	if (status === "stuck") return t.stuck(Math.floor((model.work?.stuckMs ?? 0) / 60_000));
	if (status === "idle") return t.inspector.idle;
	if (status === "working") return t.inspector.working;
	if (status === "waiting-you") return t.state.waitingYou;
	return t.state[status];
}

function resultText(t: OfficeCopy, result: TimelineResult): string {
	if (result === "ok") return t.inspector.passed;
	return result === "failed" ? t.inspector.failed : t.inspector.unknownResult;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="of-panel-row">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function Entry({ entry, t }: { entry: InspectorEntry; t: OfficeCopy }) {
	return (
		<li className="of-panel-entry" data-result={entry.result}>
			<span>{t.inspector.groups[entry.group]}</span>
			<span className="of-panel-muted">{t.rooms[entry.room]}</span>
			<span className="of-panel-result">{resultText(t, entry.result)}</span>
			<span className="of-panel-muted">
				{entry.ms > 0 ? `${t.inspector.duration(entry.ms)} · ` : ""}
				{t.inspector.ago(t.inspector.duration(entry.agoMs))}
			</span>
		</li>
	);
}

export function InspectorPanel({ held, onClose }: { held: HeldInspected; onClose: () => void }) {
	const t = useMachinesCopy().office;
	const { model, placement } = held;
	const name = personName(t, placement);
	const style: ColorStyle = { "--of-color": personColor(placement) };
	const left = held.leftAt !== null;
	const work = model.work;
	return (
		<aside className="of-panel" aria-label={t.inspector.label} data-id="office-inspector" data-key={model.key} data-kind={model.kind} data-mode={model.mode} data-left={left ? "" : undefined} style={style}>
			<header className="of-panel-head">
				<span className="of-dot of-panel-dot" aria-hidden="true" />
				<div className="of-panel-title">
					<h3>{name}</h3>
					<p className="of-panel-muted">{model.homeRoom === null ? t.rooms[model.room] : `${t.inspector.homeRoom}: ${t.rooms[model.homeRoom]}`}</p>
				</div>
				<button type="button" className="of-toggle of-panel-close" onClick={onClose} aria-label={t.inspector.close} data-id="office-inspector-close">
					×
				</button>
			</header>
			{left && (
				<p className="of-note" role="status" data-tone="warn">
					{t.inspector.left}
				</p>
			)}
			{model.stale && !left && <p className="of-note">{t.inspector.stale}</p>}
			<p className="of-panel-status" data-status={model.status}>
				{statusText(t, model)}
			</p>
			{model.mode === "life" && <p className="of-note">{t.inspector.simulated}</p>}
			<dl className="of-panel-rows">
				{work !== null && (
					<Row label={t.inspector.doingNow}>
						{work.tool === "" ? t.inspector.groups[work.group] : work.tool}
						{work.subject !== "" && <span className="of-panel-mono"> · {work.subject}</span>}
						<span className="of-panel-muted">
							{" "}
							· {t.rooms[work.room]}
							{work.runningMs > 0 ? ` · ${t.inspector.runningFor(t.inspector.duration(work.runningMs))}` : ""}
						</span>
					</Row>
				)}
				{model.service !== null && (
					<Row label={t.inspector.service}>
						{t.service.names[model.service.kind]}
						{model.service.port !== null && <span className="of-panel-muted"> · {t.service.port(model.service.port)}</span>}
						<span className="of-panel-muted"> · {t.service.uptime(Math.floor(model.service.uptimeMs / 60_000))}</span>
					</Row>
				)}
				{model.description !== "" && <Row label={t.inspector.description}>{model.description}</Row>}
				{model.lastResult !== null && (
					<Row label={t.inspector.lastResult}>
						{model.lastResult.ok ? t.inspector.passed : t.inspector.failed}
						<span className="of-panel-muted"> · {t.inspector.ago(t.inspector.duration(model.lastResult.agoMs))}</span>
					</Row>
				)}
				<Row label={t.inspector.done}>{model.done}</Row>
				{model.approvalWaitMs !== null && <Row label={t.inspector.approvalWait}>{t.inspector.duration(model.approvalWaitMs)}</Row>}
			</dl>
			<section className="of-panel-timeline" aria-label={t.inspector.timeline}>
				<h4>{t.inspector.timeline}</h4>
				{model.timeline.length === 0 ? (
					<p className="of-note">{t.inspector.timelineEmpty}</p>
				) : (
					<>
						<ul className="of-panel-entries">
							{model.timeline.map((e, i) => (
								<Entry key={`${e.agoMs}-${i}`} entry={e} t={t} />
							))}
						</ul>
						<p className="of-note">{t.inspector.timelineNote}</p>
					</>
				)}
			</section>
		</aside>
	);
}

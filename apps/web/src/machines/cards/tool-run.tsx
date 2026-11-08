// Tool calls in the transcript. One call is one row; two or more in a row
// fold under "Đã chạy 3 tool" (or "Đang chạy Bash" while one runs), opened
// to see each call. A row shows the call's command wrapped and clamped to
// three lines ("Xem thêm" shows the rest), the answered permission prompt
// as a short status under it, and its output behind "Kết quả".
import { useLayoutEffect, useRef, useState } from "react";
import type { Item } from "@achoo254/chat-proto/remote/remote";
import { MachineIcon } from "../machine-icons.tsx";
import type { ToolRun } from "../transcript/tool-fold.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { approvalOutcome, toolIcon } from "./approval.tsx";

interface ToolRunCardProps {
	runs: readonly ToolRun[];
	/** Items fetched in full, by id (long outputs). */
	full: ReadonlyMap<string, Item>;
	onFetchFull: (itemId: string) => Promise<void>;
	/** The turn is still going: a call without a result is running. */
	live: boolean;
}

export function ToolRunCard({ runs, full, onFetchFull, live }: ToolRunCardProps) {
	const t = useMachinesCopy();
	const running = live ? runs.find((r) => r.call !== null && r.result === null) : undefined;
	const rows = runs.map((run) => (
		<RunRow
			key={run.id}
			run={run}
			running={run === running}
			full={run.resultId === null ? null : (full.get(run.resultId) ?? null)}
			onFetchFull={onFetchFull}
		/>
	));
	if (runs.length === 1) {
		return (
			<div className="mx-tools single">
				<ul>{rows}</ul>
			</div>
		);
	}
	const icons = runs.slice(0, 4).map((r) => (r.call === null ? "cpu" : toolIcon(r.call.kind)));
	return (
		<details className="mx-tools">
			<summary>
				<span className="icons">
					{icons.map((icon, i) => (
						<MachineIcon key={i} name={icon} small />
					))}
				</span>
				<span>{running?.call ? t.transcript.runningTool(running.call.name) : t.transcript.ranTools(runs.length)}</span>
				{running !== undefined && <span className="spin" aria-hidden="true" />}
			</summary>
			<ul>{rows}</ul>
		</details>
	);
}

interface RunRowProps {
	run: ToolRun;
	running: boolean;
	full: Item | null;
	onFetchFull: (itemId: string) => Promise<void>;
}

function RunRow({ run, running, full, onFetchFull }: RunRowProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [clamped, setClamped] = useState(false);
	const command = useRef<HTMLSpanElement>(null);
	const name = run.call?.name ?? t.transcript.subagent;
	const summary = run.call?.summary || run.subagent?.description || "";
	const result = full?.body.case === "toolResult" ? full.body.value : run.result;
	const resultId = run.resultId;
	// "Xem thêm" only when the clamped command really hides lines.
	useLayoutEffect(() => {
		const el = command.current;
		if (el === null || expanded) return;
		const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
		check();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [summary, expanded]);
	const output = result !== null && (result.output !== "" || result.truncated) ? result : null;
	const showToggle = clamped || expanded;
	return (
		<li className="mx-run">
			<MachineIcon name={run.call === null ? "cpu" : toolIcon(run.call.kind)} small />
			<div className="mx-run-body">
				<span ref={command} className={expanded ? "mx-run-cmd" : "mx-run-cmd clamp"}>
					<b className="name">{name}</b>
					{summary !== "" && <span className="mono"> {summary}</span>}
				</span>
				{(showToggle || run.approval !== null || run.call?.sensitive === true || output !== null) && (
					<div className="mx-run-sub">
						{showToggle && (
							<button type="button" className="mx-link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
								{expanded ? t.transcript.less : t.transcript.more}
							</button>
						)}
						{run.approval !== null && <span className="mx-run-approval">{approvalOutcome(t, run.approval)}</span>}
						{run.call?.sensitive === true && <span className="mx-tag danger">{t.approval.sensitive}</span>}
						{output !== null && (
							<details className="mx-run-out">
								<summary>
									<MachineIcon name="chevron-right" small />
									{t.transcript.output}
								</summary>
								{output.output !== "" && <pre className="mx-pre">{output.output}</pre>}
								{output.truncated && resultId !== null && (
									<button
										type="button"
										className="btn btn-sm"
										disabled={busy}
										onClick={() => {
											setBusy(true);
											onFetchFull(resultId)
												.catch(() => undefined)
												.finally(() => setBusy(false));
										}}
									>
										{busy ? t.transcript.loadingFull : t.transcript.showFull}
									</button>
								)}
							</details>
						)}
					</div>
				)}
			</div>
			<span className="mx-run-state">
				{running ? (
					<span className="spin" aria-label={t.transcript.runningTool(name)} role="img" />
				) : result === null ? null : result.ok ? (
					<span className="ok" role="img" aria-label={t.transcript.ok}>
						✓
					</span>
				) : (
					<span className="fail">{t.transcript.failed}</span>
				)}
			</span>
		</li>
	);
}

// Consecutive tool calls folded into one row ("Đã chạy 3 tool", or "Đang
// chạy Bash" while one runs), opened to see each call and its output.
import { useState } from "react";
import type { Item } from "@achoo254/chat-proto/remote/remote";
import { MachineIcon } from "../machine-icons.tsx";
import type { ToolRun } from "../transcript/tool-fold.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { toolIcon } from "./approval.tsx";

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
	const icons = runs.slice(0, 4).map((r) => (r.call === null ? "cpu" : toolIcon(r.call.kind)));
	return (
		<details className="mx-tools" open={running !== undefined && runs.length === 1}>
			<summary>
				<span className="icons">
					{icons.map((icon, i) => (
						<MachineIcon key={i} name={icon} small />
					))}
				</span>
				<span>{running?.call ? t.transcript.runningTool(running.call.name) : t.transcript.ranTools(runs.length)}</span>
				{running !== undefined && <span className="spin" aria-hidden="true" />}
			</summary>
			<ul>
				{runs.map((run) => (
					<RunRow key={run.id} run={run} full={run.resultId === null ? null : (full.get(run.resultId) ?? null)} onFetchFull={onFetchFull} />
				))}
			</ul>
		</details>
	);
}

function RunRow({ run, full, onFetchFull }: { run: ToolRun; full: Item | null; onFetchFull: (itemId: string) => Promise<void> }) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const name = run.call?.name ?? t.transcript.subagent;
	const summary = run.call?.summary || run.subagent?.description || "";
	const result = full?.body.case === "toolResult" ? full.body.value : run.result;
	const resultId = run.resultId;
	return (
		<li>
			<details>
				<summary>
					<MachineIcon name={run.call === null ? "cpu" : toolIcon(run.call.kind)} small />
					<span className="name">{name}</span>
					<span className="mono">{summary}</span>
					{result !== null && (result.ok ? <span className="ok">✓</span> : <span className="fail">{t.transcript.failed}</span>)}
					{run.call?.sensitive === true && <span className="mx-tag danger">{t.approval.sensitive}</span>}
				</summary>
				{result !== null && result.output !== "" && <pre className="mx-pre">{result.output}</pre>}
				{result?.truncated === true && resultId !== null && (
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
		</li>
	);
}

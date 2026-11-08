// A file change: the unified diff, at most 120 lines as sent; "Xem đủ" asks
// the machine for the whole item over the encrypted link.
import { useState } from "react";
import type { DiffItem } from "@achoo254/chat-proto/remote/remote";
import { MachineIcon } from "../machine-icons.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";

interface DiffCardProps {
	diff: DiffItem;
	/** The same item fetched in full, once asked for. */
	full: DiffItem | null;
	onFetchFull: () => Promise<void>;
}

function lineClass(line: string): string | undefined {
	if (line.startsWith("+++") || line.startsWith("---")) return "h";
	if (line.startsWith("@@")) return "h";
	if (line.startsWith("+")) return "a";
	if (line.startsWith("-")) return "d";
	return undefined;
}

export function DiffCard({ diff, full, onFetchFull }: DiffCardProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const shown = full ?? diff;
	const lines = shown.unified.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const fetchFull = () => {
		setBusy(true);
		setFailed(false);
		onFetchFull().then(
			() => setBusy(false),
			() => {
				setBusy(false);
				setFailed(true);
			},
		);
	};
	return (
		<div className="mx-diff">
			<div className="mx-diff-head">
				<MachineIcon name="pencil" small />
				<span className="path">{diff.path}</span>
				<span className="add">+{diff.added}</span>
				<span className="del">−{diff.removed}</span>
			</div>
			<pre>
				{lines.map((line, i) => (
					<span key={i} className={lineClass(line)}>
						{line}
					</span>
				))}
			</pre>
			<div className="mx-diff-foot">
				<span>{t.transcript.lines(lines.length)}</span>
				{shown.truncated && (
					<button type="button" className="btn btn-sm" disabled={busy} onClick={fetchFull}>
						{busy ? t.transcript.loadingFull : t.transcript.showFull}
					</button>
				)}
				{failed && <span className="mx-error">{t.errors.offline}</span>}
			</div>
		</div>
	);
}

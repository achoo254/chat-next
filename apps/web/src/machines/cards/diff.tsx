// A file change: the unified diff with old and new line numbers, lines kept
// whole (the block scrolls sideways) and lightly highlighted by the file's
// language, a copy button, and "Xem đủ" when the machine sent at most 120
// lines: it asks for the whole item over the encrypted link.
import { useState } from "react";
import type { DiffItem } from "@achoo254/chat-proto/remote/remote";
import { CopyButton } from "../../messaging/ui/parts.tsx";
import { MachineIcon } from "../machine-icons.tsx";
import { CodeText } from "../rich/code-text.tsx";
import { languageOfPath } from "../rich/highlight.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

export interface DiffLine {
	readonly kind: "add" | "del" | "ctx" | "hunk" | "meta";
	readonly text: string;
	/** Line numbers before and after; null where the line does not exist. */
	readonly old: number | null;
	readonly new: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The unified diff's lines with their numbers, counted from each hunk header. */
export function diffLines(unified: string): DiffLine[] {
	const lines = unified.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let oldNo = 0;
	let newNo = 0;
	return lines.map((text): DiffLine => {
		const hunk = HUNK.exec(text);
		if (hunk !== null) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			return { kind: "hunk", text, old: null, new: null };
		}
		if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("\\")) return { kind: "meta", text, old: null, new: null };
		if (text.startsWith("+")) return { kind: "add", text, old: null, new: newNo++ };
		if (text.startsWith("-")) return { kind: "del", text, old: oldNo++, new: null };
		return { kind: "ctx", text, old: oldNo++, new: newNo++ };
	});
}

interface DiffCardProps {
	diff: DiffItem;
	/** The same item fetched in full, once asked for. */
	full: DiffItem | null;
	onFetchFull: () => Promise<void>;
	/** Inside the changes panel: no file header (the panel shows it). */
	bare?: boolean;
}

export function DiffCard({ diff, full, onFetchFull, bare = false }: DiffCardProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const shown = full ?? diff;
	const lines = diffLines(shown.unified);
	const family = languageOfPath(diff.path);
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
			{!bare && (
				<div className="mx-diff-head">
					<MachineIcon name="pencil" small />
					<span className="path">{diff.path}</span>
					<span className="add">+{diff.added}</span>
					<span className="del">−{diff.removed}</span>
					<CopyButton text={shown.unified} label={t.agent.diff.copy} copiedLabel={t.agent.diff.copied} small />
				</div>
			)}
			<div className="mx-diff-body" data-scroll-x="">
				<table>
					<tbody>
						{lines.map((line, i) => (
							<tr key={i} className={line.kind}>
								<td className="no" aria-hidden="true">
									{line.old ?? ""}
								</td>
								<td className="no" aria-hidden="true">
									{line.new ?? ""}
								</td>
								<td className="code">
									{line.kind === "add" || line.kind === "del" || line.kind === "ctx" ? (
										<>
											<span className="sign">{line.text.charAt(0) === " " ? " " : line.text.charAt(0)}</span>
											<CodeText code={line.text.slice(1)} family={family} />
										</>
									) : (
										line.text
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="mx-diff-foot">
				<span>
					{t.agent.diff.shown(lines.length, lines.length)}
					{shown.truncated && ` · ${t.agent.diff.cut}`}
				</span>
				{bare && <CopyButton text={shown.unified} label={t.agent.diff.copy} copiedLabel={t.agent.diff.copied} small />}
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

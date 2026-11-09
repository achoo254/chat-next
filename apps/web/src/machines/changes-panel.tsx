// "Thay đổi": the files the AI changed in this session (transcript/changes.ts)
// and, for one file, each of its diffs. A panel beside the chat on wide
// screens, a sheet from the bottom on phones; Esc or "Đóng" closes it.
import { useEffect, useState } from "react";
import type { Item } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { DiffCard } from "./cards/diff.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import type { FileChange } from "./transcript/changes.ts";
import { folderName } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface ChangesPanelProps {
	changes: readonly FileChange[];
	/** Items fetched in full, by id. */
	full: ReadonlyMap<string, Item>;
	onFetchFull: (itemId: string) => Promise<void>;
	onClose: () => void;
}

export function ChangesPanel({ changes, full, onFetchFull, onClose }: ChangesPanelProps) {
	const t = useMachinesCopy();
	const [path, setPath] = useState<string | null>(null);
	const file = changes.find((c) => c.path === path) ?? null;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
			<button type="button" className="mx-changes-backdrop" aria-label={t.agent.changes.close} tabIndex={-1} onClick={onClose} />
			<aside className="mx-changes" aria-label={t.agent.changes.title}>
				<header className="mx-changes-head">
					{file !== null && (
						<button type="button" className="icon-btn" aria-label={t.agent.changes.back} onClick={() => setPath(null)}>
							<Icon name="back" />
						</button>
					)}
					<div className="title">
						<strong>{file === null ? t.agent.changes.title : folderName(file.path)}</strong>
						<span>{file === null ? t.agent.changes.count(changes.length) : file.path}</span>
					</div>
					<button type="button" className="icon-btn" aria-label={t.agent.changes.close} onClick={onClose}>
						<Icon name="x" />
					</button>
				</header>
				<div className="mx-changes-body">
					{changes.length === 0 && <p className="muted">{t.agent.changes.empty}</p>}
					{file === null ? (
						<>
							<ul className="mx-files">
								{changes.map((change) => (
									<li key={change.path}>
										<button type="button" className="mx-file" onClick={() => setPath(change.path)}>
											<MachineIcon name="pencil" small />
											<span className="tx">
												<b>{folderName(change.path)}</b>
												<small>{change.path}</small>
											</span>
											<span className="nums">
												<span className="add">+{change.added}</span> <span className="del">−{change.removed}</span>
												<small>{t.agent.changes.edits(change.edits.length)}</small>
											</span>
										</button>
									</li>
								))}
							</ul>
							{changes.length > 0 && <p className="note">{t.agent.changes.note}</p>}
						</>
					) : (
						file.edits.map((edit) => {
							const fetched = full.get(edit.id);
							return (
								<DiffCard
									key={edit.id}
									bare
									diff={edit.diff}
									full={fetched?.body.case === "diff" ? fetched.body.value : null}
									onFetchFull={() => onFetchFull(edit.id)}
								/>
							);
						})
					)}
				</div>
			</aside>
		</>
	);
}

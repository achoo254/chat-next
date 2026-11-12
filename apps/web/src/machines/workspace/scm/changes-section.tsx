// "CHANGES n": conflicts, staged and not staged files, each grouped by
// folder, with the lines added and removed, git's letter, a lock on secret
// files, and per-file stage, unstage and discard. The first files show;
// "View all" shows the rest. A file opens its diff (never a secret one's).
import { useState } from "react";
import type { WsGitEntry } from "@achoo254/chat-proto/remote/remote";
import { baseName } from "../explorer/tree-model.ts";
import { FileIcon } from "../explorer/file-icon.tsx";
import { gitMark } from "../git-marks.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import { Section } from "./section.tsx";
import { areaOf, groupStatus, limitGroups, type AreaKey } from "./status-model.ts";

/** Files shown before "View all". */
export const FIRST_FILES = 50;

interface ChangesSectionProps {
	entries: readonly WsGitEntry[];
	truncated: boolean;
	disabled: boolean;
	selected: string | null;
	onOpen: (entry: WsGitEntry) => void;
	onStage: (path: string) => void;
	onUnstage: (path: string) => void;
	onDiscard: (path: string) => void;
}

export function ChangesSection({ entries, truncated, disabled, selected, onOpen, onStage, onUnstage, onDiscard }: ChangesSectionProps) {
	const p = usePanelCopy();
	const s = p.scm;
	const [all, setAll] = useState(false);
	const groups = groupStatus(entries);
	const shown = all ? groups : limitGroups(groups, FIRST_FILES);
	const areaTitle: Record<AreaKey, string> = { conflicted: s.conflicted, staged: s.staged, unstaged: s.unstaged };
	return (
		<Section id="changes" title={s.changes} count={entries.length}>
			{truncated && (
				<p className="mx-warn ws-banner" role="status">
					{s.truncated}
				</p>
			)}
			{entries.length === 0 ? (
				<p className="ws-msg muted">{s.noChanges}</p>
			) : (
				shown.map((group) => (
					<div key={group.area} className="ws-area">
						<h4 className="ws-area-title">
							{areaTitle[group.area]} <span className="ws-count">{group.count}</span>
						</h4>
						{group.folders.map((folder) => (
							<div key={folder.folder} className="ws-folder">
								{folder.folder !== "" && (
									<p className="ws-folder-name" title={folder.folder}>
										{folder.folder}
									</p>
								)}
								<ul className="ws-list">
									{folder.entries.map((entry) => (
										<ChangeRow
											key={`${group.area}:${entry.path}`}
											entry={entry}
											disabled={disabled}
											selected={selected === `${group.area}:${entry.path}`}
											onOpen={onOpen}
											onStage={onStage}
											onUnstage={onUnstage}
											onDiscard={onDiscard}
										/>
									))}
								</ul>
							</div>
						))}
					</div>
				))
			)}
			{entries.length > FIRST_FILES && (
				<button type="button" className="btn btn-sm ws-viewall" onClick={() => setAll((v) => !v)} aria-expanded={all}>
					{all ? s.showLess : s.viewAll(entries.length)}
				</button>
			)}
		</Section>
	);
}

function ChangeRow({ entry, disabled, selected, onOpen, onStage, onUnstage, onDiscard }: Omit<ChangesSectionProps, "entries" | "truncated" | "selected"> & { entry: WsGitEntry; selected: boolean }) {
	const p = usePanelCopy();
	const s = p.scm;
	const area = areaOf(entry);
	const mark = gitMark(entry.state, p.explorer.git);
	const name = baseName(entry.path);
	return (
		<li className={selected ? "ws-change selected" : "ws-change"}>
			<button type="button" className={`ws-hit ${mark === null ? "" : `ws-git-${mark.tone}`}`} onClick={() => onOpen(entry)} title={entry.oldPath === "" ? entry.path : `${entry.oldPath} → ${entry.path}`}>
				<FileIcon name={name} />
				<span className="ws-name">{name}</span>
				{entry.sensitive && (
					<span className="ws-lock" title={s.sensitive}>
						<PanelIcon name="lock" small />
						<span className="sr-only">{s.sensitive}</span>
					</span>
				)}
				{!entry.binary && !entry.sensitive && (entry.added > 0 || entry.removed > 0) && (
					<span className="ws-lines">
						<span className="add">+{entry.added}</span>
						<span className="del">−{entry.removed}</span>
					</span>
				)}
				{mark !== null && (
					<span className="ws-mark" title={mark.label}>
						<span aria-hidden="true">{mark.letter}</span>
						<span className="sr-only">{mark.label}</span>
					</span>
				)}
			</button>
			<span className="ws-change-acts">
				{area === "staged" ? (
					<button type="button" className="icon-btn ws-act" aria-label={s.unstage(entry.path)} title={s.unstage(entry.path)} disabled={disabled} onClick={() => onUnstage(entry.path)}>
						<PanelIcon name="minus" small />
					</button>
				) : (
					<>
						{area === "unstaged" && (
							<button type="button" className="icon-btn ws-act" aria-label={s.discard(entry.path)} title={s.discard(entry.path)} disabled={disabled} onClick={() => onDiscard(entry.path)}>
								<PanelIcon name="undo" small />
							</button>
						)}
						<button type="button" className="icon-btn ws-act" aria-label={s.stage(entry.path)} title={s.stage(entry.path)} disabled={disabled} onClick={() => onStage(entry.path)}>
							<PanelIcon name="plus" small />
						</button>
					</>
				)}
			</span>
		</li>
	);
}

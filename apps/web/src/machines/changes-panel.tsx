// "Thay đổi": what changed in the session's folder. From tunelo 2.0.11 two
// parts: "Chưa commit trong thư mục" (git's view of the folder, edits by
// shell commands or outside the AI included) and "<AI> đã sửa" (each edit
// the AI made with its file tools, subagents included: transcript/changes.ts).
// Older machines only have the second part; where Source Control (the
// workspace panel) lists the folder's uncommitted files, only the second
// part shows here. A file opens its diffs. A panel
// beside the chat on wide screens, a sheet from the bottom on phones; Esc or
// "Đóng" closes it.
import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { DiffItemSchema, GitFileState, type DiffItem, type GitChanges, type GitFileChange, type Item } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { DiffCard } from "./cards/diff.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { MachineIcon } from "./machine-icons.tsx";
import type { FileChange } from "./transcript/changes.ts";
import { folderName } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface ChangesPanelProps {
	ai: string;
	/** The AI's own edits, by file. */
	changes: readonly FileChange[];
	/** The machine lists the folder's git changes (tunelo 2.0.11+). */
	gitSupported: boolean;
	/** The folder's git changes as last sent; null until they arrive. */
	git: GitChanges | null;
	/** The folder's uncommitted files show in Source Control (the workspace panel): only the AI's edits are listed here. */
	gitElsewhere: boolean;
	/** Items fetched in full, by id. */
	full: ReadonlyMap<string, Item>;
	onFetchFull: (itemId: string) => Promise<void>;
	/** One file of the git changes with its whole diff; null when git no longer lists it. */
	onGitFileDiff: (path: string) => Promise<GitFileChange | null>;
	onClose: () => void;
}

type Open = { readonly from: "git" | "history"; readonly path: string };

/** The number on the "Thay đổi" button: git's files when the machine lists them, else the AI's. */
export function changesCount(changes: readonly FileChange[], git: GitChanges | null | undefined): number {
	return git?.git === true ? git.files.length : changes.length;
}

function stateLabel(t: MachinesCopy, state: GitFileState): string {
	const s = t.agent.changes.state;
	switch (state) {
		case GitFileState.ADDED:
			return s.added;
		case GitFileState.DELETED:
			return s.deleted;
		case GitFileState.UNTRACKED:
			return s.untracked;
		case GitFileState.TYPE_CHANGED:
			return s.typeChanged;
		case GitFileState.CONFLICTED:
			return s.conflicted;
		default:
			return s.modified;
	}
}

/** A git file's diff in the shape the diff card draws. */
export function asDiff(file: GitFileChange): DiffItem {
	return create(DiffItemSchema, { path: file.path, unified: file.unified, added: file.added, removed: file.removed, truncated: file.truncated });
}

export function ChangesPanel({ ai, changes, gitSupported, git, gitElsewhere, full, onFetchFull, onGitFileDiff, onClose }: ChangesPanelProps) {
	const t = useMachinesCopy();
	const [open, setOpen] = useState<Open | null>(null);
	/** Git files fetched whole, by path; null: git no longer lists it. */
	const [gitFull, setGitFull] = useState<ReadonlyMap<string, GitFileChange | null>>(new Map());
	const history = open?.from === "history" ? (changes.find((c) => c.path === open.path) ?? null) : null;
	const gitFile = open?.from === "git" ? (git?.files.find((f) => f.path === open.path) ?? null) : null;
	const shown = history ?? gitFile;
	const inGit = gitSupported && !gitElsewhere && git?.git === true;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const fetchGitFile = async (path: string) => {
		const file = await onGitFileDiff(path);
		setGitFull((m) => new Map(m).set(path, file));
	};
	return (
		<>
			<button type="button" className="mx-changes-backdrop" aria-label={t.agent.changes.close} tabIndex={-1} onClick={onClose} />
			<aside className="mx-changes" aria-label={t.agent.changes.title}>
				<header className="mx-changes-head">
					{shown !== null && (
						<button type="button" className="icon-btn" aria-label={t.agent.changes.back} onClick={() => setOpen(null)}>
							<Icon name="back" />
						</button>
					)}
					<div className="title">
						<strong>{shown === null ? t.agent.changes.title : folderName(shown.path)}</strong>
						<span>{shown === null ? t.agent.changes.count(changesCount(changes, inGit ? git : null)) : shown.path}</span>
					</div>
					<button type="button" className="icon-btn" aria-label={t.agent.changes.close} onClick={onClose}>
						<Icon name="x" />
					</button>
				</header>
				<div className="mx-changes-body">
					{history !== null ? (
						history.edits.map((edit) => {
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
					) : gitFile !== null ? (
						<GitFileView file={gitFile} whole={gitFull.get(gitFile.path)} onFetch={() => fetchGitFile(gitFile.path)} />
					) : (
						<>
							{gitSupported && !gitElsewhere && <GitSection ai={ai} git={git} onOpen={(path) => setOpen({ from: "git", path })} />}
							<section className="mx-changes-sec" aria-label={gitSupported ? t.agent.changes.historyTitle(ai) : t.agent.changes.title}>
								{gitSupported && <h3>{t.agent.changes.historyTitle(ai)}</h3>}
								{changes.length === 0 ? (
									<p className="muted">{gitSupported ? t.agent.changes.historyEmpty(ai) : t.agent.changes.empty(ai)}</p>
								) : (
									<>
										<ul className="mx-files">
											{changes.map((change) => (
												<li key={change.path}>
													<button type="button" className="mx-file" onClick={() => setOpen({ from: "history", path: change.path })}>
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
										<p className="note">{t.agent.changes.note(ai)}</p>
									</>
								)}
							</section>
						</>
					)}
				</div>
			</aside>
		</>
	);
}

function GitSection({ ai, git, onOpen }: { ai: string; git: GitChanges | null; onOpen: (path: string) => void }) {
	const t = useMachinesCopy();
	const c = t.agent.changes;
	if (git === null) {
		return (
			<section className="mx-changes-sec" aria-label={c.gitTitle} aria-busy="true">
				<h3>{c.gitTitle}</h3>
				<p className="muted">{c.gitLoading}</p>
			</section>
		);
	}
	if (!git.git) return <p className="note">{c.noGit}</p>;
	return (
		<section className="mx-changes-sec" aria-label={c.gitTitle}>
			<h3>{c.gitTitle}</h3>
			{git.files.length === 0 ? (
				<p className="muted">{git.partial ? c.gitPartial : c.gitEmpty}</p>
			) : (
				<>
					<ul className="mx-files">
						{git.files.map((file) => (
							<li key={file.path}>
								<button type="button" className="mx-file" onClick={() => onOpen(file.path)}>
									<MachineIcon name="pencil" small />
									<span className="tx">
										<b>{folderName(file.path)}</b>
										<small>{file.path}</small>
									</span>
									<span className="nums">
										{file.binary || file.sensitive ? (
											<span className="muted">—</span>
										) : (
											<span>
												<span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
											</span>
										)}
										<small className={file.state === GitFileState.CONFLICTED ? "mx-tag warn" : "mx-tag"}>{stateLabel(t, file.state)}</small>
									</span>
								</button>
							</li>
						))}
					</ul>
					{git.truncated && <p className="note">{c.gitTruncated(git.files.length)}</p>}
					{git.partial && <p className="note">{c.gitPartial}</p>}
				</>
			)}
			<p className="note">{c.gitNote(ai)}</p>
		</section>
	);
}

/** One git file: its diff (shortened until "Xem đủ"), or why there is none. */
function GitFileView({ file, whole, onFetch }: { file: GitFileChange; whole: GitFileChange | null | undefined; onFetch: () => Promise<void> }) {
	const t = useMachinesCopy();
	const c = t.agent.changes;
	if (whole === null) return <p className="muted">{c.gone}</p>;
	if (file.sensitive) return <p className="muted">{c.sensitive}</p>;
	if (file.binary) return <p className="muted">{c.binary}</p>;
	// A diff git did not give in time is fetched like a shortened one.
	const listed = asDiff(file);
	if (file.unified === "") listed.truncated = true;
	return <DiffCard bare diff={listed} full={whole === undefined ? null : asDiff(whole)} onFetchFull={onFetch} />;
}

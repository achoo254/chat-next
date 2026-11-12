// "COMMITTED ON BRANCH n": the files the branch changed since it left its
// base (found on the machine: origin/HEAD, else main or master), each
// opening its diff against that base. "COMMITS": the branch's commits,
// newest first, 50 a page, with author, time and the refs on them.
import { useState } from "react";
import type { WsGitBranchCompareResult, WsGitEntry } from "@achoo254/chat-proto/remote/remote";
import { baseName, parentOf } from "../explorer/tree-model.ts";
import { FileIcon } from "../explorer/file-icon.tsx";
import { gitMark } from "../git-marks.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import { timeAgo } from "../viewer/format.ts";
import { Section } from "./section.tsx";
import type { Loadable, Log } from "./use-history.ts";

export function CompareSection({ compare, selected, onOpen, errorText }: { compare: Loadable<WsGitBranchCompareResult>; selected: string | null; onOpen: (entry: WsGitEntry, base: string) => void; errorText: (err: unknown) => string }) {
	const p = usePanelCopy();
	const s = p.scm;
	const ready = compare.kind === "ready" ? compare.value : null;
	const files = ready?.files ?? [];
	const sub = ready !== null && ready.base !== "" ? s.compareBase(ready.base, ready.ahead) : "";
	return (
		<Section id="branch" title={s.committedOnBranch} count={ready === null ? undefined : files.length} sub={sub} initiallyOpen={files.length <= 30}>
			{compare.kind === "loading" && <p className="ws-msg muted">{p.loading}</p>}
			{compare.kind === "error" && <p className="ws-msg mx-error">{errorText(compare.error)}</p>}
			{ready !== null && ready.base === "" && <p className="ws-msg muted">{s.noBase}</p>}
			{files.length > 0 && (
				<ul className="ws-list">
					{files.map((entry) => {
						const mark = gitMark(entry.state, p.explorer.git);
						return (
							<li key={entry.path} className={selected === `branch:${entry.path}` ? "ws-change selected" : "ws-change"}>
								<button type="button" className={`ws-hit ${mark === null ? "" : `ws-git-${mark.tone}`}`} onClick={() => onOpen(entry, ready?.base ?? "")} title={entry.path}>
									<FileIcon name={baseName(entry.path)} />
									<span className="ws-name">{baseName(entry.path)}</span>
									<span className="ws-dir">{parentOf(entry.path)}</span>
									{entry.sensitive && (
										<span className="ws-lock" title={s.sensitive}>
											<PanelIcon name="lock" small />
											<span className="sr-only">{s.sensitive}</span>
										</span>
									)}
									{!entry.binary && !entry.sensitive && (
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
							</li>
						);
					})}
				</ul>
			)}
			{ready?.truncated === true && <p className="ws-msg note">{s.compareTruncated}</p>}
		</Section>
	);
}

export function CommitsSection({ log, onMore, errorText }: { log: Log; onMore: () => void; errorText: (err: unknown) => string }) {
	const p = usePanelCopy();
	const s = p.scm;
	const [now] = useState(Date.now);
	return (
		<Section id="commits" title={s.commits} count={log.commits.length > 0 ? log.commits.length : undefined}>
			{log.commits.length === 0 && !log.loading && log.error === null && <p className="ws-msg muted">{s.noCommits}</p>}
			<ul className="ws-list ws-commits">
				{log.commits.map((c) => (
					<li key={c.oid} className="ws-commit-row" title={c.oid}>
						<PanelIcon name="commit" small />
						<span className="ws-commit-text">
							<span className="ws-commit-subject">{c.subject}</span>
							<span className="ws-commit-meta">
								{c.author} · {timeAgo(Number(c.at), now, p.time)} · <span className="mono">{c.oid.slice(0, 7)}</span>
							</span>
							{c.refs.length > 0 && (
								<span className="ws-refs">
									{c.refs.map((ref) => (
										<span key={ref} className="mx-tag">
											{ref}
										</span>
									))}
								</span>
							)}
						</span>
					</li>
				))}
			</ul>
			{log.loading && <p className="ws-msg muted">{p.loading}</p>}
			{log.error !== null && <p className="ws-msg mx-error">{errorText(log.error)}</p>}
			{log.hasMore && !log.loading && (
				<button type="button" className="btn btn-sm ws-viewall" onClick={onMore}>
					{s.loadMoreCommits}
				</button>
			)}
		</Section>
	);
}

// The Source Control tab: the branch rows, the commit box, a failed write's
// reason, then CHANGES, COMMITTED ON BRANCH and COMMITS, and the
// confirmations. Outside a git repository (or in a folder inside a larger
// one) it says so instead.
import { useState } from "react";
import { ErrorReason, WsGitArea, WsGitDiffSource, type WsGitEntry } from "@achoo254/chat-proto/remote/remote";
import { RemoteError } from "../../link/machine-link.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { DiffTarget } from "../viewer/diff-view.tsx";
import type { WsLink } from "../ws-client.ts";
import { BranchBar } from "./branch-bar.tsx";
import { ChangesSection } from "./changes-section.tsx";
import { CommitBox } from "./commit-box.tsx";
import { ConfirmDialog, NewBranchDialog } from "./confirm-dialog.tsx";
import { CommitsSection, CompareSection } from "./history-sections.tsx";
import { areaOf, discardableEntries, stagedEntries, unstagedEntries } from "./status-model.ts";
import { useHistory } from "./use-history.ts";
import type { Scm } from "./use-scm.ts";

interface SourceControlProps {
	link: WsLink;
	workspaceId: string;
	name: string;
	online: boolean;
	scm: Scm;
	/** The open diff's key ("staged:path", "branch:path"); null when none. */
	selected: string | null;
	onView: (target: DiffTarget, key: string) => void;
	errorText: (err: unknown) => string;
}

/** Errors that mean "no git here" rather than "try again". */
function notGit(err: unknown): boolean {
	return err instanceof RemoteError && (err.reason === ErrorReason.NOT_A_GIT_REPOSITORY || err.reason === ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT);
}

export function SourceControl({ link, workspaceId, name, online, scm, selected, onView, errorText }: SourceControlProps) {
	const p = usePanelCopy();
	const status = scm.status;
	const git = status?.git === true;
	const history = useHistory(link, workspaceId, online, git, status?.branch ?? "", scm.history);
	const [naming, setNaming] = useState(false);
	const open = (entry: WsGitEntry) => {
		const area = areaOf(entry);
		const source = entry.area === WsGitArea.STAGED ? WsGitDiffSource.STAGED : WsGitDiffSource.UNSTAGED;
		onView({ path: entry.path, oldPath: entry.oldPath, source, sensitive: entry.sensitive }, `${area}:${entry.path}`);
	};
	const head = (
		<header className="ws-view-head">
			<h2 className="ws-view-title" title={name}>
				{p.tabs.scm}
			</h2>
			<button type="button" className="icon-btn ws-act" aria-label={p.explorer.refresh} title={p.explorer.refresh} disabled={!online} onClick={scm.refresh}>
				<PanelIcon name="refresh" small />
			</button>
		</header>
	);
	if (status === null || !git) {
		const err = scm.statusError;
		const text = status !== null ? p.scm.notRepo : err === null ? p.loading : errorText(err);
		return (
			<section className="ws-view" aria-label={p.tabs.scm}>
				{head}
				<p className={err !== null && !notGit(err) ? "ws-msg mx-error" : "ws-msg muted"} role="status" aria-busy={status === null && err === null}>
					{text}
				</p>
			</section>
		);
	}
	const entries = status.entries;
	const disabled = !online || scm.busy !== null;
	return (
		<section className="ws-view" aria-label={p.tabs.scm}>
			{head}
			<div className="ws-scroll ws-scm">
				<BranchBar
					status={status}
					pr={history.pr}
					branches={history.branches}
					busy={scm.busy}
					online={online}
					onLoadBranches={history.loadBranches}
					onCheckout={scm.checkout}
					onNewBranch={() => setNaming(true)}
					onRemote={scm.remote}
					errorText={errorText}
				/>
				<CommitBox
					staged={stagedEntries(entries).length}
					unstaged={unstagedEntries(entries).length}
					discardable={discardableEntries(entries).length}
					busy={scm.busy}
					online={online}
					onCommit={scm.commit}
					onStageAll={() => scm.stage("all")}
					onUnstageAll={() => scm.unstage("all")}
					onDiscardAll={() => scm.discard(discardableEntries(entries).map((e) => e.path))}
				/>
				{scm.busy !== null && (
					<p className="ws-msg muted" role="status">
						{p.scm.busy}
					</p>
				)}
				{scm.failure !== null && !naming && (
					<div className="ws-failure" role="alert">
						<p>{errorText(scm.failure.error)}</p>
						<button type="button" className="icon-btn ws-act" aria-label={p.preview.close} onClick={scm.dismissFailure}>
							<PanelIcon name="x" small />
						</button>
					</div>
				)}
				<ChangesSection
					entries={entries}
					truncated={status.truncated}
					disabled={disabled}
					selected={selected}
					onOpen={open}
					onStage={(path) => scm.stage([path])}
					onUnstage={(path) => scm.unstage([path])}
					onDiscard={(path) => scm.discard([path])}
				/>
				<CompareSection
					compare={history.compare}
					selected={selected}
					onOpen={(entry, base) => onView({ path: entry.path, oldPath: entry.oldPath, source: WsGitDiffSource.BRANCH, base, sensitive: entry.sensitive }, `branch:${entry.path}`)}
					errorText={errorText}
				/>
				<CommitsSection log={history.log} onMore={history.loadMore} errorText={errorText} />
			</div>
			{scm.confirm !== null && <ConfirmDialog confirm={scm.confirm} onAccept={scm.accept} onCancel={scm.cancelConfirm} />}
			{naming && (
				<NewBranchDialog
					from={status.branch === "" ? status.head.slice(0, 7) : status.branch}
					onCreate={scm.createBranch}
					onClose={() => {
						setNaming(false);
						scm.dismissFailure();
					}}
					error={scm.failure?.op === "branch" ? errorText(scm.failure.error) : ""}
				/>
			)}
		</section>
	);
}

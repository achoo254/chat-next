// The Source Control tab: the branch rows, the commit box, a failed write's
// reason, then CHANGES, COMMITTED ON BRANCH and COMMITS, and the
// confirmations. Outside a git repository (or in a folder inside a larger
// one) it says so instead.
import { useRef, useState } from "react";
import { ErrorReason, WsGitArea, WsGitDiffSource, type WsGitEntry } from "@achoo254/chat-proto/remote/remote";
import { RemoteError } from "../../link/machine-link.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { DiffTarget } from "../viewer/diff-view.tsx";
import { ask, type WsLink } from "../ws-client.ts";
import { divergedCounts, rebaseConflictFiles } from "../ws-errors.ts";
import { BranchBar } from "./branch-bar.tsx";
import { ChangesSection } from "./changes-section.tsx";
import { CommitBox } from "./commit-box.tsx";
import { ConfirmDialog, NewBranchDialog } from "./confirm-dialog.tsx";
import { CommitsSection, CompareSection } from "./history-sections.tsx";
import { areaOf, discardableEntries, stagedEntries, unstagedEntries } from "./status-model.ts";
import { useHistory } from "./use-history.ts";
import type { Scm } from "./use-scm.ts";
import { useAdvisorScope } from "../../../advisor/advisor-context.tsx";

/**
 * The latest failed write, kept after its box is dismissed: a copy of its
 * text tells Advisor which failure it was. The machine keeps git's output
 * of a failure_id for 10 minutes and ignores an older one.
 */
interface LastFailure {
	readonly action: string;
	readonly errorCode: string;
	readonly failureId: string;
}

function lastFailureOf(failure: Scm["failure"]): LastFailure | null {
	if (failure === null) return null;
	const err = failure.error;
	const remote = err instanceof RemoteError ? err : null;
	return {
		action: failure.op,
		errorCode: remote === null || remote.reason === ErrorReason.UNSPECIFIED ? "" : (ErrorReason[remote.reason] ?? ""),
		failureId: remote?.failureId ?? "",
	};
}

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
	/** The session's AI by name. */
	ai: string;
	/** The session's AI (its id) when it writes commit messages; undefined when it cannot. */
	writer: string | undefined;
}

/** The machine gives its AI up to 120 s to write a commit message; a little longer for the answer to arrive. */
const AI_WRITE_TIMEOUT_MS = 130_000;

/** Conflicted files listed in the failure box; the rest are counted. */
const CONFLICT_LINES = 10;

/** Errors that mean "no git here" rather than "try again". */
function notGit(err: unknown): boolean {
	return err instanceof RemoteError && (err.reason === ErrorReason.NOT_A_GIT_REPOSITORY || err.reason === ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT);
}

export function SourceControl({ link, workspaceId, name, online, scm, selected, onView, errorText, ai, writer }: SourceControlProps) {
	const p = usePanelCopy();
	const status = scm.status;
	const git = status?.git === true;
	const history = useHistory(link, workspaceId, online, git, status?.branch ?? "", scm.history);
	const [naming, setNaming] = useState(false);
	// Copies in Source Control carry the panel, the branch and the latest failure (until the next write).
	const [shownFailure, setShownFailure] = useState<Scm["failure"]>(null);
	const [lastFailure, setLastFailure] = useState<LastFailure | null>(null);
	if (scm.failure !== shownFailure) {
		setShownFailure(scm.failure);
		if (scm.failure !== null) setLastFailure(lastFailureOf(scm.failure));
	}
	// The next write starting ends it: once it succeeds, copies no longer name the old failure.
	const [shownBusy, setShownBusy] = useState<Scm["busy"]>(null);
	if (scm.busy !== shownBusy) {
		setShownBusy(scm.busy);
		if (scm.busy !== null && scm.failure === null) setLastFailure(null);
	}
	const section = useRef<HTMLElement>(null);
	useAdvisorScope(section, {
		screen: "scm",
		panel: "scm",
		branch: status?.branch ?? "",
		action: lastFailure?.action ?? "",
		errorCode: lastFailure?.errorCode ?? "",
		failureId: lastFailure?.failureId ?? "",
	});
	const writeMessage =
		writer === undefined
			? undefined
			: () => ask(link, { case: "wsGitCommitMessage", value: { workspaceId, provider: writer, model: "" } }, "wsGitCommitMessageResult", AI_WRITE_TIMEOUT_MS).then((r) => r.message);
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
			<section ref={section} className="ws-view" aria-label={p.tabs.scm}>
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
		<section ref={section} className="ws-view" aria-label={p.tabs.scm}>
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
					ai={ai}
					onWriteMessage={writeMessage}
					errorText={errorText}
				/>
				{scm.busy !== null && (
					<p className="ws-msg muted" role="status">
						{scm.busy === "rebase" || scm.busy === "rebase-push" ? p.scm.rebasing : p.scm.busy}
					</p>
				)}
				{scm.failure !== null && !naming && <FailureBox failure={scm.failure} disabled={disabled} onRebase={scm.rebase} onDismiss={scm.dismissFailure} errorText={errorText} />}
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

interface FailureBoxProps {
	failure: NonNullable<Scm["failure"]>;
	disabled: boolean;
	onRebase: (push: boolean) => void;
	onDismiss: () => void;
	errorText: (err: unknown) => string;
}

/**
 * A failed write's reason. Branches that diverged offer a rebase (then a
 * push when the push failed); a rebase stopped on a conflict lists the files.
 */
function FailureBox({ failure, disabled, onRebase, onDismiss, errorText }: FailureBoxProps) {
	const p = usePanelCopy();
	const diverged = divergedCounts(failure.error);
	const conflicts = rebaseConflictFiles(failure.error);
	// A push, or a rebase that was to push (someone pushed again meanwhile), offers the rebase then push.
	const push = failure.op === "push" || failure.op === "rebase-push";
	return (
		<div className="ws-failure" role="alert">
			<div className="ws-failure-body">
				<p>{conflicts !== null ? p.scm.rebaseConflict : errorText(failure.error)}</p>
				{conflicts !== null && (
					<>
						<ul className="ws-failure-files">
							{conflicts.files.slice(0, CONFLICT_LINES).map((file) => (
								<li key={file} title={file}>
									{file}
								</li>
							))}
							{conflicts.total > CONFLICT_LINES && <li>{p.scm.rebaseConflictMore(conflicts.total - Math.min(CONFLICT_LINES, conflicts.files.length))}</li>}
						</ul>
						<p className="muted">{p.scm.rebaseConflictHint}</p>
					</>
				)}
				{diverged !== null && (
					<>
						<button type="button" className="btn btn-sm btn-primary ws-rebase-btn" disabled={disabled} onClick={() => onRebase(push)} data-id="workspace-rebase">
							{push ? p.scm.rebasePush : p.scm.rebase}
						</button>
						<p className="muted">{p.scm.rebaseNote}</p>
					</>
				)}
			</div>
			<button type="button" className="icon-btn ws-act" aria-label={p.preview.close} onClick={onDismiss}>
				<PanelIcon name="x" small />
			</button>
		</div>
	);
}

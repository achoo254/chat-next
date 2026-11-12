// The commit message box (several lines; Cmd/Ctrl+Enter commits) with the
// AI message button (shown, off until the machine can write one), "Commit",
// the "Stage All" split button (its menu: unstage all, discard all) and the
// note that commits made here skip git hooks.
import { useState } from "react";
import { MachineIcon } from "../../machine-icons.tsx";
import { usePopover } from "../../use-popover.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { ScmOp } from "./use-scm.ts";

interface CommitBoxProps {
	staged: number;
	unstaged: number;
	discardable: number;
	busy: ScmOp | null;
	online: boolean;
	onCommit: (message: string, onDone: () => void) => void;
	onStageAll: () => void;
	onUnstageAll: () => void;
	onDiscardAll: () => void;
}

/** Cmd+Enter on Apple systems, Ctrl+Enter elsewhere. */
export function isCommitKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean): boolean {
	return event.key === "Enter" && !event.altKey && !event.shiftKey && (mac ? event.metaKey : event.ctrlKey);
}

const MAC = typeof navigator !== "undefined" && /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent);

export function CommitBox({ staged, unstaged, discardable, busy, online, onCommit, onStageAll, onUnstageAll, onDiscardAll }: CommitBoxProps) {
	const p = usePanelCopy();
	const s = p.scm;
	const [message, setMessage] = useState("");
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	const can = online && busy === null && staged > 0 && message.trim() !== "";
	const commit = () => {
		if (can) onCommit(message, () => setMessage(""));
	};
	return (
		<div className="ws-commit">
			<div className="ws-commit-field">
				<textarea
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					onKeyDown={(event) => {
						if (!isCommitKey(event, MAC)) return;
						event.preventDefault();
						commit();
					}}
					placeholder={MAC ? s.messagePlaceholderMac : s.messagePlaceholder}
					aria-label={s.message}
					rows={3}
					maxLength={65536}
					spellCheck
					data-id="workspace-commit-message"
				/>
				{/* The machine cannot write the message yet: shown off, its tooltip on a wrapper (a disabled button shows none). */}
				<span className="ws-ai" title={`${s.aiMessage} · ${s.comingSoon}`}>
					<button type="button" className="icon-btn" disabled aria-label={`${s.aiMessage} (${s.comingSoon})`}>
						<MachineIcon name="spark" small />
					</button>
				</span>
			</div>
			<div className="ws-commit-actions">
				<button type="button" className="btn btn-sm btn-primary ws-commit-btn" disabled={!can} aria-busy={busy === "commit"} onClick={commit} title={staged === 0 ? s.nothingStaged : undefined} data-id="workspace-commit">
					{busy === "commit" ? <MachineIcon name="spinner" small /> : <PanelIcon name="check" small />}
					{busy === "commit" ? s.committing : s.commit}
				</button>
				<div className="ws-split mx-model" ref={menuRef}>
					<button type="button" className="btn btn-sm" disabled={!online || busy !== null || unstaged === 0} onClick={onStageAll} data-id="workspace-stage-all">
						<PanelIcon name="plus" small />
						{s.stageAll}
					</button>
					<button type="button" className="btn btn-sm ws-split-more" aria-label={s.moreActions} title={s.moreActions} aria-haspopup="menu" aria-expanded={menuOpen} disabled={!online || busy !== null} onClick={() => setMenuOpen((v) => !v)}>
						<MachineIcon name="chevron-down" small />
					</button>
					{menuOpen && (
						<div className="mx-menu ws-menu" role="menu" aria-label={s.moreActions}>
							<button
								type="button"
								role="menuitem"
								disabled={staged === 0}
								onClick={() => {
									setMenuOpen(false);
									onUnstageAll();
								}}
							>
								<PanelIcon name="minus" small />
								{s.unstageAll}
							</button>
							<button
								type="button"
								role="menuitem"
								className="danger"
								disabled={discardable === 0}
								onClick={() => {
									setMenuOpen(false);
									onDiscardAll();
								}}
								data-id="workspace-discard-all"
							>
								<PanelIcon name="undo" small />
								{s.discardAll}
							</button>
						</div>
					)}
				</div>
			</div>
			<p className="ws-hooks note">{s.hooksNote}</p>
		</div>
	);
}

// The confirmations of Source Control: discarding (how many files, that
// untracked ones go to the Trash and tracked changes cannot be undone),
// taking secret files into git (each named), committing on a detached HEAD;
// and the dialog that names a new branch.
import { useEffect, useRef, useState } from "react";
import { DialogHead, Modal, useDomId } from "../../../messaging/ui/parts.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { Confirm } from "./use-scm.ts";

export function ConfirmDialog({ confirm, onAccept, onCancel }: { confirm: Confirm; onAccept: () => void; onCancel: () => void }) {
	const p = usePanelCopy();
	const c = p.confirm;
	const id = useDomId("ws-confirm");
	const title = confirm.kind === "discard" ? c.discardTitle : confirm.kind === "sensitive" ? c.sensitiveTitle : c.detachedTitle;
	const action = confirm.kind === "discard" ? c.discard : confirm.kind === "sensitive" ? (confirm.op === "stage" ? c.sensitiveStage : c.sensitiveCommit) : c.detachedCommit;
	return (
		<Modal labelledBy={id} onClose={onCancel}>
			<DialogHead id={id} title={title} onClose={onCancel} />
			<div className="dlg-body stack" data-id="workspace-confirm">
				{confirm.kind === "discard" && (
					<>
						<p>{c.discardBody(confirm.count)}</p>
						{confirm.untracked > 0 && <p className="note">{c.discardUntracked}</p>}
						{confirm.tracked > 0 && <p className="mx-warn">{c.discardTracked}</p>}
					</>
				)}
				{confirm.kind === "sensitive" && (
					<>
						<p>{c.sensitiveBody}</p>
						<ul className="ws-secret-list">
							{confirm.paths.map((path) => (
								<li key={path} className="mono">
									{path}
								</li>
							))}
						</ul>
					</>
				)}
				{confirm.kind === "detached" && <p>{c.detachedBody}</p>}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onCancel}>
					{c.cancel}
				</button>
				<button type="button" className="btn btn-danger" onClick={onAccept} data-id="workspace-confirm-go">
					{action}
				</button>
			</div>
		</Modal>
	);
}

/** "New branch": a name, created from what is checked out and switched to. */
export function NewBranchDialog({ from, onCreate, onClose, error }: { from: string; onCreate: (name: string) => Promise<boolean>; onClose: () => void; error: string }) {
	const p = usePanelCopy();
	const id = useDomId("ws-branch");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	// The dialog exists to type this one name: focus it once the dialog has opened (and focused its first control).
	useEffect(() => {
		const frame = requestAnimationFrame(() => input.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	const submit = () => {
		const trimmed = name.trim();
		if (trimmed === "" || busy) return;
		setBusy(true);
		onCreate(trimmed).then((ok) => {
			setBusy(false);
			if (ok) onClose();
		}, () => setBusy(false));
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={p.scm.newBranchTitle} onClose={onClose} />
			<form
				className="dlg-body stack"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<label className="field">
					<span>{p.scm.newBranchName}</span>
					<input ref={input} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" spellCheck={false} maxLength={250} />
				</label>
				<p className="note">{p.scm.newBranchFrom(from)}</p>
				{error !== "" && (
					<p className="mx-error" role="alert">
						{error}
					</p>
				)}
			</form>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{p.confirm.cancel}
				</button>
				<button type="button" className="btn btn-primary" disabled={busy || name.trim() === ""} onClick={submit}>
					{p.scm.create}
				</button>
			</div>
		</Modal>
	);
}

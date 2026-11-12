// The drawer over the session's main area that shows what the panel opened:
// a file's read-only preview or one file's diff. Its head names the file and
// offers "Open in terminal" (the session's terminal) and closing; Esc closes.
import { useEffect } from "react";
import { WsGitDiffSource } from "@achoo254/chat-proto/remote/remote";
import { baseName } from "../explorer/tree-model.ts";
import { FileIcon } from "../explorer/file-icon.tsx";
import { PanelIcon } from "../panel-icons.tsx";
import { MachineIcon } from "../../machine-icons.tsx";
import type { PanelCopy } from "../panel-copy-vi.ts";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { WsLink } from "../ws-client.ts";
import { DiffView, type DiffTarget } from "./diff-view.tsx";
import { FilePreview } from "./file-preview.tsx";

export type Viewing = { readonly kind: "file"; readonly path: string; readonly line: number } | { readonly kind: "diff"; readonly target: DiffTarget };

interface ViewerProps {
	link: WsLink;
	workspaceId: string;
	viewing: Viewing;
	onClose: () => void;
	/** Switches the session to its terminal; undefined when it has none (or shows it already). */
	onTerminal: (() => void) | undefined;
	errorText: (err: unknown) => string;
}

/** The tag of a diff: which comparison it is. */
function sourceTag(p: PanelCopy, source: WsGitDiffSource): string {
	switch (source) {
		case WsGitDiffSource.STAGED:
			return p.scm.staged;
		case WsGitDiffSource.BRANCH:
			return p.scm.committedOnBranch;
		case WsGitDiffSource.COMMIT:
			return p.scm.commits;
		default:
			return p.scm.unstaged;
	}
}

export function Viewer({ link, workspaceId, viewing, onClose, onTerminal, errorText }: ViewerProps) {
	const p = usePanelCopy();
	const path = viewing.kind === "file" ? viewing.path : viewing.target.path;
	useEffect(() => {
		// Esc closes the drawer first, wherever the focus is (captured: the session's own Esc, which
		// denies a pending approval, must not take it); a dialog over the drawer takes Esc before it.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]") !== null) return;
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	const tag = viewing.kind === "diff" ? sourceTag(p, viewing.target.source) : p.preview.readOnly;
	return (
		<section className="ws-viewer" aria-label={path} data-id="workspace-viewer">
			<header className="ws-viewer-head">
				<FileIcon name={baseName(path)} />
				<div className="title">
					<strong>{baseName(path)}</strong>
					<span className="mono">{viewing.kind === "diff" && viewing.target.oldPath !== "" ? `${viewing.target.oldPath} → ${path}` : path}</span>
				</div>
				<span className="mx-tag">{tag}</span>
				{viewing.kind === "file" && onTerminal !== undefined && (
					<button type="button" className="btn btn-sm" onClick={onTerminal} data-id="workspace-viewer-terminal">
						<MachineIcon name="terminal" small />
						<span className="hide-narrow">{p.preview.openInTerminal}</span>
					</button>
				)}
				<button type="button" className="icon-btn" aria-label={p.preview.close} title={p.preview.close} onClick={onClose}>
					<PanelIcon name="x" />
				</button>
			</header>
			<div className="ws-viewer-body">
				{viewing.kind === "file" ? (
					<FilePreview link={link} workspaceId={workspaceId} path={viewing.path} line={viewing.line} errorText={errorText} />
				) : (
					<DiffView link={link} workspaceId={workspaceId} target={viewing.target} errorText={errorText} />
				)}
			</div>
		</section>
	);
}

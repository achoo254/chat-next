// One file's diff in the workspace (WsGitDiff): the working tree against
// the index, the index against HEAD, a commit, or the branch against its
// base, drawn by the session view's DiffCard (unified, numbered, coloured).
// A secret file never asks (the machine would send no content anyway); a
// very long diff draws its first lines and says so.
import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { DiffItemSchema, type DiffItem, type GitFileChange, type WsGitDiffSource } from "@achoo254/chat-proto/remote/remote";
import { DiffCard } from "../../cards/diff.tsx";
import { useMachinesCopy } from "../../use-machines-copy.ts";
import { usePanelCopy } from "../use-panel-copy.ts";
import { ask, type WsLink } from "../ws-client.ts";

/** A git file's diff in the shape the diff card draws. */
function asDiff(file: GitFileChange): DiffItem {
	return create(DiffItemSchema, { path: file.path, unified: file.unified, added: file.added, removed: file.removed, truncated: file.truncated });
}

/** Lines a diff draws at most; the machine already caps it at 1 MiB. */
export const MAX_DIFF_LINES = 3000;

export interface DiffTarget {
	readonly path: string;
	readonly oldPath: string;
	readonly source: WsGitDiffSource;
	/** COMMIT: the commit's full id. */
	readonly commit?: string;
	/** BRANCH: the base the section compared with. */
	readonly base?: string;
	readonly sensitive: boolean;
}

type Loaded = { readonly key: string; readonly file: GitFileChange | null } | { readonly key: string; readonly error: unknown };

const keyOf = (t: DiffTarget) => `${t.source}\u0000${t.path}\u0000${t.oldPath}\u0000${t.commit ?? ""}\u0000${t.base ?? ""}`;

/** The first `max` lines of a unified diff, and how many it had. */
export function clipDiff(unified: string, max: number): { text: string; total: number; clipped: boolean } {
	const lines = unified.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length <= max) return { text: unified, total: lines.length, clipped: false };
	return { text: lines.slice(0, max).join("\n"), total: lines.length, clipped: true };
}

export function DiffView({ link, workspaceId, target, errorText }: { link: WsLink; workspaceId: string; target: DiffTarget; errorText: (err: unknown) => string }) {
	const p = usePanelCopy();
	const t = useMachinesCopy();
	const key = keyOf(target);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const { path, oldPath, source, commit, base, sensitive } = target;
	useEffect(() => {
		if (sensitive) return;
		let live = true;
		const value = { workspaceId, path, oldPath, source, commit: commit ?? "", base: base ?? "" };
		ask(link, { case: "wsGitDiff", value }, "wsGitDiffResult").then(
			(r) => live && setLoaded({ key, file: r.file ?? null }),
			(error: unknown) => live && setLoaded({ key, error }),
		);
		return () => {
			live = false;
		};
	}, [link, workspaceId, key, path, oldPath, source, commit, base, sensitive]);
	if (sensitive) return <p className="ws-msg">{t.agent.changes.sensitive}</p>;
	if (loaded === null || loaded.key !== key) {
		return (
			<p className="ws-msg" role="status" aria-busy="true">
				{p.loading}
			</p>
		);
	}
	if ("error" in loaded) {
		return (
			<p className="ws-msg mx-error" role="alert">
				{errorText(loaded.error)}
			</p>
		);
	}
	const file = loaded.file;
	if (file === null) return <p className="ws-msg">{t.agent.changes.gone}</p>;
	if (file.sensitive) return <p className="ws-msg">{t.agent.changes.sensitive}</p>;
	if (file.binary) return <p className="ws-msg">{t.agent.changes.binary}</p>;
	if (file.unified === "") return <p className="ws-msg">{p.preview.noDiff}</p>;
	const clip = clipDiff(file.unified, MAX_DIFF_LINES);
	// The whole diff is here: the card offers no "show all" (truncated means the machine's 1 MiB cap, said below).
	const diff = asDiff({ ...file, unified: clip.text, truncated: false });
	return (
		<div className="ws-diff">
			{clip.clipped && <p className="ws-msg note">{p.preview.diffClipped(MAX_DIFF_LINES, clip.total)}</p>}
			{file.truncated && <p className="ws-msg note">{p.preview.diffCut}</p>}
			<DiffCard bare diff={diff} full={null} onFetchFull={() => Promise.resolve()} />
		</div>
	);
}

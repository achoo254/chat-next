// The Explorer's tree: one row per entry with its icon, git's mark (U, A, M,
// R…) and a dimmed style for what git ignores, links marked (and those
// pointing outside the workspace), a "load more" row after a long folder.
// A single row takes Tab (roving tabindex); the keys of tree-model.ts move
// and open; a click on a folder opens or closes it, on a file previews it.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MachineIcon } from "../../machine-icons.tsx";
import { gitMark } from "../git-marks.ts";
import { PanelIcon } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import { EntryIcon } from "./file-icon.tsx";
import { treeKey, type Row } from "./tree-model.ts";

interface TreeViewProps {
	rows: readonly Row[];
	expanded: ReadonlySet<string>;
	/** The file the preview shows; null when none. */
	selected: string | null;
	label: string;
	onExpand: (path: string) => void;
	onCollapse: (path: string) => void;
	onOpen: (path: string) => void;
	onMore: (dir: string) => void;
	onRetry: (dir: string) => void;
	errorText: (err: unknown) => string;
}

export function TreeView({ rows, expanded, selected, label, onExpand, onCollapse, onOpen, onMore, onRetry, errorText }: TreeViewProps) {
	const p = usePanelCopy();
	const [focus, setFocus] = useState(0);
	const tree = useRef<HTMLDivElement>(null);
	const at = Math.min(focus, Math.max(0, rows.length - 1));
	// The keyboard moved the focus: follow it with the browser's focus.
	useEffect(() => {
		const root = tree.current;
		if (root === null || !root.contains(document.activeElement)) return;
		root.querySelector<HTMLElement>(`[data-row="${at}"]`)?.focus();
	}, [at]);
	const act = (index: number, key: string, event: KeyboardEvent) => {
		const action = treeKey(rows, index, key, expanded);
		if (action === null) return;
		event.preventDefault();
		switch (action.kind) {
			case "focus":
				return setFocus(action.index);
			case "expand":
				return onExpand(action.path);
			case "collapse":
				return onCollapse(action.path);
			case "open":
				return onOpen(action.path);
			case "more":
				return onMore(action.dir);
		}
	};
	const click = (row: Row, index: number) => {
		setFocus(index);
		if (row.kind === "more") return onMore(row.parent);
		if (row.kind === "error") return onRetry(row.parent);
		if (row.kind !== "entry") return;
		if (!row.entry.dir) return onOpen(row.path);
		if (expanded.has(row.path)) onCollapse(row.path);
		else onExpand(row.path);
	};
	return (
		<div className="ws-tree" role="tree" aria-label={label} ref={tree}>
			{rows.map((row, index) => {
				const indent = { paddingInlineStart: `calc(var(--space-2) + ${row.depth} * 14px)` };
				const common = {
					"data-row": index,
					tabIndex: index === at ? 0 : -1,
					onKeyDown: (event: KeyboardEvent) => act(index, event.key, event),
					onClick: () => click(row, index),
					style: indent,
				};
				if (row.kind === "entry") {
					const { entry } = row;
					const mark = gitMark(entry.git, p.explorer.git);
					const open = entry.dir && expanded.has(row.path);
					const cls = ["ws-row", entry.ignored ? "ignored" : "", selected === row.path ? "selected" : "", mark === null ? "" : `ws-git-${mark.tone}`].filter(Boolean).join(" ");
					return (
						<div key={row.path} role="treeitem" aria-level={row.depth + 1} aria-expanded={entry.dir ? open : undefined} aria-selected={selected === row.path} className={cls} title={row.path} {...common}>
							<span className="ws-chev" aria-hidden="true">
								{entry.dir && <MachineIcon name={open ? "chevron-down" : "chevron-right"} small />}
							</span>
							<EntryIcon entry={entry} open={open} />
							<span className="ws-name">{entry.name}</span>
							{entry.symlink && (
								<span className="ws-badge" title={entry.outside ? p.explorer.outside : p.explorer.symlink}>
									<PanelIcon name="link" small />
									<span className="sr-only">{entry.outside ? p.explorer.outside : p.explorer.symlink}</span>
								</span>
							)}
							{entry.ignored && <span className="sr-only">{p.explorer.ignored}</span>}
							{mark !== null && (
								<span className="ws-mark" title={mark.label}>
									<span aria-hidden="true">{mark.letter}</span>
									<span className="sr-only">{mark.label}</span>
								</span>
							)}
						</div>
					);
				}
				if (row.kind === "more") {
					return (
						<div key={row.path} role="treeitem" aria-level={row.depth + 1} aria-selected={false} className="ws-row ws-more" {...common}>
							<span className="ws-chev" aria-hidden="true" />
							{p.explorer.loadMore(row.shown, row.total)}
						</div>
					);
				}
				const text = row.kind === "loading" ? p.loading : row.kind === "empty" ? p.explorer.empty : `${errorText(row.error)} · ${p.retry}`;
				return (
					<div key={row.path} role="treeitem" aria-level={row.depth + 1} aria-selected={false} aria-busy={row.kind === "loading"} className={`ws-row ws-note ${row.kind}`} {...common}>
						<span className="ws-chev" aria-hidden="true" />
						{text}
					</div>
				);
			})}
		</div>
	);
}

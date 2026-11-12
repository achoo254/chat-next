// The Explorer tab (read-only): the workspace's name with collapse all,
// refresh and a menu (hidden files, git-ignored files), "Names | Contents",
// the "Find files" box, then the tree or what the search found. Secret files
// never show: the machine leaves them out even with hidden files on.
import { useEffect, useState } from "react";
import type { WsChanged } from "@achoo254/chat-proto/remote/remote";
import { usePopover } from "../../use-popover.ts";
import { PanelIcon, type PanelIconName } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { WsLink } from "../ws-client.ts";
import { FindResults } from "./find-results.tsx";
import { TreeView } from "./tree-view.tsx";
import { visibleRows } from "./tree-model.ts";
import { useFind, type ContentOptions, type FindMode } from "./use-find.ts";
import { useTree } from "./use-tree.ts";

interface ExplorerProps {
	link: WsLink;
	workspaceId: string;
	name: string;
	online: boolean;
	/** The machine looks at git every 10 s instead of watching files (WsChanged.polling). */
	polling: boolean;
	selected: string | null;
	onOpen: (path: string, line?: number) => void;
	/** Registers the tree's handler of WsChanged; returns the unregister. */
	subscribe: (listener: (change: WsChanged) => void) => () => void;
	errorText: (err: unknown) => string;
}

export function Explorer({ link, workspaceId, name, online, polling, selected, onOpen, subscribe, errorText }: ExplorerProps) {
	const p = usePanelCopy();
	const e = p.explorer;
	const [showHidden, setShowHidden] = useState(false);
	const [hideIgnored, setHideIgnored] = useState(false);
	const tree = useTree(link, workspaceId, online, { showHidden, hideIgnored });
	useEffect(() => subscribe(tree.onChange), [subscribe, tree.onChange]);
	const [mode, setMode] = useState<FindMode>("names");
	const [query, setQuery] = useState("");
	const [options, setOptions] = useState<ContentOptions>({ caseSensitive: false, wholeWord: false, regex: false });
	const found = useFind(link, workspaceId, mode, query, options);
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	const rows = visibleRows(tree.dirs, tree.expanded);
	const searching = query.trim() !== "";
	const flag = (key: keyof ContentOptions, icon: PanelIconName, label: string) => (
		<button type="button" className="ws-flag" aria-pressed={options[key]} aria-label={label} title={label} onClick={() => setOptions((o) => ({ ...o, [key]: !o[key] }))}>
			<PanelIcon name={icon} small />
		</button>
	);
	return (
		<section className="ws-view" aria-label={p.tabs.explorer}>
			<header className="ws-view-head">
				<h2 className="ws-view-title" title={name}>
					{name}
				</h2>
				<button type="button" className="icon-btn ws-act" aria-label={e.collapseAll} title={e.collapseAll} onClick={tree.collapseAll}>
					<PanelIcon name="collapse" small />
				</button>
				<button type="button" className="icon-btn ws-act" aria-label={e.refresh} title={e.refresh} disabled={!online} onClick={tree.refresh}>
					<PanelIcon name="refresh" small />
				</button>
				<div className="mx-model" ref={menuRef}>
					<button type="button" className="icon-btn ws-act" aria-label={e.more} title={e.more} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
						<PanelIcon name="more" small />
					</button>
					{menuOpen && (
						<div className="mx-menu ws-menu" role="menu" aria-label={e.more}>
							<button type="button" role="menuitemcheckbox" aria-checked={showHidden} onClick={() => setShowHidden((v) => !v)}>
								<span className="ws-check">{showHidden && <PanelIcon name="check" small />}</span>
								{e.showHidden}
							</button>
							<button type="button" role="menuitemcheckbox" aria-checked={hideIgnored} onClick={() => setHideIgnored((v) => !v)}>
								<span className="ws-check">{hideIgnored && <PanelIcon name="check" small />}</span>
								{e.hideIgnored}
							</button>
							<p className="mx-menu-note">{e.showHiddenNote}</p>
						</div>
					)}
				</div>
			</header>
			<div className="ws-find">
				<div className="mx-view-switch ws-seg" role="group" aria-label={e.mode}>
					{(["names", "contents"] as const).map((m) => (
						<button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
							{m === "names" ? e.names : e.contents}
						</button>
					))}
				</div>
				<div className="ws-search">
					<PanelIcon name="search" small />
					<input
						type="search"
						value={query}
						placeholder={mode === "names" ? e.findNames : e.findContents}
						aria-label={mode === "names" ? e.findNames : e.findContents}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
						autoComplete="off"
						spellCheck={false}
						maxLength={2048}
					/>
					{mode === "contents" && (
						<span className="ws-flags">
							{flag("caseSensitive", "case-sensitive", e.caseSensitive)}
							{flag("wholeWord", "whole-word", e.wholeWord)}
							{flag("regex", "regex", e.regex)}
						</span>
					)}
				</div>
			</div>
			<div className="ws-scroll">
				{searching ? (
					<FindResults
						result={found}
						mark={mode === "contents" && !options.regex ? query.trim() : ""}
						caseSensitive={options.caseSensitive}
						selected={selected}
						onOpen={onOpen}
						errorText={errorText}
					/>
				) : (
					<TreeView
						rows={rows}
						expanded={tree.expanded}
						selected={selected}
						label={e.tree}
						onExpand={tree.expand}
						onCollapse={tree.collapse}
						onOpen={(path) => onOpen(path)}
						onMore={tree.loadMore}
						onRetry={(dir) => (dir === "" ? tree.refresh() : tree.expand(dir))}
						errorText={errorText}
					/>
				)}
			</div>
			{polling && <p className="ws-foot note">{e.polling}</p>}
		</section>
	);
}

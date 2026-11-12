// The Explorer's tree against the machine: reads a folder's first page when
// it opens (WsDirList), later pages on "load more", and reads open folders
// again after a change (the ones WsChanged names, or all of them). An
// answer that arrives after a newer read of the same folder is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WsChanged } from "@achoo254/chat-proto/remote/remote";
import { ask, type WsLink } from "../ws-client.ts";
import { applyPage, failLoading, loadedOpenDirs, nextCursor, startLoading, type Dirs } from "./tree-model.ts";

/** Entries a page asks for; a folder read again asks for as many as it showed (the machine caps it at 2000). */
const PAGE = 500;
const MAX_PAGE = 2000;

export interface TreeOptions {
	readonly showHidden: boolean;
	readonly hideIgnored: boolean;
}

export interface Tree {
	readonly dirs: Dirs;
	readonly expanded: ReadonlySet<string>;
	readonly expand: (path: string) => void;
	readonly collapse: (path: string) => void;
	readonly collapseAll: () => void;
	readonly loadMore: (dir: string) => void;
	/** Reads every open folder again. */
	readonly refresh: () => void;
	readonly onChange: (change: WsChanged) => void;
}

export function useTree(link: WsLink, workspaceId: string, online: boolean, options: TreeOptions): Tree {
	const [dirs, setDirs] = useState<Dirs>(new Map());
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	/** The newest read of each folder; older answers are dropped. */
	const serial = useRef(new Map<string, number>());
	const dirsRef = useRef(dirs);
	const expandedRef = useRef(expanded);
	useEffect(() => {
		dirsRef.current = dirs;
		expandedRef.current = expanded;
	}, [dirs, expanded]);
	const { showHidden, hideIgnored } = options;

	const load = useCallback(
		(dir: string, append: boolean) => {
			const current = dirsRef.current.get(dir);
			const n = (serial.current.get(dir) ?? 0) + 1;
			serial.current.set(dir, n);
			const cursor = append ? nextCursor(current) : { afterName: "", afterDir: false };
			const limit = append ? PAGE : Math.min(MAX_PAGE, Math.max(PAGE, current?.entries.length ?? 0));
			setDirs((d) => startLoading(d, dir));
			ask(link, { case: "wsDirList", value: { workspaceId, path: dir, ...cursor, limit, showHidden, hideIgnored } }, "wsDirListResult").then(
				(result) => {
					if (serial.current.get(dir) !== n) return;
					setDirs((d) => applyPage(d, { ...result, path: dir }, append));
				},
				(err: unknown) => {
					if (serial.current.get(dir) !== n) return;
					setDirs((d) => failLoading(d, dir, err));
				},
			);
		},
		[link, workspaceId, showHidden, hideIgnored],
	);

	// The root on open, and every open folder again when the options change or the machine comes back.
	useEffect(() => {
		if (!online) return;
		for (const dir of loadedOpenDirs(dirsRef.current, expandedRef.current)) load(dir, false);
		if (!dirsRef.current.has("")) load("", false);
	}, [online, load]);

	const expand = useCallback(
		(path: string) => {
			setExpanded((e) => new Set(e).add(path));
			const state = dirsRef.current.get(path);
			if (state === undefined || state.error !== null) load(path, false);
		},
		[load],
	);
	const collapse = useCallback((path: string) => {
		setExpanded((e) => {
			const next = new Set(e);
			next.delete(path);
			return next;
		});
	}, []);
	const collapseAll = useCallback(() => setExpanded(new Set()), []);
	const loadMore = useCallback((dir: string) => load(dir, true), [load]);
	const refresh = useCallback(() => {
		for (const dir of loadedOpenDirs(dirsRef.current, expandedRef.current)) load(dir, false);
	}, [load]);
	const onChange = useCallback(
		(change: WsChanged) => {
			const open = loadedOpenDirs(dirsRef.current, expandedRef.current);
			// git's marks show on every open folder; a change of the status reads them all again.
			if (change.overflow || change.git) {
				for (const dir of open) load(dir, false);
				return;
			}
			const named = new Set(change.dirs);
			for (const dir of open) if (named.has(dir)) load(dir, false);
		},
		[load],
	);
	return { dirs, expanded, expand, collapse, collapseAll, loadMore, refresh, onChange };
}

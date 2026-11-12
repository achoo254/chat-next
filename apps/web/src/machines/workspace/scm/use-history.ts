// What Source Control reads besides the status: the commits (WsGitLog, 50 a
// page), what the branch committed since its base (WsGitBranchCompare), the
// page that opens a pull request for the branch (WsGitPrUrl, read ahead so
// the button opens it straight from the click), and the branches (on demand,
// when the selector opens). All read again when HEAD or the branch moves:
// each answer is kept with the key (workspace, branch, writes) it answers.
import { useCallback, useEffect, useState } from "react";
import type { WsGitBranchCompareResult, WsGitBranchesResult, WsGitLogEntry } from "@achoo254/chat-proto/remote/remote";
import { ask, type WsLink } from "../ws-client.ts";

export interface Log {
	readonly commits: readonly WsGitLogEntry[];
	readonly hasMore: boolean;
	readonly loading: boolean;
	readonly error: unknown;
}

export type Loadable<T> = { readonly kind: "loading" } | { readonly kind: "ready"; readonly value: T } | { readonly kind: "error"; readonly error: unknown };

type Keyed<T> = { readonly key: string; readonly value: T };

const LOADING = { kind: "loading" } as const;
const PAGE = 50;

/** A pull request page from the machine: https without credentials only (the machine sends no other; this checks). */
export function prPage(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed.href : null;
	} catch {
		return null;
	}
}

/** Commits of a later page after those shown, without repeats. */
function appendCommits(shown: readonly WsGitLogEntry[], page: readonly WsGitLogEntry[]): WsGitLogEntry[] {
	const seen = new Set(shown.map((c) => c.oid));
	return [...shown, ...page.filter((c) => !seen.has(c.oid))];
}

export function useHistory(link: WsLink, workspaceId: string, online: boolean, git: boolean, branch: string, history: number) {
	const key = `${workspaceId}\u0000${branch}\u0000${history}`;
	const [log, setLog] = useState<Keyed<Log> | null>(null);
	const [compare, setCompare] = useState<Keyed<Loadable<WsGitBranchCompareResult>> | null>(null);
	const [pr, setPr] = useState<Keyed<Loadable<string>> | null>(null);
	const [branches, setBranches] = useState<Keyed<Loadable<WsGitBranchesResult>> | null>(null);

	useEffect(() => {
		if (!online || !git) return;
		let live = true;
		const keep = <T>(set: (value: Keyed<T>) => void) => (value: T) => {
			if (live) set({ key, value });
		};
		ask(link, { case: "wsGitLog", value: { workspaceId, ref: "", skip: 0, limit: PAGE } }, "wsGitLogResult").then(
			(r) => keep(setLog)({ commits: r.commits, hasMore: r.hasMore, loading: false, error: null }),
			(error: unknown) => keep(setLog)({ commits: [], hasMore: false, loading: false, error }),
		);
		ask(link, { case: "wsGitBranchCompare", value: { workspaceId, base: "" } }, "wsGitBranchCompareResult").then(
			(value) => keep<Loadable<WsGitBranchCompareResult>>(setCompare)({ kind: "ready", value }),
			(error: unknown) => keep<Loadable<WsGitBranchCompareResult>>(setCompare)({ kind: "error", error }),
		);
		// Detached: no branch to propose.
		if (branch !== "") {
			ask(link, { case: "wsGitPrUrl", value: { workspaceId, base: "" } }, "wsGitPrUrlResult").then(
				(r) => {
					const url = prPage(r.url);
					keep<Loadable<string>>(setPr)(url === null ? { kind: "error", error: null } : { kind: "ready", value: url });
				},
				(error: unknown) => keep<Loadable<string>>(setPr)({ kind: "error", error }),
			);
		}
		return () => {
			live = false;
		};
	}, [link, workspaceId, online, git, branch, key]);

	const shownLog = log?.key === key ? log.value : null;
	const loadMore = useCallback(() => {
		if (shownLog === null) return;
		const shown = shownLog.commits;
		setLog({ key, value: { ...shownLog, loading: true, error: null } });
		ask(link, { case: "wsGitLog", value: { workspaceId, ref: "", skip: shown.length, limit: PAGE } }, "wsGitLogResult").then(
			(r) => setLog((current) => (current?.key === key ? { key, value: { commits: appendCommits(current.value.commits, r.commits), hasMore: r.hasMore, loading: false, error: null } } : current)),
			(error: unknown) => setLog((current) => (current?.key === key ? { key, value: { ...current.value, loading: false, error } } : current)),
		);
	}, [link, workspaceId, key, shownLog]);

	const loadBranches = useCallback(() => {
		setBranches({ key, value: LOADING });
		ask(link, { case: "wsGitBranches", value: { workspaceId } }, "wsGitBranchesResult").then(
			(value) => setBranches({ key, value: { kind: "ready", value } }),
			(error: unknown) => setBranches({ key, value: { kind: "error", error } }),
		);
	}, [link, workspaceId, key]);

	return {
		log: shownLog ?? { commits: log?.value.commits ?? [], hasMore: false, loading: true, error: null },
		loadMore,
		compare: compare?.key === key ? compare.value : LOADING,
		pr: branch === "" ? ({ kind: "error", error: null } as const) : pr?.key === key ? pr.value : LOADING,
		branches: branches?.key === key ? branches.value : LOADING,
		loadBranches,
	};
}

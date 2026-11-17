// A session's terminal tabs under its row in the AI Agent column, as Orca
// lists a worktree's agents and terminals: one row per tab of the session's
// dock (its AI's CLI, the shells opened beside it), the one in front marked
// while the session is open; a pick opens the session's terminal with that
// tab in front. Listed only when the session has more than one tab. The tabs
// are the dock's own layout on this device (sharedLayouts), against the
// machine's list of sessions when it came in (a closed shell drops out).
import { useEffect, useSyncExternalStore } from "react";
import type { TermSessionInfo, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { followInApp } from "../router.tsx";
import { panesOf, pruneForScope, sessionScope, sharedLayouts, type DockLayout, type LayoutStore } from "../terminal/terminal-layout.ts";
import { aiPaths } from "./ai-paths.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { threadStatus, type WorkStatus } from "./project-tree.ts";
import { aiTabTitle, StatusGlyph } from "./status-glyph.tsx";
import { aiName, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** One tab of a session's dock as its row says it. */
export interface SessionTab {
	readonly id: string;
	readonly title: string;
	/** The session's AI runs in it (the pane in front of the tab). */
	readonly ai: boolean;
	/** The tab in front of the dock. */
	readonly active: boolean;
}

/**
 * The tabs of a session's stored dock layout, named as the dock names them: the AI's tab by the title its CLI
 * set (without its state mark), else the AI's name; a shell's by its title, else "Terminal N". With the machine's
 * list (`listed`), only the panes the machine still runs for this session are kept, as the dock keeps them.
 */
export function sessionTabs(layout: DockLayout | undefined, listed: readonly TermSessionInfo[] | undefined, threadId: string, names: { ai: string; tab: (n: number) => string }): SessionTab[] {
	if (layout === undefined) return [];
	const kept = listed === undefined ? layout : pruneForScope(layout, listed, threadId);
	const titleOf = new Map((listed ?? []).map((s) => [s.session, s.title]));
	const active = kept.tabs.some((x) => x.id === kept.active) ? kept.active : (kept.tabs[0]?.id ?? "");
	return kept.tabs.map((tab, i) => {
		const pane = panesOf(tab.root).find((p) => p.id === tab.focus) ?? panesOf(tab.root)[0];
		const title = pane === undefined ? "" : (titleOf.get(pane.session) ?? "");
		const ai = pane?.ai === true;
		return { id: tab.id, title: ai ? aiTabTitle(title) || names.ai : title || names.tab(i + 1), ai, active: tab.id === active };
	});
}

/** The machine's sessions shown in a tab of one of its sessions' docks (they are listed under that session, not apart). */
export function sessionTabShells(known: ReadonlyMap<string, DockLayout>, machine: MachineView): Set<number> {
	const out = new Set<number>();
	for (const thread of machine.state.threads) {
		const layout = known.get(sessionScope(machine.entry.ref, thread.id));
		if (layout === undefined) continue;
		for (const tab of layout.tabs) for (const pane of panesOf(tab.root)) if (pane.ai !== true) out.add(pane.session);
	}
	return out;
}

/** The docks' layouts on this page, read whole from storage once, and kept up to date. */
export function useDockLayouts(store: LayoutStore = sharedLayouts()): ReadonlyMap<string, DockLayout> {
	useEffect(() => {
		void store.loadAll();
	}, [store]);
	useSyncExternalStore(store.subscribe, store.version);
	return store.known();
}

export function SessionTabs({
	machine,
	thread,
	listed,
	layout,
	current,
	online,
}: {
	machine: MachineView;
	thread: ThreadSummary;
	/** The machine's terminal sessions as it last listed them; undefined before it did. */
	listed: readonly TermSessionInfo[] | undefined;
	layout: DockLayout | undefined;
	/** The session is the one open. */
	current: boolean;
	online: boolean;
}) {
	const t = useMachinesCopy();
	const ai = aiName(machine.state.info, thread.provider);
	const tabs = sessionTabs(layout, listed, thread.id, { ai, tab: t.terminal.tabTitle });
	if (tabs.length < 2) return null;
	const status: WorkStatus = threadStatus(thread, false);
	return (
		<ul className="mx-rows mx-tabs" aria-label={t.agent.projects.sessionTabs(thread.title || t.agent.newSession)} data-id={`sidebar-tabs-${thread.id}`}>
			{tabs.map((tab) => {
				const path = aiPaths.sessionTab(machine.entry.ref, thread.id, tab.id);
				const glyph = tab.ai ? (
					<StatusGlyph status={status} icon="ai-session" who={ai} ai={thread.provider} offline={!online} />
				) : (
					<span className="mx-glyph" aria-hidden="true">
						<MachineIcon name="terminal" small />
					</span>
				);
				const body = (
					<span className="tx">
						<span className="line">
							{glyph}
							<span className="name">{tab.title}</span>
						</span>
					</span>
				);
				return (
					<li key={tab.id}>
						{online ? (
							<a href={path} className="mx-srow slim mx-tab" data-row="" aria-current={current && tab.active ? "true" : undefined} onClick={(event) => followInApp(event, path)}>
								{body}
							</a>
						) : (
							<div className="mx-srow slim mx-tab disabled" aria-disabled="true">
								{body}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

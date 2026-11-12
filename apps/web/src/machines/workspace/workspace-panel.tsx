// The workspace's right panel (as in Orca): a strip of icon tabs (Explorer,
// Source Control; content search lives in the Explorer's "Contents"), a
// draggable left edge, and the tabs' views, each mounted on first visit and
// kept while the panel stays open. What a view opens (a file, a diff) shows
// in a drawer over the session's main area. On a phone the panel is a
// full-height sheet. It watches the workspace while it shows. Loaded on
// first open in its own chunk, with its copy and styles.
import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { MachineIcon } from "../machine-icons.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { Explorer } from "./explorer/explorer.tsx";
import { PanelIcon } from "./panel-icons.tsx";
import type { PanelCopy } from "./panel-copy-vi.ts";
import type { PanelPrefs, PanelTab } from "./panel-prefs.ts";
import { ResizeHandle } from "./resize-handle.tsx";
import { SourceControl } from "./scm/source-control.tsx";
import { useScm } from "./scm/use-scm.ts";
import { usePanelCopy } from "./use-panel-copy.ts";
import { useWsWatch } from "./use-ws-watch.ts";
import { Viewer, type Viewing } from "./viewer/viewer.tsx";
import type { WsLink } from "./ws-client.ts";
import { needsAgentUpdate, wsErrorText } from "./ws-errors.ts";
import "./workspace.css";

export interface WorkspacePanelProps {
	link: WsLink;
	/** The machine's project the session works in. */
	workspace: { readonly id: string; readonly name: string; readonly dir: string };
	online: boolean;
	ai: string;
	prefs: PanelPrefs;
	onPrefs: (change: Partial<PanelPrefs>) => void;
	/** Switches the session to its terminal; undefined when it has none or shows it already. */
	onTerminal: (() => void) | undefined;
}

const TABS: readonly PanelTab[] = ["explorer", "scm"];

export default function WorkspacePanel({ link, workspace, online, ai, prefs, onPrefs, onTerminal }: WorkspacePanelProps) {
	const p = usePanelCopy();
	const t = useMachinesCopy();
	const ws = workspace.id;
	const errorText = useCallback((err: unknown) => wsErrorText(p, t, err, ai), [p, t, ai]);
	const watch = useWsWatch(link, ws, online);
	const scm = useScm(link, ws, online);
	const { subscribe } = watch;
	// Source Control reads git's status again after a change, whichever tab shows.
	useEffect(() => subscribe(scm.onChange), [subscribe, scm.onChange]);
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const [visited, setVisited] = useState<ReadonlySet<PanelTab>>(() => new Set([prefs.tab]));
	const [viewing, setViewing] = useState<{ view: Viewing; key: string } | null>(null);
	const tab = prefs.tab;
	const pick = (next: PanelTab) => {
		setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
		onPrefs({ tab: next });
	};
	// The tab a shortcut switched to counts as visited (state kept from render, as React allows).
	if (!visited.has(tab)) setVisited(new Set(visited).add(tab));
	const close = () => onPrefs({ open: false });
	const closeViewer = useCallback(() => setViewing(null), []);
	const outdated = needsAgentUpdate(scm.statusError);
	const changes = scm.status?.git === true ? scm.status.entries.length : 0;
	const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		const at = TABS.indexOf(tab);
		const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? TABS[(at + 1) % TABS.length] : event.key === "ArrowLeft" || event.key === "ArrowUp" ? TABS[(at + TABS.length - 1) % TABS.length] : undefined;
		if (next === undefined) return;
		event.preventDefault();
		pick(next);
		event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
	};
	const width = dragWidth ?? prefs.width;
	/** The panel's width, for the panel and for the drawer beside it. */
	const panelWidth = { "--ws-w": `${width}px` } as CSSProperties;
	return (
		<>
			{viewing !== null && online && (
				<div className="ws-viewer-wrap" style={panelWidth} data-own-keys="">
				<Viewer
					link={link}
					workspaceId={ws}
					viewing={viewing.view}
					onClose={closeViewer}
					onTerminal={
						onTerminal === undefined
							? undefined
							: () => {
									closeViewer();
									onTerminal();
								}
					}
					errorText={errorText}
				/>
				</div>
			)}
			<aside className="ws-panel" aria-label={p.title} data-id="workspace-panel" style={panelWidth} data-own-keys="">
				<ResizeHandle
					width={width}
					label={p.resize}
					onResize={setDragWidth}
					onDone={(w) => {
						setDragWidth(null);
						onPrefs({ width: w });
					}}
				/>
				<div className="ws-tabs">
					<div className="ws-tablist" role="tablist" aria-label={p.title}>
						{TABS.map((key) => (
							<button
								key={key}
								type="button"
								role="tab"
								id={`ws-tab-${key}`}
								aria-controls={`ws-pane-${key}`}
								aria-selected={tab === key}
								tabIndex={tab === key ? 0 : -1}
								aria-label={tabLabel(p, key, changes)}
								title={tabLabel(p, key, changes)}
								className="ws-tab"
								data-tab={key}
								onClick={() => pick(key)}
								onKeyDown={tabKey}
							>
								<PanelIcon name={key === "explorer" ? "files" : "git"} />
								{key === "scm" && changes > 0 && <span className="ws-badge-n">{changes > 999 ? "999+" : changes}</span>}
							</button>
						))}
					</div>
					<span className="ws-tabs-name" title={workspace.dir}>
						{workspace.name}
					</span>
					<button type="button" className="icon-btn ws-close" aria-label={p.close} title={p.close} onClick={close} data-id="workspace-panel-close">
						<PanelIcon name="x" small />
					</button>
				</div>
				{!online || outdated ? (
					<PanelNote text={!online ? p.offline : p.errors.needsUpdate} />
				) : (
					TABS.map((key) => (
						<div key={key} id={`ws-pane-${key}`} role="tabpanel" aria-labelledby={`ws-tab-${key}`} className="ws-pane" hidden={tab !== key}>
							{visited.has(key) &&
								(key === "explorer" ? (
									<Explorer
										link={link}
										workspaceId={ws}
										name={workspace.name}
										online={online}
										polling={watch.polling}
										selected={viewing?.view.kind === "file" ? viewing.view.path : null}
										onOpen={(path, line) => setViewing({ view: { kind: "file", path, line: line ?? 0 }, key: path })}
										subscribe={subscribe}
										errorText={errorText}
									/>
								) : (
									<SourceControl
										link={link}
										workspaceId={ws}
										name={workspace.name}
										online={online}
										scm={scm}
										selected={viewing?.view.kind === "diff" ? viewing.key : null}
										onView={(target, key) => setViewing({ view: { kind: "diff", target }, key })}
										errorText={errorText}
									/>
								))}
						</div>
					))
				)}
			</aside>
		</>
	);
}

function tabLabel(p: PanelCopy, tab: PanelTab, changes: number): string {
	return tab === "explorer" ? p.tabs.explorer : changes > 0 ? `${p.tabs.scm} (${changes})` : p.tabs.scm;
}

function PanelNote({ text }: { text: string }) {
	return (
		<div className="ws-pane ws-note-pane" role="status">
			<MachineIcon name="alert-circle" />
			<p>{text}</p>
		</div>
	);
}

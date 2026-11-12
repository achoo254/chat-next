// What the session view keeps of the workspace panel: which workspace (the
// machine's project holding the session's folder), the panel's remembered
// place, the header's toggle button and the keyboard shortcuts (Alt+Shift+E
// toggles it on the Explorer, Alt+Shift+G on Source Control). The panel
// itself, its copy and its styles load in their own chunk on first open.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Project } from "@achoo254/chat-proto/remote/remote";
import type { LinkState, MachineLink } from "../link/machine-link.ts";
import { inFolder } from "../projects-view.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { DEFAULT_PREFS, readPrefs, writePrefs, type PanelPrefs, type PanelTab } from "./panel-prefs.ts";
import type { WorkspacePanelProps } from "./workspace-panel.tsx";

const WorkspacePanel = lazy(() => import("./workspace-panel.tsx"));

/** The machine's project that holds `dir` (the deepest one); undefined when none. */
export function workspaceOf(state: Pick<LinkState, "projects">, dir: string): Project | undefined {
	if (dir === "") return undefined;
	return state.projects?.projects.filter((p) => !p.missing && inFolder(dir, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
}

/** The panel's shortcut for a key: Alt+Shift+E (Explorer) or Alt+Shift+G (Source Control), by physical key. */
export function panelShortcut(event: Pick<KeyboardEvent, "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "code">): PanelTab | null {
	if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
	if (event.code === "KeyE") return "explorer";
	if (event.code === "KeyG") return "scm";
	return null;
}

export interface WorkspacePanelState {
	readonly workspace: Project | undefined;
	readonly prefs: PanelPrefs;
	readonly update: (change: Partial<PanelPrefs>) => void;
	readonly toggle: (tab?: PanelTab) => void;
}

export function useWorkspacePanel(machine: string, link: Pick<MachineLink, "request">, state: Pick<LinkState, "projects" | "status">, dir: string): WorkspacePanelState {
	const workspace = workspaceOf(state, dir);
	const key = workspace?.id ?? "";
	const online = state.status.kind === "open";
	const listed = state.projects !== null;
	// The column asks for the projects; a phone opened straight on a session may not show it.
	useEffect(() => {
		if (online && !listed) link.request({ case: "projectList", value: {} }).catch(() => undefined);
	}, [link, online, listed]);
	const [stored, setStored] = useState<{ key: string; prefs: PanelPrefs }>({ key: "", prefs: DEFAULT_PREFS });
	const prefs = stored.key === key ? stored.prefs : key === "" ? DEFAULT_PREFS : readPrefs(machine, key);
	/** Sets the prefs from the current ones (kept on this device). */
	const change = (make: (current: PanelPrefs) => PanelPrefs) => {
		if (key === "") return;
		const next = make(prefs);
		writePrefs(machine, key, next);
		setStored({ key, prefs: next });
	};
	const update = (partial: Partial<PanelPrefs>) => change((current) => ({ ...current, ...partial }));
	// A shortcut for the other tab switches to it; the same one (or the button) opens or closes.
	const toggle = (tab?: PanelTab) =>
		change((current) => (tab !== undefined && current.open && current.tab !== tab ? { ...current, tab } : { ...current, open: !current.open, ...(tab === undefined ? {} : { tab }) }));
	const toggleRef = useRef(toggle);
	useEffect(() => {
		toggleRef.current = toggle;
	});
	useEffect(() => {
		if (key === "") return;
		// Capture: the terminal (xterm) would take the keys first.
		const onKey = (event: KeyboardEvent) => {
			const tab = panelShortcut(event);
			if (tab === null) return;
			event.preventDefault();
			event.stopPropagation();
			toggleRef.current(tab);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [key]);
	return { workspace, prefs, update, toggle };
}

/** The header's button that opens and closes the panel. */
export function PanelToggle({ panel }: { panel: WorkspacePanelState }) {
	const t = useMachinesCopy();
	if (panel.workspace === undefined) return null;
	const label = t.agent.header.panel;
	return (
		<button
			type="button"
			className="icon-btn ws-toggle"
			aria-label={label}
			title={`${label} (${t.agent.header.panelKeys})`}
			aria-expanded={panel.prefs.open}
			aria-keyshortcuts="Alt+Shift+E"
			onClick={() => panel.toggle()}
			data-id="session-panel-toggle"
		>
			<svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<path d="M15 4v16" />
			</svg>
		</button>
	);
}

/** The panel, loaded on first open; nothing renders while it loads (the header's button says it is open). */
export function WorkspacePanelHost(props: WorkspacePanelProps) {
	return (
		<Suspense fallback={null}>
			<WorkspacePanel {...props} />
		</Suspense>
	);
}

// The terminal dock's layout: tabs, each a tree of splits whose leaves are
// panes showing one terminal session of the machine, and which pane has the
// keyboard. Pure functions over immutable values, plus the store that keeps
// a machine's layout in IndexedDB between visits. Storage is best effort: a
// browser without IndexedDB (or one that refuses it, like private modes)
// keeps the layout in memory for the page's lifetime and the dock works the
// same. Only session ids and sizes are stored, never terminal content.

export type SplitDir = "row" | "column";

export interface PaneNode {
	readonly kind: "pane";
	readonly id: string;
	readonly session: number;
	/** The session's AI runs in it: closing the pane only detaches (the session goes on). */
	readonly ai?: true;
}

export interface SplitNode {
	readonly kind: "split";
	readonly id: string;
	/** "row": side by side; "column": one above the other. */
	readonly dir: SplitDir;
	/** Share of the first child, 0.1 to 0.9. */
	readonly ratio: number;
	readonly a: LayoutNode;
	readonly b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export interface TerminalTab {
	readonly id: string;
	readonly root: LayoutNode;
	/** The pane with the keyboard. */
	readonly focus: string;
}

export interface DockLayout {
	readonly tabs: readonly TerminalTab[];
	/** The tab shown ("" with no tabs). */
	readonly active: string;
}

export const EMPTY_LAYOUT: DockLayout = { tabs: [], active: "" };

/** Panes in a tab at most (a phone shows one at a time anyway). */
export const MAX_PANES = 8;
const MAX_TABS = 20;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

let counter = 0;

/** A new id for a tab, pane or split. */
export function newId(prefix: string): string {
	counter += 1;
	const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
	return `${prefix}-${random}-${counter}`;
}

export function panesOf(node: LayoutNode): PaneNode[] {
	return node.kind === "pane" ? [node] : [...panesOf(node.a), ...panesOf(node.b)];
}

/** The pane showing the session's AI, if any. */
export function aiPane(layout: DockLayout): PaneNode | null {
	for (const tab of layout.tabs) for (const pane of panesOf(tab.root)) if (pane.ai === true) return pane;
	return null;
}

/** Pane `paneId` shares its tab with others: it gets a close button of its own (a lone pane closes with its tab). */
export function isSplitPane(layout: DockLayout, paneId: string): boolean {
	return layout.tabs.some((tab) => tab.root.kind === "split" && panesOf(tab.root).some((p) => p.id === paneId));
}

/** Every session the layout shows. */
export function sessionsOf(layout: DockLayout): Set<number> {
	return new Set(layout.tabs.flatMap((tab) => panesOf(tab.root).map((p) => p.session)));
}

export function activeTab(layout: DockLayout): TerminalTab | null {
	return layout.tabs.find((t) => t.id === layout.active) ?? layout.tabs[0] ?? null;
}

/** Only the tab running the session's AI, shown (a phone shows a session one terminal, its AI); no tab without it. */
export function aiOnly(layout: DockLayout): DockLayout {
	const tab = layout.tabs.find((x) => panesOf(x.root).some((p) => p.ai === true));
	return tab === undefined ? EMPTY_LAYOUT : { tabs: [tab], active: tab.id };
}

/** A new tab with one pane showing `session`, made the active one. */
export function addTab(layout: DockLayout, session: number, ai = false): DockLayout {
	const pane: PaneNode = { kind: "pane", id: newId("pane"), session, ...(ai ? { ai: true as const } : {}) };
	const tab: TerminalTab = { id: newId("tab"), root: pane, focus: pane.id };
	return { tabs: [...layout.tabs, tab].slice(-MAX_TABS), active: tab.id };
}

function mapTab(layout: DockLayout, tabId: string, change: (tab: TerminalTab) => TerminalTab): DockLayout {
	return { ...layout, tabs: layout.tabs.map((t) => (t.id === tabId ? change(t) : t)) };
}

function replaceNode(node: LayoutNode, id: string, make: (found: LayoutNode) => LayoutNode): LayoutNode {
	if (node.id === id) return make(node);
	if (node.kind === "pane") return node;
	const a = replaceNode(node.a, id, make);
	const b = replaceNode(node.b, id, make);
	return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Splits pane `paneId` of the active tab: the new pane (showing `session`) goes right of or below it and gets the keyboard. */
export function splitPane(layout: DockLayout, paneId: string, dir: SplitDir, session: number): DockLayout {
	const tab = activeTab(layout);
	if (tab === null || panesOf(tab.root).length >= MAX_PANES) return layout;
	const pane: PaneNode = { kind: "pane", id: newId("pane"), session };
	return mapTab(layout, tab.id, (t) => ({
		...t,
		root: replaceNode(t.root, paneId, (found) => ({ kind: "split", id: newId("split"), dir, ratio: 0.5, a: found, b: pane })),
		focus: pane.id,
	}));
}

function removeNode(node: LayoutNode, paneId: string): LayoutNode | null {
	if (node.kind === "pane") return node.id === paneId ? null : node;
	const a = removeNode(node.a, paneId);
	const b = removeNode(node.b, paneId);
	if (a === null) return b;
	if (b === null) return a;
	return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Closes a pane; its tab closes with its last pane, and a neighbour takes the keyboard. */
export function closePane(layout: DockLayout, paneId: string): DockLayout {
	const tab = layout.tabs.find((t) => panesOf(t.root).some((p) => p.id === paneId));
	if (tab === undefined) return layout;
	const root = removeNode(tab.root, paneId);
	if (root === null) {
		const index = layout.tabs.indexOf(tab);
		const tabs = layout.tabs.filter((t) => t !== tab);
		const active = layout.active === tab.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? "") : layout.active;
		return { tabs, active };
	}
	const order = panesOf(tab.root).map((p) => p.id);
	const left = panesOf(root);
	const at = order.indexOf(paneId);
	const focus = tab.focus === paneId ? (left[Math.max(0, Math.min(at - 1, left.length - 1))]?.id ?? left[0]?.id ?? "") : tab.focus;
	return mapTab(layout, tab.id, (t) => ({ ...t, root, focus }));
}

/** Closes every pane showing `session` (it ended or is gone). */
export function closeSession(layout: DockLayout, session: number): DockLayout {
	let next = layout;
	for (const tab of layout.tabs) for (const pane of panesOf(tab.root)) if (pane.session === session) next = closePane(next, pane.id);
	return next;
}

/** Pane `paneId` shows `session` instead (a new shell after the old one ended). */
export function setPaneSession(layout: DockLayout, paneId: string, session: number): DockLayout {
	return {
		...layout,
		tabs: layout.tabs.map((t) => ({ ...t, root: replaceNode(t.root, paneId, (found) => (found.kind === "pane" ? { ...found, session } : found)) })),
	};
}

export function setRatio(layout: DockLayout, splitId: string, ratio: number): DockLayout {
	const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
	return {
		...layout,
		tabs: layout.tabs.map((t) => ({ ...t, root: replaceNode(t.root, splitId, (found) => (found.kind === "split" ? { ...found, ratio: clamped } : found)) })),
	};
}

export function focusPane(layout: DockLayout, paneId: string): DockLayout {
	const tab = layout.tabs.find((t) => panesOf(t.root).some((p) => p.id === paneId));
	if (tab === undefined || (tab.focus === paneId && layout.active === tab.id)) return layout;
	return { ...mapTab(layout, tab.id, (t) => ({ ...t, focus: paneId })), active: tab.id };
}

/** The next (+1) or previous (-1) pane of the active tab gets the keyboard. */
export function cycleFocus(layout: DockLayout, delta: number): DockLayout {
	const tab = activeTab(layout);
	if (tab === null) return layout;
	const list = panesOf(tab.root);
	const at = list.findIndex((p) => p.id === tab.focus);
	const next = list[(at + delta + list.length) % list.length];
	return next === undefined ? layout : focusPane(layout, next.id);
}

export function selectTab(layout: DockLayout, index: number): DockLayout {
	const tab = layout.tabs[index];
	return tab === undefined || tab.id === layout.active ? layout : { ...layout, active: tab.id };
}

export function cycleTab(layout: DockLayout, delta: number): DockLayout {
	if (layout.tabs.length === 0) return layout;
	const at = Math.max(0, layout.tabs.findIndex((t) => t.id === layout.active));
	return selectTab(layout, (at + delta + layout.tabs.length) % layout.tabs.length);
}

/** The layout without the panes of sessions the machine no longer has. */
export function prune(layout: DockLayout, alive: ReadonlySet<number>): DockLayout {
	let next = layout;
	for (const session of sessionsOf(layout)) if (!alive.has(session)) next = closeSession(next, session);
	return next;
}

/**
 * A stored layout as the machine has it now: a pane keeps its session only while the machine still has it for the
 * same owner. The machine numbers its sessions from 1 again when its terminal process restarts (an update), so a
 * stored number may now be another session's AI: an AI pane shows only `threadId`'s AI, a shell pane only a shell.
 */
export function pruneForScope(layout: DockLayout, sessions: readonly { readonly session: number; readonly threadId: string }[], threadId: string | undefined): DockLayout {
	const owner = new Map(sessions.map((s) => [s.session, s.threadId]));
	let next = layout;
	for (const tab of layout.tabs)
		for (const pane of panesOf(tab.root)) {
			const has = owner.get(pane.session);
			const expected = pane.ai === true ? threadId : "";
			if (has === undefined || has !== expected) next = closePane(next, pane.id);
		}
	return next;
}

// --- reading back what was stored ------------------------------------------------------

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 80;
}

function parseNode(value: unknown, depth: number, seen: Set<string>): LayoutNode | null {
	if (depth > MAX_PANES || typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (!isId(v.id) || seen.has(v.id)) return null;
	seen.add(v.id);
	if (v.kind === "pane") {
		const session = v.session;
		if (typeof session !== "number" || !Number.isInteger(session) || session < 1 || session > 0xffffffff) return null;
		return { kind: "pane", id: v.id, session, ...(v.ai === true ? { ai: true as const } : {}) };
	}
	if (v.kind !== "split" || (v.dir !== "row" && v.dir !== "column") || typeof v.ratio !== "number" || !Number.isFinite(v.ratio)) return null;
	const a = parseNode(v.a, depth + 1, seen);
	const b = parseNode(v.b, depth + 1, seen);
	if (a === null || b === null) return null;
	return { kind: "split", id: v.id, dir: v.dir, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, v.ratio)), a, b };
}

/** A stored layout, checked; null when it is not one (an older shape, or damaged). */
export function parseLayout(value: unknown): DockLayout | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.tabs) || v.tabs.length > MAX_TABS || typeof v.active !== "string") return null;
	const seen = new Set<string>();
	const tabs: TerminalTab[] = [];
	for (const raw of v.tabs as unknown[]) {
		if (typeof raw !== "object" || raw === null) return null;
		const t = raw as Record<string, unknown>;
		if (!isId(t.id) || seen.has(t.id)) return null;
		seen.add(t.id);
		const root = parseNode(t.root, 0, seen);
		if (root === null || panesOf(root).length > MAX_PANES) return null;
		const list = panesOf(root);
		const focus = typeof t.focus === "string" && list.some((p) => p.id === t.focus) ? t.focus : (list[0]?.id ?? "");
		tabs.push({ id: t.id, root, focus });
	}
	const active = tabs.some((t) => t.id === v.active) ? v.active : (tabs[0]?.id ?? "");
	return { tabs, active };
}

// --- the store ---------------------------------------------------------------------------

export interface LayoutStore {
	load(machine: string): Promise<DockLayout | null>;
	save(machine: string, layout: DockLayout): Promise<void>;
}

const DATABASE = "terminal-layout";
const STORE = "layouts";

function promised<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/**
 * The layouts in IndexedDB (`factory`: the browser's indexedDB; tests pass
 * a fake or undefined). Any storage failure falls back to memory: loading
 * then finds what this page saved, saving never rejects.
 */
export function layoutStore(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): LayoutStore {
	const memory = new Map<string, DockLayout>();
	let database: Promise<IDBDatabase | null> | null = null;
	const open = (): Promise<IDBDatabase | null> => {
		database ??= (async () => {
			if (factory === undefined) return null;
			try {
				const request = factory.open(DATABASE, 1);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
				};
				return await promised(request);
			} catch {
				return null;
			}
		})();
		return database;
	};
	return {
		async load(machine) {
			const kept = memory.get(machine);
			if (kept !== undefined) return kept;
			try {
				const db = await open();
				if (db === null) return null;
				const value: unknown = await promised(db.transaction(STORE, "readonly").objectStore(STORE).get(machine));
				return parseLayout(value);
			} catch {
				return null;
			}
		},
		async save(machine, layout) {
			memory.set(machine, layout);
			try {
				const db = await open();
				if (db === null) return;
				await promised(db.transaction(STORE, "readwrite").objectStore(STORE).put(layout, machine));
			} catch {
				// Storage refused (quota, private mode): this page still has it in memory.
			}
		},
	};
}

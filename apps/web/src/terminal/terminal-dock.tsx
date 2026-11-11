// The machine's terminals, compact like Orca's dock: tabs on top, each split
// into panes side by side or stacked (each pane with its own close button),
// the path pill ("Trực tiếp 12 ms" / "Qua relay 85 ms") in the same row. Two
// scopes: a session opened in terminal mode (/ai/:machine/s/:id/terminal),
// whose first pane is its AI's own CLI and whose other panes are shells in
// its folder; and the machine's plain shells (/ai/:machine/terminal, where
// ?new=<folder> opens one more). Closing the AI's pane only detaches: the
// AI keeps running on the machine until "Kết thúc"; closing a shell's last
// pane hangs it up. Sessions live on the machine; the open tabs and splits
// of each scope come back on the next visit (IndexedDB, best effort). One
// terminal link per machine carries every pane. On a touch screen the dock covers the visible part of
// the screen above the phone keyboard (visualViewport), typing goes through
// an input that handles Vietnamese input methods, and a key bar adds Esc,
// Tab, Ctrl, Alt and the arrows. This module and xterm load only when a
// terminal opens.
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ErrorReason, type TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { brand } from "../brand.ts";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import type { LinkHub } from "../machines/link/link-hub.ts";
import { LOCAL_REF } from "../machines/link/link-hub.ts";
import { RemoteError, type MachineLink } from "../machines/link/machine-link.ts";
import { errorText, useHub, useLink } from "../machines/use-machines.ts";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import { Icon } from "../components/screen-icons.tsx";
import { navigate, Link, paths } from "../router.tsx";
import { ImeInput } from "./ime-input.tsx";
import { latencyProbe } from "./latency-probe.ts";
import { keySequence, MobileKeyBar, withModifiers, type BarKey, type Modifier, type Modifiers } from "./mobile-key-bar.tsx";
import { StatusPill } from "./status-pill.tsx";
import { browserPeers, defaultIceServers, TerminalLink } from "./terminal-link.ts";
import {
	activeTab,
	addTab,
	aiPane,
	closePane,
	closeSession,
	cycleFocus,
	cycleTab,
	EMPTY_LAYOUT,
	focusPane,
	layoutStore,
	panesOf,
	prune,
	selectTab,
	sessionsOf,
	setPaneSession,
	setRatio,
	splitPane,
	type DockLayout,
	type LayoutStore,
	type PaneNode,
} from "./terminal-layout.ts";
import { TerminalSplits } from "./terminal-splits.tsx";
import { shortcutOf, TerminalTabs, type DockAction } from "./terminal-tabs.tsx";
import { TerminalView, type PaneHandle } from "./terminal-view.tsx";
import "./terminal.css";

const SAVE_DELAY_MS = 300;
const encoder = new TextEncoder();

// --- one terminal link per machine, for the hub's lifetime ------------------------------

const linksOfHub = new WeakMap<LinkHub, Map<string, TerminalLink>>();

/** STUN servers: VITE_TERMINAL_STUN ("host:port,host:port", "" for none) or the relay's own. */
function iceServers(): { urls: string }[] {
	const configured = import.meta.env.VITE_TERMINAL_STUN;
	if (configured === undefined) return defaultIceServers(brand.domain);
	return configured
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[A-Za-z0-9.-]+:[0-9]{1,5}$/.test(s))
		.slice(0, 4)
		.map((s) => ({ urls: `stun:${s}` }));
}

export function terminalLinkFor(hub: LinkHub, ref: string): TerminalLink {
	let links = linksOfHub.get(hub);
	if (links === undefined) {
		links = new Map();
		linksOfHub.set(hub, links);
	}
	let link = links.get(ref);
	if (link === undefined) {
		link = new TerminalLink({ carrier: hub.terminalCarrier(ref), peers: browserPeers(), iceServers: iceServers() });
		links.set(ref, link);
	}
	return link;
}

let sharedStore: LayoutStore | null = null;

function defaultStore(): LayoutStore {
	sharedStore ??= layoutStore();
	return sharedStore;
}

function isTouch(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

function isMac(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** Why a terminal could not open, in the user's language (a refusal names the terminal, not the AI). */
function openErrorText(t: MachinesCopy, err: unknown): string {
	if (err instanceof RemoteError && err.reason === ErrorReason.ACCESS_DENIED) return t.terminal.failed.refused;
	return errorText(t, err, "");
}

// --- the page ----------------------------------------------------------------------------

/** The session a dock shows in terminal mode: its AI's CLI, and shells in its folder. */
export interface DockThread {
	readonly id: string;
	readonly dir: string;
	/** Back to the chat view (phones, where the dock covers the session header). */
	readonly chat: string;
}

/**
 * The lazily loaded entry: the machine's link and terminal link from the hub.
 * `thread`: a session in terminal mode; otherwise the machine's plain shells,
 * opening one more in `openShellIn` ("" for the home folder) when set.
 */
export default function TerminalScreen({ machine, thread, openShellIn }: { machine: string; thread?: DockThread | undefined; openShellIn?: string | undefined }) {
	const hub = useHub();
	const [link, state] = useLink(hub, machine);
	const terminal = terminalLinkFor(hub, machine);
	const machinePage = machine === LOCAL_REF ? paths.machines() : paths.machine(machine);
	return (
		<TerminalDock
			machine={machine}
			link={link}
			online={state.status.kind === "open"}
			terminal={terminal}
			back={thread === undefined ? machinePage : undefined}
			thread={thread}
			openShellIn={openShellIn}
			// The request is done: the address goes back to the plain terminal page.
			onShellOpened={() => navigate(paths.machineTerminal(machine), { replace: true })}
		/>
	);
}

/** The path pill of the machine's terminal, for a session header in terminal mode. */
export function DockPill({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const [, state] = useLink(hub, machine);
	const terminal = terminalLinkFor(hub, machine);
	const status = useSyncExternalStore(terminal.subscribe, terminal.status);
	return <StatusPill t={t.terminal} status={status} online={state.status.kind === "open"} />;
}

export interface TerminalDockProps {
	machine: string;
	/** The machine's main link (opening, listing and closing sessions). */
	link: MachineLink;
	online: boolean;
	terminal: TerminalLink;
	/** The back button's target; none in a session (its header has one), except on phones. */
	back?: string | undefined;
	thread?: DockThread | undefined;
	openShellIn?: string | undefined;
	onShellOpened?: () => void;
	store?: LayoutStore;
	touch?: boolean;
}

export function TerminalDock({ machine, link, online, terminal, back, thread, openShellIn, onShellOpened, store = defaultStore(), touch = isTouch() }: TerminalDockProps) {
	const t = useMachinesCopy();
	const tt = t.terminal;
	const status = useSyncExternalStore(terminal.subscribe, terminal.status);
	const [layout, setLayout] = useState<DockLayout>(EMPTY_LAYOUT);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [titles, setTitles] = useState<ReadonlyMap<number, string>>(() => new Map());
	const [ended, setEnded] = useState<ReadonlyMap<number, number>>(() => new Map());
	const [listed, setListed] = useState<readonly TermSessionInfo[]>([]);
	const [mods, setMods] = useState<Modifiers>({ ctrl: false, alt: false });
	const [caret, setCaret] = useState<ReturnType<PaneHandle["caret"]>>(null);
	const [probe] = useState(() => latencyProbe());
	const [mac] = useState(isMac);
	const handles = useRef(new Map<string, PaneHandle>());
	const ime = useRef<HTMLTextAreaElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const autoOpened = useRef(false);
	const shellOpening = useRef(false);
	/** Each scope keeps its own tabs. */
	const scope = thread === undefined ? machine : `${machine}/s/${thread.id}`;
	const threadId = thread?.id;
	/** Shells start in the session's folder, or the home folder. */
	const shellDir = thread?.dir ?? "";

	useEffect(() => {
		terminal.start();
		return () => terminal.release();
	}, [terminal]);

	// The stored layout, without the sessions the machine no longer has.
	useEffect(() => {
		if (!online || ready) return;
		let live = true;
		void (async () => {
			const stored = await store.load(scope);
			let list: readonly TermSessionInfo[] | null = null;
			try {
				const frame = await link.request({ case: "termListRequest", value: {} });
				if (frame.body.case === "termListResult") list = frame.body.value.sessions;
			} catch (err) {
				if (live) setNotice(openErrorText(t, err));
			}
			if (!live) return;
			// Without the machine's list the stored layout stays as it is (a session that is gone says so when attached).
			setListed(list ?? []);
			setLayout(list === null ? (stored ?? EMPTY_LAYOUT) : prune(stored ?? EMPTY_LAYOUT, new Set(list.map((s) => s.session))));
			setReady(true);
		})();
		return () => {
			live = false;
		};
	}, [online, ready, scope, link, store, t]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => void store.save(scope, layout), SAVE_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [ready, layout, scope, store]);

	/** A shell in `cwd`, or (`ai`) the session's AI: the machine picks what runs for it, this page names only the session. */
	const openSession = async (cwd = shellDir, ai = false): Promise<number | null> => {
		setBusy(true);
		setNotice("");
		try {
			const value = ai && threadId !== undefined ? { cols: 80, rows: 24, cwd: "", aiSession: { threadId } } : { cols: 80, rows: 24, cwd };
			const frame = await link.request({ case: "termOpen", value });
			if (frame.body.case !== "termOpened") throw new Error("the machine did not open a terminal");
			return frame.body.value.session;
		} catch (err) {
			setNotice(openErrorText(t, err));
			return null;
		} finally {
			setBusy(false);
		}
	};

	const closeSessionOnMachine = (session: number) => {
		link.request({ case: "termClose", value: { session } }).catch(() => undefined);
	};

	/** Closes panes; a shell no pane shows any more is hung up on the machine, the AI's session only detaches. */
	const closePanes = (ids: readonly string[]) => {
		let next = layout;
		const before = sessionsOf(layout);
		const ai = new Set(layout.tabs.flatMap((x) => panesOf(x.root).filter((p) => p.ai === true).map((p) => p.session)));
		for (const id of ids) next = closePane(next, id);
		const after = sessionsOf(next);
		setLayout(next);
		for (const session of before) if (!after.has(session) && !ai.has(session)) closeSessionOnMachine(session);
	};

	/** The session's AI in a tab of its own (the one already running, if any), shown. */
	const showAi = async (): Promise<void> => {
		const shown = aiPane(layout);
		if (shown !== null) {
			setLayout((l) => focusPane(l, shown.id));
			return;
		}
		const session = await openSession(shellDir, true);
		if (session !== null) setLayout((l) => (aiPane(l) === null ? addTab(l, session, true) : l));
	};

	const run = async (action: DockAction): Promise<void> => {
		const tab = activeTab(layout);
		switch (action.kind) {
			case "new-tab": {
				const session = await openSession();
				if (session !== null) setLayout((l) => addTab(l, session));
				return;
			}
			case "split": {
				if (tab === null) return run({ kind: "new-tab" });
				const pane = tab.focus;
				const session = await openSession();
				if (session !== null) setLayout((l) => splitPane(l, pane, action.dir, session));
				return;
			}
			case "close-pane":
				if (tab !== null) closePanes([tab.focus]);
				return;
			case "tab":
				setLayout((l) => cycleTab(l, action.delta));
				return;
			case "tab-index":
				setLayout((l) => selectTab(l, action.index));
				return;
			case "pane":
				setLayout((l) => cycleFocus(l, action.delta));
				return;
		}
	};

	// A session opens with its AI; a machine with no terminal open here starts with one shell.
	const openFirst = useEffectEvent(() => {
		if (threadId !== undefined) void showAi();
		else if (openShellIn === undefined && layout.tabs.length === 0) void run({ kind: "new-tab" });
	});
	useEffect(() => {
		if (!ready || autoOpened.current) return;
		autoOpened.current = true;
		openFirst();
	}, [ready]);

	// "Terminal mới" from a menu: one more shell in that folder.
	const openShell = useEffectEvent(async (cwd: string) => {
		shellOpening.current = true;
		const session = await openSession(cwd);
		shellOpening.current = false;
		if (session !== null) setLayout((l) => addTab(l, session));
		onShellOpened?.();
	});
	useEffect(() => {
		if (!ready || openShellIn === undefined || shellOpening.current) return;
		void openShell(openShellIn);
	}, [ready, openShellIn]);

	// Shortcuts anywhere in the dock (xterm lets them through, see onShortcut below).
	const onKey = useEffectEvent((event: KeyboardEvent) => {
		const action = shortcutOf(event);
		if (action === null) return;
		event.preventDefault();
		void run(action);
	});
	useEffect(() => {
		const el = root.current;
		if (el === null) return;
		el.addEventListener("keydown", onKey);
		return () => el.removeEventListener("keydown", onKey);
	}, []);

	// On a touch screen the dock fills what the phone keyboard leaves visible.
	useEffect(() => {
		const vv = window.visualViewport;
		const el = root.current;
		if (!touch || vv === null || vv === undefined || el === null) return;
		const update = () => {
			el.style.setProperty("--tx-vh", `${Math.round(vv.height)}px`);
			el.style.setProperty("--tx-vt", `${Math.round(vv.offsetTop)}px`);
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, [touch]);

	const tab = activeTab(layout);
	const focused = tab === null ? null : (panesOf(tab.root).find((p) => p.id === tab.focus) ?? null);
	const shown = sessionsOf(layout);
	const titleOf = (session: number, index: number) => titles.get(session) || tt.tabTitle(index + 1);
	// A session's dock lists the shells and its own AI; the machine's lists the shells.
	const hidden = listed.filter((s) => !shown.has(s.session) && (s.threadId === "" || s.threadId === threadId));

	const send = (text: string) => {
		if (focused === null || text === "") return;
		const out = withModifiers(text, mods);
		if (mods.ctrl || mods.alt) setMods({ ctrl: false, alt: false });
		probe?.key(focused.session);
		terminal.input(focused.session, encoder.encode(out));
	};
	const barKey = (key: BarKey) => {
		const handle = focused === null ? undefined : handles.current.get(focused.id);
		send(keySequence(key, handle?.appCursor() ?? false));
	};
	const toggle = (mod: Modifier) => setMods((m) => ({ ...m, [mod]: !m[mod] }));
	const tapPane = (pane: PaneNode) => {
		setLayout((l) => focusPane(l, pane.id));
		if (!touch) return;
		setCaret(handles.current.get(pane.id)?.caret() ?? null);
		ime.current?.focus();
	};
	/** After its program ended: a new shell in the pane, or the session's AI again. */
	const restart = async (pane: PaneNode) => {
		const session = await openSession(shellDir, pane.ai === true);
		if (session === null) return;
		closeSessionOnMachine(pane.session);
		setLayout((l) => setPaneSession(l, pane.id, session));
	};

	const renderPane = (pane: PaneNode): ReactNode => {
		const isFocused = focused?.id === pane.id;
		const code = ended.get(pane.session);
		const closeLabel = pane.ai === true ? tt.closePaneAi : tt.closePane;
		return (
			<div className="tx-pane-in" data-focused={isFocused ? "" : undefined} onPointerUp={() => tapPane(pane)}>
				<TerminalView
					key={pane.session}
					link={terminal}
					session={pane.session}
					focused={isFocused}
					touch={touch}
					label={tt.screenLabel(titles.get(pane.session) ?? "")}
					probe={probe}
					onFocus={() => setLayout((l) => focusPane(l, pane.id))}
					onTitle={(text) => setTitles((m) => new Map(m).set(pane.session, text))}
					onExit={(exit) => setEnded((m) => new Map(m).set(pane.session, exit))}
					onGone={() => {
						setLayout((l) => closeSession(l, pane.session));
						setNotice(tt.gone);
					}}
					onShortcut={(event) => shortcutOf(event) !== null}
					register={(handle) => {
						if (handle === null) handles.current.delete(pane.id);
						else handles.current.set(pane.id, handle);
					}}
				/>
				{code !== undefined && (
					<div className="tx-ended" role="status">
						<span>{tt.exited(code)}</span>
						<button type="button" className="btn btn-sm" onClick={() => closePanes([pane.id])}>
							{tt.closePane}
						</button>
						<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void restart(pane)}>
							{pane.ai === true ? tt.reopenAi : tt.newShell}
						</button>
					</div>
				)}
				{/* After the terminal, so xterm's layers never cover it. */}
<button
	type="button"
	className="tx-pane-x"
	aria-label={closeLabel}
	title={closeLabel}
	// The tap closes the pane; it does not focus it first.
	onPointerUp={(event) => event.stopPropagation()}
	onClick={() => closePanes([pane.id])}
>
	<Icon name="x" small />
</button>
{touch && isFocused && <ImeInput label={tt.typeHere} inputRef={ime} at={caret} onSend={send} appCursor={() => handles.current.get(pane.id)?.appCursor() ?? false} />}
			</div>
		);
	};

	const relayNote = status.kind === "open" && status.path === "relay" && status.directIssue !== "";
	return (
		<div className={touch ? "tx-dock touch" : "tx-dock"} ref={root} data-id="terminal-dock">
			<TerminalTabs
				t={tt}
				back={back ?? (touch ? thread?.chat : undefined)}
				backLabel={t.back}
				tabs={layout.tabs.map((x, i) => {
					const pane = panesOf(x.root).find((p) => p.id === x.focus);
					return { id: x.id, title: pane === undefined ? tt.tabTitle(i + 1) : titleOf(pane.session, i) };
				})}
				active={tab?.id ?? ""}
				hidden={hidden}
				busy={busy || !online}
				mac={mac}
				// A session shows the pill in its header.
				pill={thread === undefined ? <StatusPill t={tt} status={status} online={online} /> : null}
				onSelect={(id) => setLayout((l) => ({ ...l, active: id }))}
				onClose={(id) => {
					const closing = layout.tabs.find((x) => x.id === id);
					if (closing !== undefined) closePanes(panesOf(closing.root).map((p) => p.id));
				}}
				onAction={(action) => void run(action)}
				onReopen={(session) => setLayout((l) => addTab(l, session, threadId !== undefined && listed.some((s) => s.session === session && s.threadId === threadId)))}
				onMenu={() => {
					link.request({ case: "termListRequest", value: {} }).then(
						(frame) => {
							if (frame.body.case === "termListResult") setListed(frame.body.value.sessions);
						},
						() => undefined,
					);
				}}
			/>
			{(notice !== "" || relayNote) && (
				<p className="tx-note" role="status">
					{notice !== "" ? notice : tt.fellBack}
				</p>
			)}
			<div className="tx-body">
				{layout.tabs.map((x) => (
					<div key={x.id} className="tx-tab-body" hidden={x.id !== tab?.id}>
						<TerminalSplits root={x.root} label={() => tt.resize} renderPane={renderPane} onRatio={(id, ratio) => setLayout((l) => setRatio(l, id, ratio))} />
					</div>
				))}
				{!ready && <p className="tx-empty">{online ? t.terminal.loading : tt.offline}</p>}
				{ready && layout.tabs.length === 0 && (
					<div className="tx-empty">
						<p>{threadId !== undefined ? tt.detached : tt.none}</p>
						{threadId !== undefined ? (
							<button type="button" className="btn btn-primary btn-sm" disabled={busy || !online} onClick={() => void showAi()}>
								{tt.reopenAi}
							</button>
						) : (
							<button type="button" className="btn btn-primary btn-sm" disabled={busy || !online} onClick={() => void run({ kind: "new-tab" })}>
								{tt.newTab}
							</button>
						)}
					</div>
				)}
				{status.kind === "failed" && (
					<div className="tx-failed" role="alert">
						<p>{tt.failed[status.reason]}</p>
						{status.reason === "refused" || status.reason === "revoked" ? (
							<Link to={machine === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(machine)} className="btn btn-sm">
								{t.agent.pair}
							</Link>
						) : (
							<button type="button" className="btn btn-sm" onClick={() => terminal.retry()}>
								{tt.retry}
							</button>
						)}
					</div>
				)}
			</div>
			{touch && (
				<MobileKeyBar
					labels={{ bar: tt.keys.bar, esc: tt.keys.esc, tab: tt.keys.tab, ctrl: tt.keys.ctrl, alt: tt.keys.alt, up: tt.keys.up, down: tt.keys.down, left: tt.keys.left, right: tt.keys.right }}
					mods={mods}
					onToggle={toggle}
					onKey={barKey}
				/>
			)}
		</div>
	);
}

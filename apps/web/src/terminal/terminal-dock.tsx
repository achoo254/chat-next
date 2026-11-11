// The machine's terminals (/ai/:machine/terminal), compact like Orca's dock:
// tabs on top, each split into panes side by side or stacked, the path pill
// ("Trực tiếp 12 ms" / "Qua relay 85 ms") in the same row. Sessions live on
// the machine; this page shows them, and the open tabs and splits come back
// on the next visit (IndexedDB, best effort). One terminal link per machine
// carries every pane. On a touch screen the dock covers the visible part of
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
import { Link, paths } from "../router.tsx";
import { ImeInput } from "./ime-input.tsx";
import { latencyProbe } from "./latency-probe.ts";
import { keySequence, MobileKeyBar, withModifiers, type BarKey, type Modifier, type Modifiers } from "./mobile-key-bar.tsx";
import { StatusPill } from "./status-pill.tsx";
import { browserPeers, defaultIceServers, TerminalLink } from "./terminal-link.ts";
import {
	activeTab,
	addTab,
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

/** The lazily loaded entry: the machine's link and terminal link from the hub. */
export default function TerminalScreen({ machine }: { machine: string }) {
	const hub = useHub();
	const [link, state] = useLink(hub, machine);
	const terminal = terminalLinkFor(hub, machine);
	return <TerminalDock machine={machine} link={link} online={state.status.kind === "open"} terminal={terminal} back={machine === LOCAL_REF ? paths.machines() : paths.machine(machine)} />;
}

export interface TerminalDockProps {
	machine: string;
	/** The machine's main link (opening, listing and closing sessions). */
	link: MachineLink;
	online: boolean;
	terminal: TerminalLink;
	back: string;
	store?: LayoutStore;
	touch?: boolean;
}

export function TerminalDock({ machine, link, online, terminal, back, store = defaultStore(), touch = isTouch() }: TerminalDockProps) {
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

	useEffect(() => {
		terminal.start();
		return () => terminal.release();
	}, [terminal]);

	// The stored layout, without the sessions the machine no longer has.
	useEffect(() => {
		if (!online || ready) return;
		let live = true;
		void (async () => {
			const stored = await store.load(machine);
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
	}, [online, ready, machine, link, store, t]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => void store.save(machine, layout), SAVE_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [ready, layout, machine, store]);

	const openSession = async (): Promise<number | null> => {
		setBusy(true);
		setNotice("");
		try {
			const frame = await link.request({ case: "termOpen", value: { cols: 80, rows: 24, cwd: "" } });
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

	/** Closes panes; a session no pane shows any more is hung up on the machine. */
	const closePanes = (ids: readonly string[]) => {
		let next = layout;
		const before = sessionsOf(layout);
		for (const id of ids) next = closePane(next, id);
		const after = sessionsOf(next);
		setLayout(next);
		for (const session of before) if (!after.has(session)) closeSessionOnMachine(session);
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

	// A machine with no terminal open here starts with one.
	const openFirst = useEffectEvent(() => {
		void run({ kind: "new-tab" });
	});
	useEffect(() => {
		if (!ready || layout.tabs.length > 0 || autoOpened.current) return;
		autoOpened.current = true;
		openFirst();
	}, [ready, layout.tabs.length]);

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
	const newShell = async (pane: PaneNode) => {
		const session = await openSession();
		if (session === null) return;
		closeSessionOnMachine(pane.session);
		setLayout((l) => setPaneSession(l, pane.id, session));
	};

	const renderPane = (pane: PaneNode): ReactNode => {
		const isFocused = focused?.id === pane.id;
		const code = ended.get(pane.session);
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
						<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void newShell(pane)}>
							{tt.newShell}
						</button>
					</div>
				)}
				{touch && isFocused && <ImeInput label={tt.typeHere} inputRef={ime} at={caret} onSend={send} appCursor={() => handles.current.get(pane.id)?.appCursor() ?? false} />}
			</div>
		);
	};

	const relayNote = status.kind === "open" && status.path === "relay" && status.directIssue !== "";
	return (
		<div className={touch ? "tx-dock touch" : "tx-dock"} ref={root} data-id="terminal-dock">
			<TerminalTabs
				t={tt}
				back={back}
				backLabel={t.back}
				tabs={layout.tabs.map((x, i) => {
					const pane = panesOf(x.root).find((p) => p.id === x.focus);
					return { id: x.id, title: pane === undefined ? tt.tabTitle(i + 1) : titleOf(pane.session, i) };
				})}
				active={tab?.id ?? ""}
				hidden={listed.filter((s) => !shown.has(s.session))}
				busy={busy || !online}
				mac={mac}
				pill={<StatusPill t={tt} status={status} online={online} />}
				onSelect={(id) => setLayout((l) => ({ ...l, active: id }))}
				onClose={(id) => {
					const closing = layout.tabs.find((x) => x.id === id);
					if (closing !== undefined) closePanes(panesOf(closing.root).map((p) => p.id));
				}}
				onAction={(action) => void run(action)}
				onReopen={(session) => setLayout((l) => addTab(l, session))}
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
						<p>{tt.none}</p>
						<button type="button" className="btn btn-primary btn-sm" disabled={busy || !online} onClick={() => void run({ kind: "new-tab" })}>
							{tt.newTab}
						</button>
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

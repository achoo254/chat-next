// The dock's top row: back to the machine, one tab per terminal (its title is
// what the program set, else "Terminal N"), the "+" menu (a new terminal, a
// new session of an AI, the machine's sessions this page does not show:
// opened elsewhere, or closed tabs whose shell still runs), splitting the
// pane with the keyboard, and the path pill. The keyboard shortcuts work
// like Orca's, with Alt+Shift (⌥⇧ on macOS) so they never take a key a shell
// or the browser needs; Alt+Shift+T still opens a terminal at once.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import { usePopover } from "../machines/use-popover.ts";
import { Link } from "../router.tsx";
import { buildNewTabActions, type AgentChoice } from "./new-tab-actions.ts";
import { NewTabMenu } from "./new-tab-menu.tsx";
import type { SplitDir } from "./terminal-layout.ts";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "./terminal-font.ts";

export type DockAction =
	| { readonly kind: "new-tab" }
	| { readonly kind: "close-pane" }
	| { readonly kind: "split"; readonly dir: SplitDir }
	| { readonly kind: "tab"; readonly delta: number }
	| { readonly kind: "tab-index"; readonly index: number }
	| { readonly kind: "pane"; readonly delta: number };

/** The dock's action for a key, if it is one of its shortcuts (Alt+Shift+key, by physical key). */
export function shortcutOf(event: Pick<KeyboardEvent, "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "code">): DockAction | null {
	if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
	const digit = /^Digit([1-9])$/.exec(event.code);
	if (digit !== null) return { kind: "tab-index", index: Number(digit[1]) - 1 };
	switch (event.code) {
		case "KeyT":
			return { kind: "new-tab" };
		case "KeyW":
			return { kind: "close-pane" };
		case "KeyD":
			return { kind: "split", dir: "row" };
		case "KeyS":
			return { kind: "split", dir: "column" };
		case "BracketLeft":
			return { kind: "tab", delta: -1 };
		case "BracketRight":
			return { kind: "tab", delta: 1 };
		case "ArrowLeft":
		case "ArrowUp":
			return { kind: "pane", delta: -1 };
		case "ArrowRight":
		case "ArrowDown":
			return { kind: "pane", delta: 1 };
		default:
			return null;
	}
}

/** The shortcuts as the help lists them: the key after Alt+Shift, and what it does. */
export function shortcutList(t: MachinesCopy["terminal"]): readonly { keys: string; label: string }[] {
	return [
		{ keys: "T", label: t.newTab },
		{ keys: "D", label: t.splitRight },
		{ keys: "S", label: t.splitDown },
		{ keys: "W", label: t.closePane },
		{ keys: "[ ]", label: t.switchTab },
		{ keys: "1–9", label: t.pickTab },
		{ keys: "← →", label: t.switchPane },
	];
}

export interface TabView {
	readonly id: string;
	readonly title: string;
	/** The session's AI runs in it (its spark), not a shell. */
	readonly ai?: boolean;
}

interface TabsProps {
	t: MachinesCopy["terminal"];
	/** None in a session on a wide screen: its header has the way back. */
	back: string | undefined;
	backLabel: string;
	tabs: readonly TabView[];
	active: string;
	/** The machine's sessions no pane shows. */
	hidden: readonly TermSessionInfo[];
	/** The known AIs against the machine, for "Agent AI" in the "+" menu (none: the group is left out). */
	agents: readonly AgentChoice[];
	/** A new AI session from the menu is on its way: its rows wait. */
	startingAgent: boolean;
	/** The machine's own dock: no folder for an AI to start in (see NewTabInput.noFolder). */
	noFolder: boolean;
	busy: boolean;
	mac: boolean;
	/** The terminal text size (px) and its change (A−, A+, back to the default). */
	textSize: number;
	onTextSize(change: "bigger" | "smaller" | "reset"): void;
	pill: ReactNode | null;
	onSelect(id: string): void;
	onClose(id: string): void;
	onAction(action: DockAction): void;
	onReopen(session: number): void;
	/** A new session of the AI `provider`, opened in terminal mode. */
	onStartAgent(provider: string): void;
	/** The "+" menu opens: the machine's list of sessions is refreshed. */
	onMenu(): void;
}

export function TerminalTabs({ t, back, backLabel, tabs, active, hidden, agents, startingAgent, noFolder, busy, mac, textSize, onTextSize, pill, onSelect, onClose, onAction, onReopen, onStartAgent, onMenu }: TabsProps) {
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	// "Today" for the sessions in the menu: the moment it opened.
	const [menuAt, setMenuAt] = useState(0);
	const { open: helpOpen, setOpen: setHelpOpen, ref: helpRef } = usePopover();
	const prefix = mac ? "⌥⇧" : "Alt+Shift+";
	const actions = menuOpen
		? buildNewTabActions({ t, prefix, busy, startingAgent, noFolder, agents, hidden, now: menuAt, onNewTab: () => onAction({ kind: "new-tab" }), onStartAgent, onReopen })
		: [];
	// Closed by Esc or a click on nothing: the search field that had the focus is gone, and the focus would
	// fall to the page; it goes back to "+". An entry that ran, or a click on something focusable, keeps theirs.
	const plusRef = useRef<HTMLButtonElement>(null);
	const ranEntry = useRef(false);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (menuOpen) {
			wasOpen.current = true;
			ranEntry.current = false;
			return;
		}
		if (!wasOpen.current) return;
		wasOpen.current = false;
		const lost = document.activeElement === null || document.activeElement === document.body;
		if (!ranEntry.current && lost) plusRef.current?.focus();
	}, [menuOpen]);
	return (
		<div className="tx-head">
			{back !== undefined && (
				<Link to={back} className="icon-btn tx-back" aria-label={backLabel} title={backLabel}>
					<Icon name="back" />
				</Link>
			)}
			{/* Many tabs scroll sideways, on purpose. */}
			<div className="tx-tabs" role="tablist" aria-label={t.tabs} data-scroll-x="">
				{tabs.map((tab) => (
					<div key={tab.id} className="tx-tab" data-active={tab.id === active ? "" : undefined}>
						<button type="button" role="tab" aria-selected={tab.id === active} title={tab.title} onClick={() => onSelect(tab.id)}>
							<MachineIcon name={tab.ai === true ? "ai-session" : "terminal"} small />
							<span>{tab.title}</span>
						</button>
						<button type="button" className="tx-tab-x" aria-label={t.closeTab(tab.title)} title={t.closeTab(tab.title)} onClick={() => onClose(tab.id)}>
							<Icon name="x" small />
						</button>
					</div>
				))}
			</div>
			<div className="tx-actions">
				<div className="mx-model" ref={menuRef}>
					<button
						type="button"
						className="icon-btn"
						aria-label={t.newMenu}
						title={t.newMenu}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => {
							if (!menuOpen) {
								onMenu();
								setMenuAt(Date.now());
							}
							setMenuOpen((v) => !v);
						}}
						data-id="terminal-new"
						ref={plusRef}
					>
						<Icon name="plus" small />
					</button>
					{menuOpen && (
						<NewTabMenu
							t={t}
							actions={actions}
							onDone={() => {
								ranEntry.current = true;
								setMenuOpen(false);
							}}
						/>
					)}
				</div>
				<button type="button" className="icon-btn hide-touch" aria-label={t.splitRight} title={`${t.splitRight} (${prefix}D)`} disabled={busy} onClick={() => onAction({ kind: "split", dir: "row" })}>
					<span className="tx-split-ico to-right" aria-hidden="true" />
				</button>
				<button type="button" className="icon-btn hide-touch" aria-label={t.splitDown} title={`${t.splitDown} (${prefix}S)`} disabled={busy} onClick={() => onAction({ kind: "split", dir: "column" })}>
					<span className="tx-split-ico to-below" aria-hidden="true" />
				</button>
				<div className="mx-model hide-touch" ref={helpRef}>
					<button type="button" className="icon-btn" aria-label={t.shortcuts} aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)}>
						<Icon name="command" small />
					</button>
					{helpOpen && (
						<div className="mx-menu tx-menu mx-pop tx-help" role="dialog" aria-label={t.shortcuts}>
							<div className="tx-size" role="group" aria-label={t.textSize}>
								<span>{t.textSize}</span>
								<div className="tx-stepper">
									<button type="button" aria-label={t.smaller} title={`${t.smaller} (${mac ? "⌘" : "Ctrl+"}−)`} disabled={textSize <= FONT_SIZE_MIN} onClick={() => onTextSize("smaller")} data-id="terminal-text-smaller">
										A−
									</button>
									<button type="button" className="tx-size-now" aria-label={t.sizeReset(textSize)} title={`${t.sizeReset(textSize)} (${mac ? "⌘" : "Ctrl+"}0)`} onClick={() => onTextSize("reset")}>
										{textSize}
									</button>
									<button type="button" aria-label={t.bigger} title={`${t.bigger} (${mac ? "⌘" : "Ctrl+"}+)`} disabled={textSize >= FONT_SIZE_MAX} onClick={() => onTextSize("bigger")} data-id="terminal-text-bigger">
										A+
									</button>
								</div>
							</div>
							<hr />
							<h5>{t.shortcuts}</h5>
							<p className="tx-help-hint">{t.shortcutsHint(mac ? "⌥⇧" : "Alt+Shift")}</p>
							<dl className="tx-keys-help">
								{shortcutList(t).map((s) => (
									<div key={s.keys}>
										<dt>{s.label}</dt>
										<dd>
											<span className="sr-only">{prefix}</span>
											<kbd>{s.keys}</kbd>
										</dd>
									</div>
								))}
							</dl>
						</div>
					)}
				</div>
				{pill}
			</div>
		</div>
	);
}

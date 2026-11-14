// The dock's top row: back to the machine, one tab per terminal (its title is
// what the program set, else "Terminal N"), a new terminal, the machine's
// sessions this page does not show (opened elsewhere, or closed tabs whose
// shell still runs), splitting the pane with the keyboard, and the path pill.
// The keyboard shortcuts work like Orca's, with Alt+Shift (⌥⇧ on macOS) so
// they never take a key a shell or the browser needs.
import { useState, type ReactNode } from "react";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import { folderName } from "../machines/new-session-hints.ts";
import { usePopover } from "../machines/use-popover.ts";
import { Link } from "../router.tsx";
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

/** "21:05" today, else "12/11 21:05": when a session on the machine was opened. */
export function openedTime(ms: number, now: number): string {
	const at = new Date(ms);
	const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })} ${time}`;
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
	onMenu(): void;
}

export function TerminalTabs({ t, back, backLabel, tabs, active, hidden, busy, mac, textSize, onTextSize, pill, onSelect, onClose, onAction, onReopen, onMenu }: TabsProps) {
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	// "Today" for the sessions menu: the moment it opened.
	const [menuAt, setMenuAt] = useState(0);
	const { open: helpOpen, setOpen: setHelpOpen, ref: helpRef } = usePopover();
	const prefix = mac ? "⌥⇧" : "Alt+Shift+";
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
				<button type="button" className="icon-btn" aria-label={t.newTab} title={`${t.newTab} (${prefix}T)`} disabled={busy} onClick={() => onAction({ kind: "new-tab" })} data-id="terminal-new">
					<Icon name="plus" small />
				</button>
				<div className="mx-model" ref={menuRef}>
					<button
						type="button"
						className="icon-btn"
						aria-label={t.sessionsOnMachine}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						onClick={() => {
							if (!menuOpen) {
								onMenu();
								setMenuAt(Date.now());
							}
							setMenuOpen((v) => !v);
						}}
					>
						<MachineIcon name="chevron-down" small />
					</button>
					{menuOpen && (
						<div className="mx-menu tx-menu" role="menu" aria-label={t.sessionsOnMachine}>
							<h5>{t.sessionsOnMachine}</h5>
							{hidden.length === 0 && <p className="note">{t.noHiddenSessions}</p>}
							{hidden.map((s) => (
								<button
									key={s.session}
									type="button"
									role="menuitem"
									title={s.cwd === "" ? undefined : s.cwd}
									onClick={() => {
										setMenuOpen(false);
										onReopen(s.session);
									}}
								>
									<MachineIcon name={s.threadId === "" ? "terminal" : "ai-session"} small />
									<span>
										{s.title || (s.threadId === "" ? t.shellSession : t.aiSession)}
										<small>
											{[
												s.cwd === "" ? "" : folderName(s.cwd),
												s.createdAt > 0n ? t.openedAt(openedTime(Number(s.createdAt), menuAt)) : "",
												s.exited ? t.exitedShort(s.exitCode) : s.attached ? t.openElsewhere : t.running,
											]
												.filter((x) => x !== "")
												.join(" · ")}
										</small>
									</span>
								</button>
							))}
						</div>
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

// The dock's top row: back to the machine, one tab per terminal (its title is
// what the program set, else "Terminal N"), a new terminal, the machine's
// sessions this page does not show (opened elsewhere, or closed tabs whose
// shell still runs), splitting the pane with the keyboard, and the path pill.
// The keyboard shortcuts work like Orca's, with Alt+Shift (⌥⇧ on macOS) so
// they never take a key a shell or the browser needs.
import type { ReactNode } from "react";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import { usePopover } from "../machines/use-popover.ts";
import { Link } from "../router.tsx";
import type { SplitDir } from "./terminal-layout.ts";

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
}

interface TabsProps {
	t: MachinesCopy["terminal"];
	back: string;
	backLabel: string;
	tabs: readonly TabView[];
	active: string;
	/** The machine's sessions no pane shows. */
	hidden: readonly TermSessionInfo[];
	busy: boolean;
	mac: boolean;
	pill: ReactNode;
	onSelect(id: string): void;
	onClose(id: string): void;
	onAction(action: DockAction): void;
	onReopen(session: number): void;
	onMenu(): void;
}

export function TerminalTabs({ t, back, backLabel, tabs, active, hidden, busy, mac, pill, onSelect, onClose, onAction, onReopen, onMenu }: TabsProps) {
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	const { open: helpOpen, setOpen: setHelpOpen, ref: helpRef } = usePopover();
	const prefix = mac ? "⌥⇧" : "Alt+Shift+";
	return (
		<div className="tx-head">
			<Link to={back} className="icon-btn tx-back" aria-label={backLabel} title={backLabel}>
				<Icon name="back" />
			</Link>
			<div className="tx-tabs" role="tablist" aria-label={t.tabs}>
				{tabs.map((tab) => (
					<div key={tab.id} className="tx-tab" data-active={tab.id === active ? "" : undefined}>
						<button type="button" role="tab" aria-selected={tab.id === active} title={tab.title} onClick={() => onSelect(tab.id)}>
							<MachineIcon name="terminal" small />
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
							if (!menuOpen) onMenu();
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
									onClick={() => {
										setMenuOpen(false);
										onReopen(s.session);
									}}
								>
									<MachineIcon name="terminal" small />
									<span>
										{s.title || t.untitled(s.session)}
										<small>{s.exited ? t.exitedShort(s.exitCode) : s.attached ? t.openElsewhere : t.running}</small>
									</span>
								</button>
							))}
						</div>
					)}
				</div>
				<button type="button" className="icon-btn hide-touch" aria-label={t.splitRight} title={`${t.splitRight} (${prefix}D)`} disabled={busy} onClick={() => onAction({ kind: "split", dir: "row" })}>
					<span className="tx-split-ico row" aria-hidden="true" />
				</button>
				<button type="button" className="icon-btn hide-touch" aria-label={t.splitDown} title={`${t.splitDown} (${prefix}S)`} disabled={busy} onClick={() => onAction({ kind: "split", dir: "column" })}>
					<span className="tx-split-ico column" aria-hidden="true" />
				</button>
				<div className="mx-model hide-touch" ref={helpRef}>
					<button type="button" className="icon-btn" aria-label={t.shortcuts} aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)}>
						<Icon name="command" small />
					</button>
					{helpOpen && (
						<div className="mx-menu tx-menu mx-pop" role="dialog" aria-label={t.shortcuts}>
							<h5>{t.shortcuts}</h5>
							<dl className="tx-keys-help">
								{shortcutList(t).map((s) => (
									<div key={s.keys}>
										<dt>
											<kbd>{prefix}</kbd>
											<kbd>{s.keys}</kbd>
										</dt>
										<dd>{s.label}</dd>
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

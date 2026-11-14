// The tabs of a session's terminal on a phone, as a sheet from the bottom (the
// key row's tab button opens it): the tabs open here, then what the "+" menu
// of a computer offers (a new shell, a new session of an AI, the machine's
// sessions no tab shows, each as new-tab-actions.ts describes them). Switching
// or running an entry closes it.
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import { Icon } from "../components/screen-icons.tsx";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { buildNewTabActions, groupNewTabActions, NEW_TAB_GROUPS, type AgentChoice, type NewTabAction } from "./new-tab-actions.ts";
import { StopSessionButton } from "./stop-session-button.tsx";
import type { TabView } from "./terminal-tabs.tsx";

interface TabSheetProps {
	t: MachinesCopy["terminal"];
	tabs: readonly TabView[];
	active: string;
	/** What the "+" menu of a computer offers (new-tab-actions.ts buildNewTabActions), the sheet's second part. */
	busy: boolean;
	startingAgent: boolean;
	noFolder: boolean;
	agents: readonly AgentChoice[];
	/** The machine's sessions no tab shows. */
	hidden: readonly TermSessionInfo[];
	/** "Today" for the sessions listed: the moment the sheet opened. */
	now: number;
	onNewTab(): void;
	onStartAgent(provider: string): void;
	onReopen(session: number): void;
	/** Stops one of the machine's sessions the sheet lists. */
	onStop(session: number): void;
	onSelect(id: string): void;
	onClose(id: string): void;
	/** The sheet is done: it closes. */
	onDone(): void;
}

export function TabSheet({ t, tabs, active, busy, startingAgent, noFolder, agents, hidden, now, onNewTab, onStartAgent, onReopen, onStop, onSelect, onClose, onDone }: TabSheetProps) {
	const actions = buildNewTabActions({ t, prefix: "", busy, startingAgent, noFolder, agents, hidden, now, onNewTab, onStartAgent, onReopen, onStop });
	const run = (action: NewTabAction) => {
		if (action.disabled === true) return;
		// Closed first: an entry that navigates must not leave the sheet behind.
		onDone();
		action.run();
	};
	return (
		<div className="tx-sheet-wrap" data-id="terminal-tab-sheet">
			<button type="button" className="tx-sheet-backdrop" aria-label={t.keys.close} tabIndex={-1} onClick={onDone} />
			<div className="tx-sheet" role="dialog" aria-modal="true" aria-label={t.tabs}>
				<div className="tx-sheet-grip" aria-hidden="true" />
				<header className="tx-sheet-head">
					<span />
					<h2>{t.tabs}</h2>
					<button type="button" className="tx-sheet-nav end" onClick={onDone}>
						{t.keys.close}
					</button>
				</header>
				<div className="tx-sheet-group" role="list" aria-label={t.tabs}>
					{tabs.map((tab) => (
						<div key={tab.id} className="tx-sheet-row tab" role="listitem" data-active={tab.id === active ? "" : undefined}>
							<button
								type="button"
								className="tx-sheet-pick"
								aria-current={tab.id === active ? "true" : undefined}
								onClick={() => {
									onDone();
									onSelect(tab.id);
								}}
							>
								<MachineIcon name={tab.ai === true ? "ai-session" : "terminal"} small />
								<span>{tab.title}</span>
							</button>
							<button type="button" className="tx-sheet-x" aria-label={t.closeTab(tab.title)} title={t.closeTab(tab.title)} onClick={() => onClose(tab.id)}>
								<Icon name="x" small />
							</button>
						</div>
					))}
				</div>
				{groupNewTabActions(actions).map((group) => {
					const heading = NEW_TAB_GROUPS.find((g) => g.id === group.id)?.heading(t) ?? "";
					return (
						<section key={group.id} role="group" aria-label={heading}>
							<h3 className="tx-sheet-heading">{heading}</h3>
							<div className="tx-sheet-group">
								{group.actions.map((action) => {
									const row = (
										<>
											<MachineIcon name={action.icon} small />
											<span>
												<strong>{action.label}</strong>
												{action.hint !== undefined && <small>{action.hint}</small>}
											</span>
										</>
									);
									if (action.stop === undefined)
										return (
											<button key={action.id} type="button" className="tx-sheet-row" disabled={action.disabled === true} onClick={() => run(action)} data-id={`terminal-sheet-${action.id}`}>
												{row}
											</button>
										);
									// A machine session: reopening it is the row, stopping it the button at its end.
									return (
										<div key={action.id} className="tx-sheet-row tab">
											<button type="button" className="tx-sheet-pick" disabled={action.disabled === true} onClick={() => run(action)} data-id={`terminal-sheet-${action.id}`}>
												{row}
											</button>
											<StopSessionButton t={t} stop={action.stop} className="tx-sheet-x tx-stop" />
										</div>
									);
								})}
							</div>
						</section>
					);
				})}
			</div>
		</div>
	);
}

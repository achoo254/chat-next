// The "+" menu's body (after Orca's new-tab menu): a search field on top,
// then each group of new-tab-actions.ts under its heading. It renders only
// what the actions say; nothing here knows what a terminal or an AI is.
// The keyboard works as in a menu: ↑/↓ move between the field and the
// enabled rows, Enter in the field runs the first match, Esc (usePopover)
// closes it.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { MachineIcon } from "../machines/machine-icons.tsx";
import { filterNewTabActions, groupNewTabActions, NEW_TAB_GROUPS, type NewTabAction } from "./new-tab-actions.ts";

interface NewTabMenuProps {
	t: MachinesCopy["terminal"];
	actions: readonly NewTabAction[];
	/** The menu is done (an entry ran): its popover closes. */
	onDone(): void;
}

export function NewTabMenu({ t, actions, onDone }: NewTabMenuProps) {
	const [query, setQuery] = useState("");
	const root = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	// Ready for typing a filter at once, as Orca's is; not on a touch screen, where focus would raise the
	// phone keyboard over the sheet before anyone asked to type.
	useEffect(() => {
		const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
		if (!coarse) search.current?.focus();
	}, []);
	const shown = filterNewTabActions(actions, query);
	const groups = groupNewTabActions(shown);

	const runAction = (action: NewTabAction) => {
		if (action.disabled === true) return;
		// Closed first: an action that navigates away must not leave a popover behind.
		onDone();
		action.run();
	};

	/** ↑/↓ through the field and the rows a click would run. */
	const onArrows = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const el = root.current;
		if (el === null) return;
		const stops = [...el.querySelectorAll<HTMLElement>("input, [role=menuitem]:not(:disabled)")];
		if (stops.length === 0) return;
		event.preventDefault();
		const at = stops.indexOf(document.activeElement as HTMLElement);
		const next = event.key === "ArrowDown" ? (at + 1) % stops.length : (at - 1 + stops.length) % stops.length;
		stops[next]?.focus();
	};

	return (
		<div className="mx-menu tx-menu tx-new" ref={root} data-id="terminal-new-menu">
			<input
				className="input tx-new-search"
				type="search"
				aria-label={t.newMenuSearch}
				placeholder={t.newMenuSearch}
				value={query}
				autoComplete="off"
				ref={search}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Enter") return onArrows(event);
					const first = shown.find((a) => a.disabled !== true);
					if (first === undefined) return;
					event.preventDefault();
					runAction(first);
				}}
				data-id="terminal-new-search"
			/>
			<div role="menu" aria-label={t.newMenu} className="tx-new-list" tabIndex={-1} onKeyDown={onArrows}>
				{groups.length === 0 && <p className="note">{t.noMatch}</p>}
				{groups.map((group) => {
					const heading = NEW_TAB_GROUPS.find((g) => g.id === group.id)?.heading(t) ?? "";
					return (
						<div key={group.id} role="group" aria-label={heading}>
							<h5 aria-hidden="true">{heading}</h5>
							{group.actions.map((action) => (
								<button
									key={action.id}
									type="button"
									role="menuitem"
									title={action.title}
									disabled={action.disabled === true}
									onClick={() => runAction(action)}
									data-id={`terminal-new-${action.id}`}
								>
									<MachineIcon name={action.icon} small />
									<span>
										{action.label}
										{action.hint !== undefined && <small>{action.hint}</small>}
									</span>
									{/* Shown, not part of the row's name: the row is "Terminal mới", its shortcut a reminder. */}
									{action.shortcut !== undefined && (
										<kbd className="tx-new-key" aria-hidden="true">
											{action.shortcut}
										</kbd>
									)}
								</button>
							))}
						</div>
					);
				})}
			</div>
		</div>
	);
}

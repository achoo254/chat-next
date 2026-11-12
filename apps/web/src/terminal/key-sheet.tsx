// The key row's "more" sheet on a phone (after Orca's "Add Shortcut"): keys
// the row does not carry (Del, Home, F1 to F12), a combo of Ctrl, Alt and
// Shift with one key, a text macro, and managing the row (show, hide,
// reorder, delete one's own keys, back to the default). Combos and macros
// can be sent once or kept as keys of the row (key-prefs.ts).
import { useState, type ReactNode } from "react";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import { addCustom, allKeys, comboLabel, comboSequence, EMPTY_PREFS, isCustomId, moveKey, NAMED_KEYS, removeCustom, toggleHidden, type ComboMods, type KeyPrefs, type NamedKey } from "./key-prefs.ts";
import { keepFocus, keySequence, keyText, MORE_KEYS, type BarKey } from "./mobile-key-bar.tsx";

type Labels = MachinesCopy["terminal"]["keys"];
type View = "menu" | "more" | "combo" | "macro" | "manage";

const NAMED_TEXT: Record<NamedKey, string> = {
	enter: "Enter",
	tab: "Tab",
	esc: "Esc",
	backspace: "⌫",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	home: "Home",
	end: "End",
	delete: "Del",
	"page-up": "PgUp",
	"page-down": "PgDn",
	f1: "F1",
	f2: "F2",
	f3: "F3",
	f4: "F4",
	f5: "F5",
	f6: "F6",
	f7: "F7",
	f8: "F8",
	f9: "F9",
	f10: "F10",
	f11: "F11",
	f12: "F12",
};

interface KeySheetProps {
	t: Labels;
	prefs: KeyPrefs;
	onPrefs(next: KeyPrefs): void;
	/** Sends bytes as they are (no held Ctrl or Alt). */
	onSend(text: string): void;
	appCursor(): boolean;
	onClose(): void;
}

export function KeySheet({ t, prefs, onPrefs, onSend, appCursor, onClose }: KeySheetProps) {
	const [view, setView] = useState<View>("menu");
	const title = view === "menu" ? t.sheet : view === "more" ? t.moreKeys : view === "combo" ? t.combo : view === "macro" ? t.macro : t.manage;
	return (
		<div className="tx-sheet-wrap" data-id="terminal-key-sheet">
			<button type="button" className="tx-sheet-backdrop" aria-label={t.close} tabIndex={-1} onClick={onClose} />
			<div className="tx-sheet" role="dialog" aria-modal="true" aria-label={title}>
				<div className="tx-sheet-grip" aria-hidden="true" />
				<header className="tx-sheet-head">
					{view !== "menu" ? (
						<button type="button" className="tx-sheet-nav" onClick={() => setView("menu")}>
							‹ {t.back}
						</button>
					) : (
						<span />
					)}
					<h2>{title}</h2>
					<button type="button" className="tx-sheet-nav end" onClick={onClose}>
						{t.close}
					</button>
				</header>
				{view === "menu" && (
					<div className="tx-sheet-group">
						<Row title={t.moreKeys} hint={t.moreKeysHint} onClick={() => setView("more")} />
						<Row title={t.combo} hint={t.comboHint} onClick={() => setView("combo")} />
						<Row title={t.macro} hint={t.macroHint} onClick={() => setView("macro")} />
						<Row title={t.manage} hint={t.manageHint} onClick={() => setView("manage")} />
					</div>
				)}
				{view === "more" && <MoreKeys onKey={(key) => onSend(keySequence(key, appCursor()))} />}
				{view === "combo" && (
					<Combo
						t={t}
						onSend={onSend}
						onKeep={(label, send) => {
							onPrefs(addCustom(prefs, label, send));
							setView("manage");
						}}
					/>
				)}
				{view === "macro" && (
					<Macro
						t={t}
						onSend={onSend}
						onKeep={(label, send) => {
							onPrefs(addCustom(prefs, label, send));
							setView("manage");
						}}
					/>
				)}
				{view === "manage" && <Manage t={t} prefs={prefs} onPrefs={onPrefs} />}
			</div>
		</div>
	);
}

function Row({ title, hint, onClick }: { title: string; hint: string; onClick(): void }) {
	return (
		<button type="button" className="tx-sheet-row" onClick={onClick}>
			<span>
				<strong>{title}</strong>
				<small>{hint}</small>
			</span>
			<span aria-hidden="true">›</span>
		</button>
	);
}

function MoreKeys({ onKey }: { onKey(key: BarKey): void }) {
	return (
		<div className="tx-sheet-grid">
			{MORE_KEYS.map((k) => (
				// The keyboard, if up, stays up while these go to the terminal.
				<button key={k.key} type="button" className="tx-key" onMouseDown={keepFocus} onClick={() => onKey(k.key)}>
					{k.text}
				</button>
			))}
		</div>
	);
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }) {
	return (
		<button type="button" className="tx-key mod" aria-pressed={on} data-latch={on ? "once" : "off"} onClick={() => onChange(!on)}>
			{label}
		</button>
	);
}

function Combo({ t, onSend, onKeep }: { t: Labels; onSend(text: string): void; onKeep(label: string, send: string): void }) {
	const [mods, setMods] = useState<ComboMods>({ ctrl: true, alt: false, shift: false });
	const [ch, setCh] = useState("");
	const [named, setNamed] = useState<NamedKey | "">("");
	const key = named !== "" ? ({ kind: "named", name: named } as const) : ({ kind: "char", ch } as const);
	const keyName = named !== "" ? NAMED_TEXT[named] : (Array.from(ch)[0] ?? "").toUpperCase();
	const send = keyName === "" ? "" : comboSequence(mods, key);
	const label = comboLabel(mods, keyName);
	return (
		<div className="tx-sheet-form">
			<div className="tx-sheet-mods" role="group" aria-label={t.combo}>
				<Toggle on={mods.ctrl} label="Ctrl" onChange={(on) => setMods((m) => ({ ...m, ctrl: on }))} />
				<Toggle on={mods.alt} label="Alt" onChange={(on) => setMods((m) => ({ ...m, alt: on }))} />
				<Toggle on={mods.shift} label="Shift" onChange={(on) => setMods((m) => ({ ...m, shift: on }))} />
			</div>
			<label className="tx-sheet-field">
				<span>{t.key}</span>
				<input
					className="input"
					value={ch}
					maxLength={2}
					placeholder={t.keyHint}
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					onChange={(event) => {
						setCh(event.target.value.slice(-1));
						setNamed("");
					}}
				/>
			</label>
			<div className="tx-sheet-grid small">
				{NAMED_KEYS.map((name) => (
					<button key={name} type="button" className="tx-key" aria-pressed={named === name} data-latch={named === name ? "once" : "off"} onClick={() => setNamed(named === name ? "" : name)}>
						{NAMED_TEXT[name]}
					</button>
				))}
			</div>
			<SheetActions t={t} preview={keyName === "" ? "" : label} disabled={send === ""} onSend={() => onSend(send)} onKeep={() => onKeep(label, send)} />
		</div>
	);
}

function Macro({ t, onSend, onKeep }: { t: Labels; onSend(text: string): void; onKeep(label: string, send: string): void }) {
	const [label, setLabel] = useState("");
	const [text, setText] = useState("");
	const [enter, setEnter] = useState(true);
	const send = text === "" ? "" : `${text.replace(/\r?\n/g, "\r")}${enter ? "\r" : ""}`;
	const name = label.trim() || text.trim().slice(0, 12);
	return (
		<div className="tx-sheet-form">
			<label className="tx-sheet-field">
				<span>{t.text}</span>
				<textarea className="input" rows={3} value={text} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setText(event.target.value)} />
			</label>
			<label className="tx-sheet-field">
				<span>{t.label}</span>
				<input className="input" value={label} maxLength={16} onChange={(event) => setLabel(event.target.value)} />
			</label>
			<label className="tx-sheet-check">
				<input type="checkbox" checked={enter} onChange={(event) => setEnter(event.target.checked)} />
				<span>{t.withEnter}</span>
			</label>
			<SheetActions t={t} preview={name} disabled={send === ""} onSend={() => onSend(send)} onKeep={() => onKeep(name, send)} />
		</div>
	);
}

function SheetActions({ t, preview, disabled, onSend, onKeep }: { t: Labels; preview: string; disabled: boolean; onSend(): void; onKeep(): void }) {
	return (
		<div className="tx-sheet-actions">
			{preview !== "" && <span className="tx-sheet-preview">{preview}</span>}
			<button type="button" className="btn btn-sm" disabled={disabled} onClick={onKeep}>
				{t.addToRow}
			</button>
			<button type="button" className="btn btn-sm btn-primary" disabled={disabled} onClick={onSend}>
				{t.send}
			</button>
		</div>
	);
}

function Manage({ t, prefs, onPrefs }: { t: Labels; prefs: KeyPrefs; onPrefs(next: KeyPrefs): void }) {
	const keys = allKeys(prefs);
	const hidden = new Set(prefs.hidden);
	const icon = (text: ReactNode, label: string, disabled: boolean, onClick: () => void) => (
		<button type="button" className="tx-sheet-icon" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
			{text}
		</button>
	);
	return (
		<div className="tx-sheet-form">
			<ul className="tx-sheet-list">
				{keys.map((id, i) => {
					const name = keyText(id, t, prefs.custom);
					const shown = !hidden.has(id);
					return (
						<li key={id} data-hidden={shown ? undefined : ""}>
							<label className="tx-sheet-check">
								<input type="checkbox" checked={shown} aria-label={`${shown ? t.hide : t.show} ${name}`} onChange={() => onPrefs(toggleHidden(prefs, id))} />
								<span className="tx-sheet-keyname">{name}</span>
							</label>
							{icon("↑", `${t.moveUp} ${name}`, i === 0, () => onPrefs(moveKey(prefs, id, -1)))}
							{icon("↓", `${t.moveDown} ${name}`, i === keys.length - 1, () => onPrefs(moveKey(prefs, id, 1)))}
							{isCustomId(id) && icon("×", `${t.remove} ${name}`, false, () => onPrefs(removeCustom(prefs, id)))}
						</li>
					);
				})}
			</ul>
			<div className="tx-sheet-actions">
				<button type="button" className="btn btn-sm" onClick={() => onPrefs({ ...EMPTY_PREFS, custom: prefs.custom, order: [...EMPTY_PREFS.order, ...prefs.custom.map((c) => c.id)] })}>
					{t.reset}
				</button>
			</div>
		</div>
	);
}

// The phone key row as this device keeps it (Orca's "Manage Shortcuts"):
// which keys show, in what order, and the user's own keys: a combo
// (Ctrl, Alt and Shift with a key) or a text macro. Kept in localStorage,
// per device; a broken or missing value gives the default row.
import { keySequence, withModifiers, type BarKey } from "./mobile-key-bar.tsx";

/** A key of the user's own: what its button says and what it sends. */
export interface CustomKey {
	readonly id: string;
	readonly label: string;
	readonly send: string;
}

export interface KeyPrefs {
	/** Ids of the row in order: built-in keys, "ctrl", "alt", "copy", "paste" and custom ids. */
	readonly order: readonly string[];
	readonly hidden: readonly string[];
	readonly custom: readonly CustomKey[];
}

/** The built-in row, as it shipped: the AI's keys first. */
export const DEFAULT_ORDER: readonly string[] = [
	"esc",
	"tab",
	"shift-tab",
	"ctrl",
	"alt",
	"left",
	"up",
	"down",
	"right",
	"enter",
	"ctrl-c",
	"slash",
	"dash",
	"pipe",
	"tilde",
	"dollar",
	"greater",
	"backspace",
	"ctrl-d",
	"ctrl-l",
	"ctrl-r",
	"copy",
	"paste",
];

export const EMPTY_PREFS: KeyPrefs = { order: DEFAULT_ORDER, hidden: [], custom: [] };

const STORE_KEY = "terminal:keys";
const CUSTOM_PREFIX = "c:";

export const isCustomId = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

function isCustom(value: unknown): value is CustomKey {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && isCustomId(v.id) && typeof v.label === "string" && typeof v.send === "string" && v.send !== "";
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

/** Reads kept prefs; anything unreadable is left out. */
export function parsePrefs(raw: string | null): KeyPrefs {
	if (raw === null) return EMPTY_PREFS;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return EMPTY_PREFS;
	}
	if (typeof value !== "object" || value === null) return EMPTY_PREFS;
	const v = value as Record<string, unknown>;
	const custom = Array.isArray(v.custom) ? v.custom.filter(isCustom) : [];
	const order = strings(v.order);
	return { order: order.length === 0 ? DEFAULT_ORDER : order, hidden: strings(v.hidden), custom };
}

export function loadPrefs(): KeyPrefs {
	try {
		return parsePrefs(window.localStorage.getItem(STORE_KEY));
	} catch {
		return EMPTY_PREFS;
	}
}

export function savePrefs(prefs: KeyPrefs): void {
	try {
		window.localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
	} catch {
		// Private mode or no room: the row still works for this page.
	}
}

/**
 * Every key in its place: the kept order (unknown ids dropped), then
 * built-in keys a later version added and custom keys the order misses.
 */
export function allKeys(prefs: KeyPrefs): string[] {
	const known = new Set([...DEFAULT_ORDER, ...prefs.custom.map((c) => c.id)]);
	const out = prefs.order.filter((id, i) => known.has(id) && prefs.order.indexOf(id) === i);
	for (const id of known) if (!out.includes(id)) out.push(id);
	return out;
}

/** The keys the row shows, in order. */
export function rowOf(prefs: KeyPrefs): string[] {
	const hidden = new Set(prefs.hidden);
	return allKeys(prefs).filter((id) => !hidden.has(id));
}

export function toggleHidden(prefs: KeyPrefs, id: string): KeyPrefs {
	const hidden = prefs.hidden.includes(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id];
	return { ...prefs, hidden };
}

/** Moves a key one place earlier (-1) or later (+1). */
export function moveKey(prefs: KeyPrefs, id: string, delta: -1 | 1): KeyPrefs {
	const order = allKeys(prefs);
	const at = order.indexOf(id);
	const to = at + delta;
	if (at < 0 || to < 0 || to >= order.length) return prefs;
	order.splice(at, 1);
	order.splice(to, 0, id);
	return { ...prefs, order };
}

export function addCustom(prefs: KeyPrefs, label: string, send: string, id = `${CUSTOM_PREFIX}${crypto.randomUUID()}`): KeyPrefs {
	const key: CustomKey = { id, label, send };
	return { ...prefs, custom: [...prefs.custom, key], order: [...allKeys(prefs), id] };
}

export function removeCustom(prefs: KeyPrefs, id: string): KeyPrefs {
	return {
		order: prefs.order.filter((x) => x !== id),
		hidden: prefs.hidden.filter((x) => x !== id),
		custom: prefs.custom.filter((c) => c.id !== id),
	};
}

export interface ComboMods {
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

/** Keys a combo can take besides one typed character. */
export const NAMED_KEYS = [
	"enter",
	"tab",
	"esc",
	"backspace",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"delete",
	"page-up",
	"page-down",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
] as const satisfies readonly BarKey[];
export type NamedKey = (typeof NAMED_KEYS)[number];

export type ComboKey = { readonly kind: "char"; readonly ch: string } | { readonly kind: "named"; readonly name: NamedKey };

const CSI_LETTER: Partial<Record<NamedKey, string>> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F", f1: "P", f2: "Q", f3: "R", f4: "S" };
const CSI_TILDE: Partial<Record<NamedKey, number>> = { delete: 3, "page-up": 5, "page-down": 6, f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };

/**
 * What a combo sends, as xterm encodes it: a character takes Shift as its
 * capital, Ctrl as its control code, Alt as ESC before it; cursor, editing
 * and function keys carry the modifiers as a CSI parameter (1 + Shift 1 +
 * Alt 2 + Ctrl 4); Shift+Tab is CSI Z; Enter, Tab, Esc and Backspace take Alt
 * as ESC before them.
 */
export function comboSequence(mods: ComboMods, key: ComboKey): string {
	if (key.kind === "char") {
		const ch = Array.from(key.ch)[0] ?? "";
		if (ch === "") return "";
		return withModifiers(mods.shift ? ch.toUpperCase() : ch, { ctrl: mods.ctrl, alt: mods.alt });
	}
	const m = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
	const letter = CSI_LETTER[key.name];
	if (letter !== undefined) return m === 1 ? keySequence(key.name, false) : `\x1b[1;${m}${letter}`;
	const tilde = CSI_TILDE[key.name];
	if (tilde !== undefined) return m === 1 ? keySequence(key.name, false) : `\x1b[${tilde};${m}~`;
	if (key.name === "tab" && mods.shift && !mods.ctrl && !mods.alt) return "\x1b[Z";
	const plain = keySequence(key.name, false);
	return mods.alt ? `\x1b${plain}` : plain;
}

/** "Ctrl+Alt+K", "Shift+↑": what a combo's button says. */
export function comboLabel(mods: ComboMods, keyText: string): string {
	return [mods.ctrl ? "Ctrl" : "", mods.alt ? "Alt" : "", mods.shift ? "Shift" : "", keyText].filter((x) => x !== "").join("+");
}

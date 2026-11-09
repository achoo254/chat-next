/**
 * The user's input on a device (BrowserInput) as Chrome DevTools Protocol
 * commands for the tab: mouse events, a key pressed and released, or text
 * inserted. Pure: no logging, nothing kept.
 */

export const MAX_TEXT_CHARS = 1000;

export type MouseKind = "move" | "down" | "up" | "wheel";

export interface MouseAction {
	type: MouseKind;
	x: number;
	y: number;
	/** 0 left, 1 middle, 2 right. */
	button: number;
	clickCount: number;
	deltaX: number;
	deltaY: number;
	modifiers: number;
}

export interface KeyAction {
	key: string;
	code: string;
	text: string;
	modifiers: number;
}

export type InputAction = { kind: "mouse"; mouse: MouseAction } | { kind: "key"; key: KeyAction } | { kind: "text"; text: string };

export interface CdpCommand {
	method: string;
	params: Record<string, unknown>;
}

export class InputError extends Error {}

const MOUSE_TYPE: Record<MouseKind, string> = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased", wheel: "mouseWheel" };
const BUTTONS = ["left", "middle", "right"] as const;
/** The `buttons` bit of each button while it is down. */
const BUTTON_BITS = [1, 4, 2] as const;
const MAX_COORD = 100_000;
const MODIFIERS = 0b1111;
export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** Windows virtual key codes of the keys that type nothing. */
const KEY_CODES: Record<string, number> = {
	Backspace: 8,
	Tab: 9,
	Enter: 13,
	Shift: 16,
	Control: 17,
	Alt: 18,
	Escape: 27,
	" ": 32,
	PageUp: 33,
	PageDown: 34,
	End: 35,
	Home: 36,
	ArrowLeft: 37,
	ArrowUp: 38,
	ArrowRight: 39,
	ArrowDown: 40,
	Delete: 46,
	Meta: 91,
};

/** Editing shortcuts (with Control or Meta) the browser only runs when named as commands. */
const SHORTCUTS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

function finite(n: number, what: string): number {
	if (!Number.isFinite(n) || Math.abs(n) > MAX_COORD) throw new InputError(`${what} is out of range`);
	return n;
}

/** The virtual key code of a key: its own for named keys, else the character's upper case. */
export function keyCode(key: string): number {
	const named = KEY_CODES[key];
	if (named !== undefined) return named;
	if (key.length === 1) {
		const upper = key.toUpperCase();
		const c = upper.charCodeAt(0);
		if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) return c;
	}
	return 0;
}

/** The CDP commands for one input of the user. */
export function inputCommands(action: InputAction): CdpCommand[] {
	if (action.kind === "text") {
		if (action.text.length === 0 || action.text.length > MAX_TEXT_CHARS) throw new InputError(`text must be 1 to ${MAX_TEXT_CHARS} characters`);
		return [{ method: "Input.insertText", params: { text: action.text } }];
	}
	if (action.kind === "mouse") {
		const m = action.mouse;
		const button = BUTTONS[m.button] ?? "left";
		const wheel = m.type === "wheel";
		const params: Record<string, unknown> = {
			type: MOUSE_TYPE[m.type],
			x: finite(m.x, "x"),
			y: finite(m.y, "y"),
			modifiers: m.modifiers & MODIFIERS,
			button: wheel || m.type === "move" ? "none" : button,
		};
		if (m.type === "down" || m.type === "up") params.clickCount = Math.min(Math.max(m.clickCount, 1), 3);
		if (m.type === "down") params.buttons = BUTTON_BITS[m.button] ?? 1;
		if (wheel) {
			params.deltaX = finite(m.deltaX, "deltaX");
			params.deltaY = finite(m.deltaY, "deltaY");
		}
		return [{ method: "Input.dispatchMouseEvent", params }];
	}
	const k = action.key;
	if (k.key.length === 0 || k.key.length > 32 || k.code.length > 32 || k.text.length > 4) throw new InputError("not a key");
	const modifiers = k.modifiers & MODIFIERS;
	const base = { key: k.key, code: k.code, windowsVirtualKeyCode: keyCode(k.key), modifiers };
	const shortcut = modifiers & (MODIFIER.ctrl | MODIFIER.meta) ? SHORTCUTS[k.key.toLowerCase()] : undefined;
	const down: Record<string, unknown> = k.text !== "" && !shortcut ? { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text } : { type: "rawKeyDown", ...base };
	if (shortcut) down.commands = [shortcut];
	// Enter types a line break in a text area: the browser wants it as text "\r".
	if (k.key === "Enter" && !shortcut) Object.assign(down, { type: "keyDown", text: "\r", unmodifiedText: "\r" });
	return [
		{ method: "Input.dispatchKeyEvent", params: down },
		{ method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
	];
}

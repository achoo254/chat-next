// The keys a phone keyboard lacks, in one row above it (above the home
// indicator while it is closed), ordered for an AI in a terminal as Orca's
// phone app orders them: the keyboard toggle, Esc, Tab, Shift+Tab (Claude
// Code's permission modes), Ctrl and Alt (tap: the next key; tap twice: held
// until tapped again), the arrows, Enter, Ctrl+C on its own, then / - | ~ $ >
// and Backspace, Ctrl+D, Ctrl+L, Ctrl+R, paste, and "more" for Del, Home,
// End, PgUp, PgDn and F1 to F12. Arrows, Backspace and Del repeat while held
// (after 400 ms, every 45 ms). A key never takes the focus from the
// terminal's input, so the phone keyboard stays up: its mousedown is
// cancelled, not its pointerdown, since WebKit drops the click of a tap whose
// pointerdown was cancelled.
import { useEffect, useRef, useState, type MouseEvent } from "react";

export type BarKey =
	| "esc"
	| "tab"
	| "shift-tab"
	| "enter"
	| "left"
	| "up"
	| "down"
	| "right"
	| "backspace"
	| "delete"
	| "home"
	| "end"
	| "page-up"
	| "page-down"
	| "ctrl-c"
	| "ctrl-d"
	| "ctrl-l"
	| "ctrl-r"
	| "pipe"
	| "tilde"
	| "slash"
	| "dash"
	| "dollar"
	| "greater"
	| `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;
export type Modifier = "ctrl" | "alt";

/** A modifier key: off, for the next key only, or held until tapped again. */
export type Latch = "off" | "once" | "lock";

export interface Modifiers {
	readonly ctrl: Latch;
	readonly alt: Latch;
}

export const NO_MODIFIERS: Modifiers = { ctrl: "off", alt: "off" };

/** Two taps of a modifier this close together hold it. */
export const DOUBLE_TAP_MS = 350;
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 45;

/** A modifier tapped: off → once, a second tap soon after → held, any tap of a held one → off. */
export function tapLatch(current: Latch, sinceLastTapMs: number): Latch {
	if (current === "lock") return "off";
	if (current === "once") return sinceLastTapMs <= DOUBLE_TAP_MS ? "lock" : "off";
	return "once";
}

/** After a key went with the modifiers: the one-key ones let go, held ones stay. */
export function afterKey(mods: Modifiers): Modifiers {
	return { ctrl: mods.ctrl === "once" ? "off" : mods.ctrl, alt: mods.alt === "once" ? "off" : mods.alt };
}

const F_SS3: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
const F_TILDE: Record<string, number> = { f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24 };

/** What a key of the bar sends; arrows, Home and End follow the terminal's cursor key mode (DECCKM). */
export function keySequence(key: BarKey, appCursor: boolean): string {
	const cursor = (code: string) => (appCursor ? `\x1bO${code}` : `\x1b[${code}`);
	switch (key) {
		case "esc":
			return "\x1b";
		case "tab":
			return "\t";
		case "shift-tab":
			return "\x1b[Z";
		case "enter":
			return "\r";
		case "up":
			return cursor("A");
		case "down":
			return cursor("B");
		case "right":
			return cursor("C");
		case "left":
			return cursor("D");
		case "home":
			return cursor("H");
		case "end":
			return cursor("F");
		case "backspace":
			return "\x7f";
		case "delete":
			return "\x1b[3~";
		case "page-up":
			return "\x1b[5~";
		case "page-down":
			return "\x1b[6~";
		case "ctrl-c":
			return "\x03";
		case "ctrl-d":
			return "\x04";
		case "ctrl-l":
			return "\x0c";
		case "ctrl-r":
			return "\x12";
		case "pipe":
			return "|";
		case "tilde":
			return "~";
		case "slash":
			return "/";
		case "dash":
			return "-";
		case "dollar":
			return "$";
		case "greater":
			return ">";
		default: {
			const ss3 = F_SS3[key];
			if (ss3 !== undefined) return `\x1bO${ss3}`;
			return `\x1b[${F_TILDE[key] ?? 15}~`;
		}
	}
}

/**
 * Text typed while Ctrl or Alt is on: Ctrl turns its first character into
 * the control code (Ctrl+C is 0x03, Ctrl+Space and Ctrl+@ are NUL, Ctrl+? is
 * DEL), Alt puts ESC before it, as terminals do. The rest goes as typed.
 */
export function withModifiers(text: string, mods: { readonly ctrl: boolean | Latch; readonly alt: boolean | Latch }): string {
	const ctrl = mods.ctrl === true || mods.ctrl === "once" || mods.ctrl === "lock";
	const alt = mods.alt === true || mods.alt === "once" || mods.alt === "lock";
	if (text === "" || (!ctrl && !alt)) return text;
	const chars = Array.from(text);
	let first = chars[0] ?? "";
	if (ctrl) first = controlOf(first);
	if (alt) first = `\x1b${first}`;
	return first + chars.slice(1).join("");
}

function controlOf(ch: string): string {
	if (ch === " " || ch === "@" || ch === "2") return "\x00";
	if (ch === "?" || ch === "8") return "\x7f";
	const upper = ch.toUpperCase();
	const code = upper.charCodeAt(0);
	// A to Z and [ \ ] ^ _ map to 0x01 to 0x1f.
	if (upper.length === 1 && code >= 0x41 && code <= 0x5f) return String.fromCharCode(code - 0x40);
	return ch;
}

/**
 * Sends once now, then again after `delay` and every `interval` until the
 * returned stop is called (the key let go, the pointer left, the bar gone).
 */
export function repeatKey(send: () => void, delay = REPEAT_DELAY_MS, interval = REPEAT_INTERVAL_MS): () => void {
	send();
	let repeating: ReturnType<typeof setInterval> | undefined;
	const waiting = setTimeout(() => {
		repeating = setInterval(send, interval);
	}, delay);
	return () => {
		clearTimeout(waiting);
		clearInterval(repeating);
	};
}

const REPEATS = new Set<BarKey>(["left", "up", "down", "right", "backspace", "delete"]);

export interface BarLabels {
	readonly bar: string;
	readonly keyboard: string;
	readonly esc: string;
	readonly tab: string;
	readonly shiftTab: string;
	readonly ctrl: string;
	readonly alt: string;
	readonly held: (key: string) => string;
	readonly up: string;
	readonly down: string;
	readonly left: string;
	readonly right: string;
	readonly enter: string;
	readonly interrupt: string;
	readonly backspace: string;
	readonly paste: string;
	readonly more: string;
}

interface MobileKeyBarProps {
	labels: BarLabels;
	mods: Modifiers;
	/** The phone keyboard is up. */
	keyboard: boolean;
	/** A modifier tapped, `sinceLastTapMs` after its previous tap (for tapLatch). */
	onToggle(mod: Modifier, sinceLastTapMs: number): void;
	onKey(key: BarKey): void;
	onPaste(): void;
	onKeyboard(): void;
}

type Item = { key: BarKey; text: string; label?: keyof BarLabels; className?: string };

const MAIN: readonly Item[] = [
	{ key: "esc", text: "Esc", label: "esc" },
	{ key: "tab", text: "⇥", label: "tab" },
	{ key: "shift-tab", text: "⇤", label: "shiftTab" },
];
const AFTER_MODS: readonly Item[] = [
	{ key: "left", text: "←", label: "left" },
	{ key: "up", text: "↑", label: "up" },
	{ key: "down", text: "↓", label: "down" },
	{ key: "right", text: "→", label: "right" },
	{ key: "enter", text: "⏎", label: "enter" },
	{ key: "ctrl-c", text: "^C", label: "interrupt", className: "stop" },
	{ key: "slash", text: "/" },
	{ key: "dash", text: "-" },
	{ key: "pipe", text: "|" },
	{ key: "tilde", text: "~" },
	{ key: "dollar", text: "$" },
	{ key: "greater", text: ">" },
	{ key: "backspace", text: "⌫", label: "backspace" },
	{ key: "ctrl-d", text: "^D" },
	{ key: "ctrl-l", text: "^L" },
	{ key: "ctrl-r", text: "^R" },
];
const MORE: readonly Item[] = [
	{ key: "delete", text: "Del" },
	{ key: "home", text: "Home" },
	{ key: "end", text: "End" },
	{ key: "page-up", text: "PgUp" },
	{ key: "page-down", text: "PgDn" },
	...([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const).map((n): Item => ({ key: `f${n}`, text: `F${n}` })),
];

/** Keeps the focus (and the phone keyboard) where it is. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function MobileKeyBar({ labels, mods, keyboard, onToggle, onKey, onPaste, onKeyboard }: MobileKeyBarProps) {
	const [more, setMore] = useState(false);
	const lastTap = useRef<Record<Modifier, number>>({ ctrl: 0, alt: 0 });
	const stopRepeat = useRef<(() => void) | null>(null);
	const stop = () => {
		stopRepeat.current?.();
		stopRepeat.current = null;
	};
	// A key held while the bar goes away stops repeating.
	useEffect(() => stop, []);
	const key = (item: Item) => {
		const label = item.label === undefined ? undefined : labels[item.label];
		const common = {
			type: "button" as const,
			className: item.className === undefined ? "tx-key" : `tx-key ${item.className}`,
			"aria-label": typeof label === "string" ? label : undefined,
			"data-key": item.key,
		};
		if (!REPEATS.has(item.key)) {
			return (
				<button key={item.key} {...common} onMouseDown={keepFocus} onClick={() => onKey(item.key)}>
					{item.text}
				</button>
			);
		}
		// Held: once now, then repeating; a keyboard or a screen reader presses it once (detail 0).
		return (
			<button
				key={item.key}
				{...common}
				onMouseDown={keepFocus}
				onPointerDown={() => {
					stop();
					stopRepeat.current = repeatKey(() => onKey(item.key));
				}}
				onPointerUp={stop}
				onPointerLeave={stop}
				onPointerCancel={stop}
				onClick={(event) => {
					if (event.detail === 0) onKey(item.key);
				}}
			>
				{item.text}
			</button>
		);
	};
	const modKey = (mod: Modifier) => {
		const state = mods[mod];
		return (
			<button
				key={mod}
				type="button"
				className="tx-key mod"
				data-latch={state}
				aria-pressed={state !== "off"}
				aria-label={state === "lock" ? labels.held(labels[mod]) : labels[mod]}
				onMouseDown={keepFocus}
				onClick={() => {
					const now = Date.now();
					const since = now - lastTap.current[mod];
					lastTap.current[mod] = now;
					onToggle(mod, since);
				}}
			>
				{labels[mod]}
			</button>
		);
	};
	return (
		<div className="tx-keys" role="toolbar" aria-label={labels.bar} data-keyboard={keyboard ? "" : undefined}>
			<button type="button" className="tx-key kbd" aria-label={labels.keyboard} aria-pressed={keyboard} onMouseDown={keepFocus} onClick={onKeyboard}>
				⌨
			</button>
			{MAIN.map(key)}
			{modKey("ctrl")}
			{modKey("alt")}
			{AFTER_MODS.map(key)}
			<button type="button" className="tx-key" aria-label={labels.paste} onMouseDown={keepFocus} onClick={onPaste}>
				⎘
			</button>
			<button type="button" className="tx-key" aria-label={labels.more} aria-expanded={more} onMouseDown={keepFocus} onClick={() => setMore((v) => !v)}>
				⋯
			</button>
			{more && MORE.map(key)}
		</div>
	);
}

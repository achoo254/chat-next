// The row of keys a phone keyboard lacks, above it: Esc, Tab, Ctrl and Alt
// (each held for the next key, tap again to let go), the arrows, and | ~ / -.
// Pressing a key never takes the focus from the terminal's input, so the
// phone keyboard stays up.
import type { PointerEvent } from "react";

export type BarKey = "esc" | "tab" | "left" | "up" | "down" | "right" | "pipe" | "tilde" | "slash" | "dash";
export type Modifier = "ctrl" | "alt";

export interface Modifiers {
	readonly ctrl: boolean;
	readonly alt: boolean;
}

/** What a key of the bar sends; arrows follow the terminal's cursor key mode (DECCKM). */
export function keySequence(key: BarKey, appCursor: boolean): string {
	const arrow = (code: string) => (appCursor ? `\x1bO${code}` : `\x1b[${code}`);
	switch (key) {
		case "esc":
			return "\x1b";
		case "tab":
			return "\t";
		case "up":
			return arrow("A");
		case "down":
			return arrow("B");
		case "right":
			return arrow("C");
		case "left":
			return arrow("D");
		case "pipe":
			return "|";
		case "tilde":
			return "~";
		case "slash":
			return "/";
		case "dash":
			return "-";
	}
}

/**
 * Text typed while Ctrl or Alt is held: Ctrl turns its first character into
 * the control code (Ctrl+C is 0x03, Ctrl+Space and Ctrl+@ are NUL, Ctrl+? is
 * DEL), Alt puts ESC before it, as terminals do. The rest goes as typed.
 */
export function withModifiers(text: string, mods: Modifiers): string {
	if (text === "" || (!mods.ctrl && !mods.alt)) return text;
	const chars = Array.from(text);
	let first = chars[0] ?? "";
	if (mods.ctrl) first = controlOf(first);
	if (mods.alt) first = `\x1b${first}`;
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

interface Labels {
	readonly bar: string;
	readonly esc: string;
	readonly tab: string;
	readonly ctrl: string;
	readonly alt: string;
	readonly up: string;
	readonly down: string;
	readonly left: string;
	readonly right: string;
}

interface MobileKeyBarProps {
	labels: Labels;
	mods: Modifiers;
	onToggle(mod: Modifier): void;
	onKey(key: BarKey): void;
}

const KEYS: readonly { key: BarKey; text: string; label?: keyof Labels }[] = [
	{ key: "esc", text: "Esc", label: "esc" },
	{ key: "tab", text: "⇥", label: "tab" },
	{ key: "left", text: "←", label: "left" },
	{ key: "up", text: "↑", label: "up" },
	{ key: "down", text: "↓", label: "down" },
	{ key: "right", text: "→", label: "right" },
	{ key: "pipe", text: "|" },
	{ key: "tilde", text: "~" },
	{ key: "slash", text: "/" },
	{ key: "dash", text: "-" },
];

/** Keeps the focus (and the phone keyboard) where it is. */
const keepFocus = (event: PointerEvent) => event.preventDefault();

export function MobileKeyBar({ labels, mods, onToggle, onKey }: MobileKeyBarProps) {
	return (
		<div className="tx-keys" role="toolbar" aria-label={labels.bar}>
			{(["ctrl", "alt"] as const).map((mod) => (
				<button key={mod} type="button" className="tx-key mod" aria-pressed={mods[mod]} onPointerDown={keepFocus} onClick={() => onToggle(mod)}>
					{labels[mod]}
				</button>
			))}
			{KEYS.map((k) => (
				<button key={k.key} type="button" className="tx-key" aria-label={k.label === undefined ? undefined : labels[k.label]} onPointerDown={keepFocus} onClick={() => onKey(k.key)}>
					{k.text}
				</button>
			))}
		</div>
	);
}

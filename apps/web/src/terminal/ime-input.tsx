// The terminal's input on touch screens: a nearly invisible text field at the
// caret that the phone keyboard types into, so its input method works as in
// any text field. Vietnamese Telex and VNI rewrite letters already typed
// ("tieng" + "s" becomes "tiếng"), inside a composition or by replacing the
// field's text; either way the field's text is compared with what was sent
// and the shell gets one DEL per character taken back, then the new text.
// Nothing is sent while a composition is open. Enter, Tab, Esc and the
// arrows go as terminal keys. The field always starts with one space that is
// never sent: phone keyboards report Backspace in an empty field to no one,
// but deleting that space is an edit like any other (one DEL), after which
// the space comes back.
import { useRef, type CompositionEvent, type FormEvent, type KeyboardEvent, type Ref } from "react";

const DEL = "\x7f";
/** The field's first character, never sent (see above). */
export const SENTINEL = " ";
/** The field is emptied once a word ends past this length, so it never grows. */
const KEEP_CHARS = 32;

/** What to send when the field's text changes from `sent` to `now`. */
export function inputDelta(sent: string, now: string): string {
	const a = Array.from(sent);
	const b = Array.from(now);
	let same = 0;
	while (same < a.length && same < b.length && a[same] === b[same]) same++;
	return DEL.repeat(a.length - same) + b.slice(same).join("");
}

/** A key that goes to the terminal as such (not as text); null for the rest (Backspace edits the field). */
export function keyOf(key: string): string | null {
	switch (key) {
		case "Enter":
			return "\r";
		case "Tab":
			return "\t";
		case "Escape":
			return "\x1b";
		case "ArrowUp":
			return "\x1b[A";
		case "ArrowDown":
			return "\x1b[B";
		case "ArrowRight":
			return "\x1b[C";
		case "ArrowLeft":
			return "\x1b[D";
		default:
			return null;
	}
}

interface ImeInputProps {
	label: string;
	/** Text and keys for the focused session (the dock applies held Ctrl/Alt). */
	onSend(text: string): void;
	/** Arrows follow the terminal's cursor key mode. */
	appCursor(): boolean;
	inputRef: Ref<HTMLTextAreaElement>;
	/** Where the caret is, so the input method's suggestions show next to it. */
	at: { readonly x: number; readonly y: number; readonly height: number } | null;
}

export function ImeInput({ label, onSend, appCursor, inputRef, at }: ImeInputProps) {
	const sent = useRef(SENTINEL);
	const composing = useRef(false);

	const clear = (field: HTMLTextAreaElement) => {
		field.value = SENTINEL;
		sent.current = SENTINEL;
	};
	const sync = (field: HTMLTextAreaElement) => {
		const now = field.value;
		// Some keyboards type Enter as a line break in the field.
		const delta = inputDelta(sent.current, now).replace(/\n/g, "\r");
		sent.current = now;
		if (delta !== "") onSend(delta);
		if (!now.startsWith(SENTINEL) || now.includes("\n") || (now.length > KEEP_CHARS && /\s$/.test(now))) clear(field);
	};

	const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
		if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
		sync(event.currentTarget);
	};
	const onCompositionStart = () => {
		composing.current = true;
	};
	const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
		composing.current = false;
		sync(event.currentTarget);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// 229 / "Process": the input method owns this key.
		if (event.nativeEvent.isComposing || composing.current || event.key === "Process") return;
		const field = event.currentTarget;
		let key = keyOf(event.key);
		if (key === null) return;
		if (key.startsWith("\x1b[") && appCursor()) key = `\x1bO${key.slice(2)}`;
		event.preventDefault();
		if (event.key === "Enter") clear(field);
		onSend(key);
	};

	return (
		<textarea
			ref={inputRef}
			className="tx-ime"
			aria-label={label}
			// Keystrokes, never a credential (see no-autofill.ts): no password manager offers to fill it.
			name="terminal-keys"
			autoCapitalize="off"
			autoComplete="off"
			autoCorrect="off"
			spellCheck={false}
			data-1p-ignore=""
			data-lpignore="true"
			data-bwignore=""
			data-form-type="other"
			enterKeyHint="send"
			rows={1}
			defaultValue={SENTINEL}
			style={at === null ? undefined : { transform: `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`, height: `${Math.max(16, Math.round(at.height))}px` }}
			onInput={onInput}
			onCompositionStart={onCompositionStart}
			onCompositionEnd={onCompositionEnd}
			onKeyDown={onKeyDown}
			onBlur={(event) => clear(event.currentTarget)}
		/>
	);
}

// A plain text message box on TipTap (ProseMirror), as Telegram Web (A and K)
// does: an editable <div role="textbox"> instead of a <textarea>, because
// password managers (iCloud Passwords above all) treat any textarea they
// cannot classify as a form field to fill.
//
// The editor (plain-text-editor.ts) loads with the first box, apart from the
// screen's code, and mounts on the element rendered here; until it is there
// the element shows the value or the placeholder and is marked busy. The box
// reports what the user types with onValueChange and takes `value` from
// outside only when it differs from what is shown.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import type { Editor } from "@tiptap/core";
import type { EditorProps, Live, TextSelection, TokenMatch } from "./plain-text-editor.ts";

export type { OpenToken, SuggestionTrigger, TextSelection, TokenMatch } from "./plain-text-editor.ts";

/** What a composer can do with the box beyond its value. */
export interface PlainTextBoxHandle {
	/** Focuses the box, the caret back where it was (as a textarea keeps its selection). */
	focus(): void;
	/** The selection in the value, kept while the box has no focus. */
	getSelection(): TextSelection;
	/** Selects [start, end] of the value, now and again once a value being set is shown. */
	setSelection(start: number, end?: number): void;
	/** Replaces the selection with text, as typing would (undo takes it back); the focus stays where it is. */
	insertText(text: string): void;
	/** Closes the open suggestion token (its list); it opens again once the text changes. */
	closeSuggestions(): void;
	/** Opens again a suggestion token that was closed, where the caret is. */
	reopenSuggestions(): void;
}

/** aria-* and data-* attributes go on the editable element as they are. */
type PassThrough = {
	readonly [key: `aria-${string}`]: string | boolean | undefined;
	readonly [key: `data-${string}`]: string | undefined;
};

export interface PlainTextBoxProps extends PassThrough, EditorProps {
	ref?: Ref<PlainTextBoxHandle> | undefined;
	ariaLabel: string;
	id?: string | undefined;
	/** Classes of the editable element (its look). */
	className?: string | undefined;
	enterKeyHint?: "enter" | "done" | "go" | "next" | "previous" | "search" | "send" | undefined;
}

type EditorModule = typeof import("./plain-text-editor.ts");

let editorModule: Promise<EditorModule> | null = null;
/** The editor's code once fetched: a box mounted after that gets its editor at once. */
let editorCode: EditorModule | null = null;

/** The editor's code, fetched once for every box. */
function loadEditor(): Promise<EditorModule> {
	editorModule ??= import("./plain-text-editor.ts").then(
		(code) => {
			editorCode = code;
			return code;
		},
		(error: unknown) => {
			// A failed fetch (offline, a new deployment) may succeed with the next box.
			editorModule = null;
			throw error;
		},
	);
	return editorModule;
}

/** Fetches the editor ahead of the first message box (idle prefetch), so it opens ready to type. */
export function preloadPlainTextEditor(): Promise<unknown> {
	return loadEditor();
}

/** The editable element's attributes: strings only, the absent ones left out. */
function attributesOf(props: PlainTextBoxProps): Record<string, string> {
	const attributes: Record<string, string> = {
		class: props.className === undefined ? "plain-text-box" : `plain-text-box ${props.className}`,
		role: "textbox",
		"aria-multiline": "true",
		"aria-label": props.ariaLabel,
		autocomplete: "off",
		autocorrect: "off",
		inputmode: "text",
		translate: "no",
	};
	if (props.id !== undefined) attributes.id = props.id;
	if (props.enterKeyHint !== undefined) attributes.enterkeyhint = props.enterKeyHint;
	if (props.placeholder !== undefined) attributes["aria-placeholder"] = props.placeholder;
	if (props.disabled === true) attributes["aria-disabled"] = "true";
	for (const [key, value] of Object.entries(props)) {
		if (!key.startsWith("aria-") && !key.startsWith("data-")) continue;
		if (typeof value === "string") attributes[key] = value;
		else if (typeof value === "boolean") attributes[key] = String(value);
	}
	return attributes;
}

/** The element before its editor: these attributes, its value as text, busy. */
function showWaiting(element: HTMLElement, attributes: Record<string, string>, value: string): void {
	for (const [name, attribute] of Object.entries(attributes)) element.setAttribute(name, attribute);
	element.setAttribute("aria-busy", "true");
	element.setAttribute("aria-disabled", "true");
	element.textContent = value;
}

const atEnd = (value: string): TextSelection => ({ start: value.length, end: value.length });

/** "/name" being typed as the whole message (no space yet), the rule of the composers' command lists; wherever the caret is in it. */
export function commandToken(value: string): TokenMatch | null {
	if (!value.startsWith("/") || /\s/.test(value)) return null;
	return { start: 0, end: value.length, query: value.slice(1) };
}

export function PlainTextBox(props: PlainTextBoxProps) {
	const { ref, disabled = false } = props;
	const host = useRef<HTMLDivElement>(null);
	/** The editor and its code, once loaded. */
	const editorRef = useRef<{ editor: Editor; code: EditorModule } | null>(null);
	/** Focus asked for before the editor was there. */
	const focusWhenReady = useRef(false);
	const live = useRef<Live>({
		props,
		attributes: () => attributesOf(props),
		shown: props.value,
		pending: null,
		composing: false,
		composedAt: Number.NEGATIVE_INFINITY,
	});

	useLayoutEffect(() => {
		const element = host.current;
		if (element === null) return;
		let gone = false;
		const mount = (code: EditorModule) => {
			if (gone) return;
			element.removeAttribute("aria-busy");
			element.removeAttribute("aria-disabled");
			element.textContent = "";
			const editor = code.createEditor(element, live.current);
			editorRef.current = { editor, code };
			if (focusWhenReady.current) editor.view.focus();
			focusWhenReady.current = false;
		};
		if (editorCode !== null) {
			mount(editorCode);
		} else {
			showWaiting(element, live.current.attributes(), live.current.props.value);
			loadEditor().then(mount, (error: unknown) => {
				// The box stays as it is, showing its text; the screen around it keeps working.
				console.warn("message box editor failed to load", error);
			});
		}
		return () => {
			gone = true;
			editorRef.current?.editor.destroy();
			editorRef.current = null;
		};
	}, []);

	// The value set from outside: written only when it differs from what is shown.
	useLayoutEffect(() => {
		live.current.props = props;
		live.current.attributes = () => attributesOf(props);
		const loaded = editorRef.current;
		if (loaded === null) {
			const element = host.current;
			if (element !== null && element.textContent !== props.value) element.textContent = props.value;
			return;
		}
		loaded.code.writeOutside(loaded.editor, live.current);
	});

	// Attributes and the placeholder follow the props without a new editor.
	const attributesKey = JSON.stringify(attributesOf(props));
	useEffect(() => {
		const loaded = editorRef.current;
		const element = host.current;
		if (loaded === null) {
			if (element !== null) showWaiting(element, JSON.parse(attributesKey) as Record<string, string>, live.current.props.value);
			return;
		}
		if (loaded.editor.isDestroyed) return;
		if (loaded.editor.isEditable === disabled) loaded.editor.setEditable(!disabled, false);
		loaded.code.refresh(loaded.editor);
	}, [attributesKey, disabled]);

	useImperativeHandle(
		ref,
		(): PlainTextBoxHandle => ({
			focus: () => {
				const loaded = editorRef.current;
				if (loaded === null) focusWhenReady.current = true;
				else if (!loaded.editor.isDestroyed) loaded.editor.view.focus();
			},
			getSelection: () => {
				const loaded = editorRef.current;
				return loaded === null ? (live.current.pending ?? atEnd(live.current.props.value)) : loaded.code.selectionOf(loaded.editor);
			},
			setSelection: (start: number, end: number = start) => {
				live.current.pending = { start, end };
				const loaded = editorRef.current;
				if (loaded !== null) loaded.code.selectValueRange(loaded.editor, { start, end });
			},
			insertText: (text: string) => {
				const loaded = editorRef.current;
				if (loaded !== null) {
					loaded.code.insertText(loaded.editor, live.current, text);
					return;
				}
				// Before the editor: put it in the value at the asked caret, as the editor would.
				const value = live.current.props.value;
				const at = live.current.pending ?? atEnd(value);
				const caret = at.start + text.length;
				live.current.pending = { start: caret, end: caret };
				live.current.props.onValueChange(value.slice(0, at.start) + text + value.slice(at.end), { start: caret, end: caret });
			},
			closeSuggestions: () => {
				const loaded = editorRef.current;
				if (loaded !== null) loaded.code.closeTokens(loaded.editor);
			},
			reopenSuggestions: () => {
				const loaded = editorRef.current;
				if (loaded !== null) loaded.code.reopenTokens(loaded.editor);
			},
		}),
		[],
	);

	return <div ref={host} />;
}

// The editor of a plain text message box (plain-text-box.tsx): TipTap on the
// box's own element, loaded with the first box, as Telegram Web loads its
// editor bundle apart from the screen.
//
// The document is one paragraph of text and hard breaks: a hard break is a
// "\n" of the value, so a value offset is a ProseMirror position minus one.
// There are no marks: paste and drop only take text/plain. A value set from
// outside is written only when it differs from the document, never while an
// IME composes (Telex, VNI, CJK); Vietnamese input methods that fix a word
// by erasing and retyping it (Unikey, EVKey, Gboard Telex) reach ProseMirror
// untouched.
//
// Tokens a composer suggests for ("/command", "@file") are found by
// @tiptap/suggestion, as Telegram Web A finds its mentions and bot commands,
// with each composer's own rule; they stay plain text in the value. The
// composer draws its list and handles its keys.
import { Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection as PmTextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Suggestion, exitSuggestion, type SuggestionMatch } from "@tiptap/suggestion";

/** Offsets in the plain text value; start <= end. */
export interface TextSelection {
	readonly start: number;
	readonly end: number;
}

/** A token being typed, as a composer's rule finds it: [start, end) in the value (start is its trigger character), and what follows that character. */
export interface TokenMatch {
	readonly start: number;
	readonly end: number;
	readonly query: string;
}

/** The token open for suggestions, as the composer sees it. */
export interface OpenToken {
	readonly query: string;
	/** Where it is in the value. */
	readonly range: TextSelection;
	/** Puts text in place of the token as typing would (undo takes it back), the caret after it, the focus in the box. */
	replace(text: string): void;
}

/** One kind of token the box watches for ("/" commands, "@" files); the list of triggers is fixed for the box's life. */
export interface SuggestionTrigger {
	/** The character that starts the token. */
	readonly char: string;
	/** The composer's rule: the token being typed with the caret at `caret`; null when there is none (or the trigger is off). */
	readonly find: (value: string, caret: number) => TokenMatch | null;
	/** The token opened or changed, or closed (null). */
	readonly onChange: (token: OpenToken | null) => void;
	/** A key while the token is open, before the composer's own keys: true when the list took it. Esc taken closes the token. */
	readonly onKeyDown?: ((event: KeyboardEvent) => boolean) | undefined;
}

/** What the editor reads from the box's latest props. */
export interface EditorProps {
	readonly value: string;
	readonly placeholder?: string | undefined;
	readonly disabled?: boolean | undefined;
	/** At most this many UTF-16 code units, as a textarea's maxLength. */
	readonly maxLength?: number | undefined;
	readonly suggestions?: readonly SuggestionTrigger[] | undefined;
	readonly onValueChange: (value: string, selection: TextSelection) => void;
	readonly onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
	readonly onPaste?: ((event: ClipboardEvent) => void) | undefined;
}

/** Enter right after an IME commit (Safari sends it after compositionend) belongs to the IME. */
const AFTER_COMPOSITION_MS = 100;

/** Marks a transaction that writes a value set from outside: not reported back, not undone. */
const OUTSIDE = "plainTextOutside";

/** One paragraph only: the value has line breaks, not blocks. */
const OneParagraph = Document.extend({ content: "paragraph" });

/** Enter, when the composer leaves it alone, breaks the line as in a textarea. */
const EnterBreaks = Extension.create({
	name: "plainTextEnter",
	// Before the core keymap, whose Enter splits the paragraph.
	priority: 1000,
	addKeyboardShortcuts() {
		return { Enter: () => this.editor.commands.setHardBreak() };
	},
});

/** The value of a document: its text with a "\n" for each hard break. */
export function plainText(doc: PmNode): string {
	return doc.textBetween(0, doc.content.size, "\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : ""));
}

/** Text and hard breaks for a string with "\n". */
export function inlineNodes(schema: Schema, text: string): PmNode[] {
	const nodes: PmNode[] = [];
	const hardBreak = schema.nodes.hardBreak;
	if (hardBreak === undefined) throw new Error("plain text schema without hardBreak");
	for (const [index, line] of text.replace(/\r\n?/g, "\n").split("\n").entries()) {
		if (index > 0) nodes.push(hardBreak.create());
		if (line !== "") nodes.push(schema.text(line));
	}
	return nodes;
}

/** The value range of a ProseMirror selection (the paragraph's content starts at position 1). */
export function valueSelection(doc: PmNode, from: number, to: number): TextSelection {
	const length = doc.content.size - 2;
	return { start: Math.min(Math.max(0, from - 1), length), end: Math.min(Math.max(0, to - 1), length) };
}

/** A ProseMirror text selection of a value range, clamped to the document. */
export function pmSelection(doc: PmNode, selection: TextSelection): PmTextSelection {
	const length = doc.content.size - 2;
	const start = Math.min(Math.max(0, selection.start), length);
	const end = Math.min(Math.max(start, selection.end), length);
	return PmTextSelection.create(doc, start + 1, end + 1);
}

/** The value's length in a document: its paragraph's content, a hard break counting one ("\n"). */
const valueLength = (doc: PmNode): number => doc.content.size - 2;

/** At most `room` code units of text, never half of a surrogate pair. */
function fitting(text: string, room: number): string {
	if (text.length <= room) return text;
	const cut = text.slice(0, Math.max(0, room));
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Replaces the selection of `tr` with plain text, cut to `maxLength` as a textarea cuts a paste; the caret after it. */
export function insertPlain(view: EditorView, text: string, maxLength?: number, tr: Transaction = view.state.tr): void {
	const { from, to } = tr.selection;
	const normal = text.replace(/\r\n?/g, "\n");
	const fitted = maxLength === undefined ? normal : fitting(normal, maxLength - (valueLength(tr.doc) - (to - from)));
	tr.replaceWith(from, to, inlineNodes(view.state.schema, fitted));
	tr.setSelection(PmTextSelection.create(tr.doc, Math.min(from + fitted.length, tr.doc.content.size - 1)));
	view.dispatch(tr.scrollIntoView());
}

/** What the editor reads from the latest props. */
export interface Live {
	props: EditorProps;
	/** The element's attributes for these props. */
	attributes: () => Record<string, string>;
	/** The value last reported or shown, so one change is reported once. */
	shown: string;
	/** A selection asked for while the value being set is not shown yet. */
	pending: TextSelection | null;
	composing: boolean;
	composedAt: number;
}

const isComposing = (editor: Editor, live: Live): boolean => live.composing || editor.view.composing;

/** Typing past maxLength does nothing, as in a textarea; a value set from outside is written whole. */
function maxLengthPlugin(live: Live): Plugin {
	return new Plugin({
		filterTransaction: (tr: Transaction, state: EditorState) => {
			const max = live.props.maxLength;
			if (max === undefined || !tr.docChanged || tr.getMeta(OUTSIDE) === true) return true;
			const length = valueLength(tr.doc);
			return length <= max || length <= valueLength(state.doc);
		},
	});
}

// ------------------------------------------------------------ suggestions

/** Reopens a token closed by Esc when the composer asks (its menu button). */
const REOPEN = "plainTextReopen";

/** The part of @tiptap/suggestion's plugin state the box reads. */
interface TokenState {
	readonly active: boolean;
	readonly query: string | null;
	readonly range: { readonly from: number; readonly to: number };
}

type TokenKey = PluginKey<TokenState>;

/** Each editor's suggestion plugins, in the order of its triggers. */
const tokenKeys = new WeakMap<Editor, readonly TokenKey[]>();

/** The token a trigger's rule finds at a position, in ProseMirror positions (a value offset plus one). */
function findToken(trigger: SuggestionTrigger | undefined, doc: PmNode, pos: number): SuggestionMatch {
	if (trigger === undefined) return null;
	const value = plainText(doc);
	const token = trigger.find(value, pos - 1);
	if (token === null || token.end < token.start) return null;
	return { range: { from: token.start + 1, to: token.end + 1 }, query: token.query, text: value.slice(token.start, token.end) };
}

/** Puts text in place of the open token: one transaction, its own undo step (undo brings the typed token back). */
function replaceToken(editor: Editor, live: Live, key: TokenKey, text: string): void {
	if (editor.isDestroyed || !editor.isEditable || isComposing(editor, live)) return;
	const token = key.getState(editor.state);
	if (token === undefined || !token.active) return;
	const { view } = editor;
	const tr = closeHistory(view.state.tr).setSelection(PmTextSelection.create(view.state.doc, token.range.from, token.range.to));
	insertPlain(view, text, live.props.maxLength, tr);
	view.focus();
}

/** The open token as a composer sees it. */
function openToken(editor: Editor, live: Live, key: TokenKey, query: string, range: { readonly from: number; readonly to: number }): OpenToken {
	return { query, range: { start: range.from - 1, end: range.to - 1 }, replace: (text) => replaceToken(editor, live, key, text) };
}

/**
 * Tells the composers about the open tokens as the focus comes and goes: a
 * list shows only while the box has the focus, and the token is not closed
 * by leaving, so it shows again where it was when the focus comes back.
 */
function showTokens(editor: Editor, live: Live, focused: boolean): void {
	for (const [index, key] of (tokenKeys.get(editor) ?? []).entries()) {
		const state = key.getState(editor.state);
		if (state === undefined || !state.active) continue;
		const trigger = live.props.suggestions?.[index];
		trigger?.onChange(focused ? openToken(editor, live, key, state.query ?? "", state.range) : null);
	}
}

/** One @tiptap/suggestion plugin per trigger the box has. */
function suggestionPlugins(editor: Editor, live: Live): Plugin[] {
	const keys: TokenKey[] = [];
	const plugins = (live.props.suggestions ?? []).map((first, index) => {
		const key: TokenKey = new PluginKey(`plainTextSuggestion${index}`);
		keys.push(key);
		const trigger = (): SuggestionTrigger | undefined => live.props.suggestions?.[index];
		const report = ({ query, range }: { readonly query: string; readonly range: { readonly from: number; readonly to: number } }): void => {
			// A box without the focus shows no list (showTokens shows it once the focus is back).
			if (editor.view.hasFocus()) trigger()?.onChange(openToken(editor, live, key, query, range));
		};
		const { spec } = Suggestion({
			editor,
			pluginKey: key,
			char: first.char,
			// The composer draws its own list: nothing to fetch, so each change is reported at once.
			minQueryLength: Number.POSITIVE_INFINITY,
			dismissOnOutsideClick: false,
			findSuggestionMatch: ({ $position }) => findToken(trigger(), $position.doc, $position.pos),
			// No token opens while an IME composes; one already open follows the composed text.
			allow: ({ isActive }) => isActive || !isComposing(editor, live),
			// A token closed by Esc opens again once the text changes, as Telegram Web A does.
			shouldResetDismissed: ({ transaction }) => transaction.docChanged || transaction.getMeta(REOPEN) === true,
			render: () => ({ onStart: report, onUpdate: report, onExit: () => trigger()?.onChange(null) }),
		});
		// Keys go through the box's handleKeyDown, and the token gets no decoration:
		// the text an IME composes in stays as typed, never wrapped in a span.
		return new Plugin({ ...spec, props: {} });
	});
	tokenKeys.set(editor, keys);
	return plugins;
}

/** Hands a key to the open token's list first; Esc that it takes closes the token. */
function tokenKeyDown(editor: Editor, live: Live, view: EditorView, event: KeyboardEvent): boolean {
	for (const [index, key] of (tokenKeys.get(editor) ?? []).entries()) {
		if (key.getState(view.state)?.active !== true) continue;
		if (live.props.suggestions?.[index]?.onKeyDown?.(event) !== true) continue;
		if (event.key === "Escape") exitSuggestion(view, key);
		return true;
	}
	return false;
}

/** Closes the open tokens (the composer closed its list); they open again once the text changes. */
export function closeTokens(editor: Editor): void {
	if (editor.isDestroyed) return;
	const { view } = editor;
	const open = (tokenKeys.get(editor) ?? []).filter((key) => key.getState(view.state)?.active === true);
	if (open.length === 0) return;
	const tr = view.state.tr;
	for (const key of open) tr.setMeta(key, { exit: true });
	view.dispatch(tr);
}

/** Opens again a token that was closed, where the caret is. */
export function reopenTokens(editor: Editor): void {
	if (editor.isDestroyed || (tokenKeys.get(editor) ?? []).length === 0) return;
	editor.view.dispatch(editor.state.tr.setMeta(REOPEN, true).setMeta("addToHistory", false));
}

// ------------------------------------------------------------ the editor

/** The editor on the element React renders (`mount`), as Telegram Web mounts it on its own input. */
export function createEditor(element: HTMLDivElement, live: Live): Editor {
	const initial = live.props.value;
	const editor: Editor = new Editor({
		element: { mount: element },
		injectCSS: false,
		enableInputRules: false,
		enablePasteRules: false,
		editable: live.props.disabled !== true,
		extensions: [
			OneParagraph,
			Paragraph,
			Text,
			HardBreak.configure({ keepMarks: false }),
			EnterBreaks,
			UndoRedo,
			// A disabled box still says what it is for, as a disabled textarea did.
			Placeholder.configure({ placeholder: () => live.props.placeholder ?? "", showOnlyWhenEditable: false }),
			Extension.create({
				name: "plainTextLimits",
				addProseMirrorPlugins() {
					return [maxLengthPlugin(live), ...suggestionPlugins(this.editor, live)];
				},
			}),
		],
		content: { type: "doc", content: [{ type: "paragraph" }] },
		editorProps: {
			attributes: () => live.attributes(),
			handleKeyDown: (view, event) => {
				const imeEnter = event.key === "Enter" && event.timeStamp - live.composedAt < AFTER_COMPOSITION_MS;
				// Keys typed into an IME belong to it: the lists and the composers never see them.
				if (live.composing || view.composing || event.isComposing || event.keyCode === 229 || imeEnter) return false;
				if (tokenKeyDown(editor, live, view, event)) return true;
				live.props.onKeyDown?.(event);
				return event.defaultPrevented;
			},
			handlePaste: (view, event) => {
				live.props.onPaste?.(event);
				if (event.defaultPrevented) return true;
				const text = event.clipboardData?.getData("text/plain") ?? "";
				if (text !== "" && view.editable) insertPlain(view, text, live.props.maxLength);
				return true;
			},
			handleDrop: (view, event, _slice, moved) => {
				// Files go on to the screen's drop zone (attachments).
				const transfer = event.dataTransfer;
				if (transfer === null || [...transfer.types].includes("Files")) return true;
				const text = transfer.getData("text/plain");
				const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
				if (text === "" || at === null || !view.editable) return true;
				const tr = view.state.tr;
				if (moved) tr.deleteSelection();
				const pos = Math.min(Math.max(1, tr.mapping.map(at.pos)), tr.doc.content.size - 1);
				tr.setSelection(PmTextSelection.create(tr.doc, pos));
				insertPlain(view, text, live.props.maxLength, tr);
				view.focus();
				return true;
			},
			handleDOMEvents: {
				compositionstart: () => {
					live.composing = true;
					return false;
				},
				compositionend: (_view, event) => {
					live.composing = false;
					live.composedAt = event.timeStamp;
					// A value set while composing is written once the composed text is in the document.
					setTimeout(() => writeOutside(editor, live), 0);
					return false;
				},
				blur: () => {
					showTokens(editor, live, false);
					return false;
				},
				focus: () => {
					showTokens(editor, live, true);
					return false;
				},
			},
		},
		onUpdate: ({ editor: current, transaction }) => {
			if (transaction.getMeta(OUTSIDE) === true) return;
			const text = plainText(current.state.doc);
			if (text === live.shown) return;
			live.shown = text;
			const { from, to } = current.state.selection;
			live.props.onValueChange(text, valueSelection(current.state.doc, from, to));
		},
	});
	live.shown = "";
	if (initial !== "") writeOutside(editor, live);
	return editor;
}

/** Writes the value set from outside when it differs from the document, the caret where asked or at the end. */
export function writeOutside(editor: Editor, live: Live): void {
	if (editor.isDestroyed || isComposing(editor, live)) return;
	const value = live.props.value;
	const wanted = live.pending;
	live.pending = null;
	live.shown = value;
	const doc = editor.state.doc;
	if (plainText(doc) === value) return;
	const tr = editor.state.tr.replaceWith(1, doc.content.size - 1, inlineNodes(editor.schema, value));
	tr.setSelection(pmSelection(tr.doc, wanted ?? { start: value.length, end: value.length }));
	editor.view.dispatch(tr.setMeta(OUTSIDE, true).setMeta("addToHistory", false));
}

/** Redraws the attributes and the placeholder: an empty transaction, outside history. */
export function refresh(editor: Editor): void {
	if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(OUTSIDE, true).setMeta("addToHistory", false));
}

/** The selection in the value. */
export function selectionOf(editor: Editor): TextSelection {
	const { from, to } = editor.state.selection;
	return valueSelection(editor.state.doc, from, to);
}

/** Selects a value range, outside history. */
export function selectValueRange(editor: Editor, selection: TextSelection): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setSelection(pmSelection(editor.state.doc, selection)).setMeta("addToHistory", false));
}

/** Replaces the selection with text as typing would; nothing while disabled or while an IME composes. */
export function insertText(editor: Editor, live: Live, text: string): void {
	if (editor.isDestroyed || !editor.isEditable || isComposing(editor, live)) return;
	live.pending = null;
	insertPlain(editor.view, text, live.props.maxLength);
}

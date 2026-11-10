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
import { Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import { TextSelection as PmTextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Offsets in the plain text value; start <= end. */
export interface TextSelection {
	readonly start: number;
	readonly end: number;
}

/** What the editor reads from the box's latest props. */
export interface EditorProps {
	readonly value: string;
	readonly placeholder?: string | undefined;
	readonly disabled?: boolean | undefined;
	readonly onValueChange: (value: string, selection: TextSelection) => void;
	readonly onSelectionChange?: ((selection: TextSelection) => void) | undefined;
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

/** Replaces the selection with plain text, the caret after it. */
export function insertPlain(view: EditorView, text: string, tr: Transaction = view.state.tr): void {
	const { from, to } = tr.selection;
	tr.replaceWith(from, to, inlineNodes(view.state.schema, text));
	tr.setSelection(PmTextSelection.create(tr.doc, Math.min(from + text.replace(/\r\n?/g, "\n").length, tr.doc.content.size - 1)));
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
		],
		content: { type: "doc", content: [{ type: "paragraph" }] },
		editorProps: {
			attributes: () => live.attributes(),
			handleKeyDown: (view, event) => {
				const imeEnter = event.key === "Enter" && event.timeStamp - live.composedAt < AFTER_COMPOSITION_MS;
				// Keys typed into an IME belong to it: the composers never see them.
				if (live.composing || view.composing || event.isComposing || event.keyCode === 229 || imeEnter) return false;
				live.props.onKeyDown?.(event);
				return event.defaultPrevented;
			},
			handlePaste: (view, event) => {
				live.props.onPaste?.(event);
				if (event.defaultPrevented) return true;
				const text = event.clipboardData?.getData("text/plain") ?? "";
				if (text !== "" && view.editable) insertPlain(view, text);
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
				insertPlain(view, text, tr);
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
		onSelectionUpdate: ({ editor: current }) => {
			const { from, to } = current.state.selection;
			live.props.onSelectionChange?.(valueSelection(current.state.doc, from, to));
		},
	});
	live.shown = "";
	if (initial !== "") writeOutside(editor, live);
	return editor;
}

/** Writes the value set from outside when it differs from the document, the caret where asked or at the end. */
export function writeOutside(editor: Editor, live: Live): void {
	if (editor.isDestroyed || live.composing || editor.view.composing) return;
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

/** Selects a value range, outside history. */
export function selectValueRange(editor: Editor, selection: TextSelection): void {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setSelection(pmSelection(editor.state.doc, selection)).setMeta("addToHistory", false));
}

// Where a copy was made, for Advisor: screens declare their context on their
// own root element (useAdvisorScope), nested scopes add to the ones around
// them (the session names the machine, folder and thread; its Source Control
// adds the panel, branch and the failed action), and the route gives the
// outermost one (a plain chat only says "chat": no id, no name). A copy reads
// the scopes around the copied text (the DOM selection, or the control that
// copied), so a copy made in the terminal beside a session gets the
// session's context. A screen holding secrets (bot tokens, webhook commands,
// Advisor's key, sign-in secrets) marks itself with data-advisor-ignore:
// nothing copied there is kept. Neither is text that looks like a secret
// (the patterns shared with the machine). xterm keeps its selection in its
// own model, not the DOM: the terminal reports its copies itself. The app's
// copy buttons write the clipboard without a copy event: while Advisor
// listens it watches those writes (watchClipboardWrites), so no button needs
// to know about it and the startup bundle carries nothing of it.
import { useEffect, type RefObject } from "react";
import { secretShapeIn } from "@achoo254/chat-remote-protocol";
import { advisorStore, EMPTY_CONTEXT, MAX_COPY_CHARS, type AdvisorStore, type CopyContext } from "./advisor-store.ts";

/** A press older than this is not what wrote the clipboard (a key did, on the focused control). */
const PRESS_MS = 1_000;

/** Marks an element whose copies Advisor never keeps (a screen with secrets). */
export const IGNORE_ATTR = "data-advisor-ignore";

/** What a screen declares; fields it does not know stay undeclared (inner scopes override outer ones). */
export type ScopeContext = Partial<CopyContext>;

const scopes = new WeakMap<Element, ScopeContext>();
let routeContext: ScopeContext = {};

/** The outermost context, from the route the app shows (messaging-root.tsx through the mascot). */
export function setRouteContext(context: ScopeContext): void {
	routeContext = context;
}

/**
 * Declares the context of the element `ref` holds, for copies made inside
 * it. Runs after every render, so a change (a new failure, another branch)
 * holds for the next copy.
 */
export function useAdvisorScope(ref: RefObject<Element | null>, context: ScopeContext): void {
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		scopes.set(element, context);
		return () => {
			scopes.delete(element);
		};
	});
}

/** The session shown now, for the mascot's automatic mode switch; cleared when the session closes. */
export function useAdvisorSession(machine: string, threadId: string, store: AdvisorStore = advisorStore): void {
	useEffect(() => {
		store.setSession({ machine, threadId });
		return () => {
			const shown = store.snapshot().session;
			if (shown?.machine === machine && shown.threadId === threadId) store.setSession(null);
		};
	}, [machine, threadId, store]);
}

function elementOf(node: Node | null): Element | null {
	if (node === null) return null;
	return node instanceof Element ? node : node.parentElement;
}

/** The context of a copy made at `node`; null when it was made where secrets show. */
export function contextAt(node: Node | null): CopyContext | null {
	const layers: ScopeContext[] = [];
	for (let element = elementOf(node); element !== null; element = element.parentElement) {
		if (element.hasAttribute(IGNORE_ATTR)) return null;
		const scope = scopes.get(element);
		if (scope !== undefined) layers.push(scope);
	}
	let context: CopyContext = { ...EMPTY_CONTEXT };
	// Outermost first, so the innermost declaration of a field wins.
	for (const layer of [routeContext, ...layers.reverse()]) {
		const { fields, ...own } = layer;
		for (const [key, value] of Object.entries(own) as [Exclude<keyof CopyContext, "fields">, string | undefined][]) {
			if (value !== undefined) context = { ...context, [key]: value };
		}
		if (fields !== undefined) context = { ...context, fields: { ...context.fields, ...fields } };
	}
	return context;
}

/**
 * Keeps a copy for Advisor's chip (memory only, five at most), unless it was
 * made where secrets show or looks like a secret itself. True when kept.
 */
export function rememberCopy(text: string, at: Node | null, store: AdvisorStore = advisorStore): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return false;
	const context = contextAt(at);
	if (context === null || secretShapeIn(trimmed) !== undefined) return false;
	// A field that looks like a secret is dropped, not the copy.
	const fields = Object.fromEntries(Object.entries(context.fields).filter(([, value]) => secretShapeIn(value) === undefined));
	store.remember(trimmed.slice(0, MAX_COPY_CHARS), { ...context, fields });
	return true;
}

/** Writes `text` to the clipboard and keeps it for Advisor with the context at `at` (the control that copied). */
export async function copyWithContext(text: string, at: Node | null): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		return false;
	}
	rememberCopy(text, at);
	return true;
}

/** The text a copy event takes: a field's selection (never a password's), else the page's. */
function copiedText(doc: Document, target: EventTarget | null): string {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		if (target instanceof HTMLInputElement && target.type === "password") return "";
		const { selectionStart, selectionEnd, value } = target;
		if (selectionStart !== null && selectionEnd !== null && selectionEnd > selectionStart) return value.slice(selectionStart, selectionEnd);
	}
	return doc.getSelection()?.toString() ?? "";
}

/**
 * A selection that starts, ends or runs through a screen with secrets (a
 * drag from the warning above a token down over it, ⌘A): the whole copy is
 * dropped, not only when it starts there.
 */
export function selectionTouchesSecrets(doc: Document): boolean {
	const selection = doc.getSelection();
	if (selection === null) return false;
	const marked = [...doc.querySelectorAll(`[${IGNORE_ATTR}]`)];
	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		if (contextAt(range.startContainer) === null || contextAt(range.endContainer) === null || contextAt(range.commonAncestorContainer) === null) return true;
		if (marked.some((element) => range.intersectsNode(element))) return true;
	}
	return false;
}

/**
 * The app's copy buttons (messaging/ui/parts.tsx copyText, the terminal's
 * keys) call navigator.clipboard.writeText, which fires no copy event. While
 * Advisor listens, each write is kept with the context of the control that
 * wrote it: the one pressed just before (Safari leaves the focus where it
 * was on a click), else the focused one (a key). A button in a screen with
 * secrets is inside data-advisor-ignore, so its text is never kept. The
 * clipboard's own method comes back when it stops.
 */
/** Watchers stopped while another one wrapped them, with what they wrapped: the outer one skips them when it stops. */
const stoppedWatchers = new WeakMap<Clipboard["writeText"], Clipboard["writeText"]>();

function watchClipboardWrites(doc: Document, store: AdvisorStore): () => void {
	const clipboard = doc.defaultView?.navigator.clipboard;
	if (clipboard === undefined || typeof clipboard.writeText !== "function") return () => undefined;
	const original = clipboard.writeText;
	// The method may be the prototype's (a browser) or the object's own (a stand-in): it is put back as it was.
	const own = Object.prototype.hasOwnProperty.call(clipboard, "writeText");
	let active = true;
	let pressed: { readonly node: Node | null; readonly at: number } | null = null;
	const onPress = (event: Event) => {
		// On the same clock as the write's check (an event's timeStamp is not always).
		pressed = { node: event.target instanceof Node ? event.target : null, at: performance.now() };
	};
	const watched = async (text: string): Promise<void> => {
		const recent = pressed !== null && performance.now() - pressed.at < PRESS_MS ? pressed.node : null;
		const at = recent ?? doc.activeElement;
		await original.call(clipboard, text);
		// A watcher stopped while another wraps it still passes writes on, keeping nothing.
		if (active) rememberCopy(text, at, store);
	};
	clipboard.writeText = watched;
	doc.addEventListener("pointerdown", onPress, true);
	return () => {
		active = false;
		doc.removeEventListener("pointerdown", onPress, true);
		if (clipboard.writeText !== watched) {
			// Another watcher wraps this one: it passes writes on until that one stops and unwraps past it.
			stoppedWatchers.set(watched, original);
			return;
		}
		let restore = original;
		for (let inner = stoppedWatchers.get(restore); inner !== undefined; inner = stoppedWatchers.get(restore)) restore = inner;
		if (restore !== original || own) clipboard.writeText = restore;
		else Reflect.deleteProperty(clipboard, "writeText");
	};
}

/**
 * Listens for copies anywhere on the page (capture, so no screen can hide
 * one) and for the app's copy buttons (watchClipboardWrites); returns the
 * function that stops. Copies inside xterm are left to the terminal (its
 * selection is not the page's).
 */
export function listenForCopies(doc: Document = document, store: AdvisorStore = advisorStore): () => void {
	const onCopy = (event: Event) => {
		const target = event.target instanceof Node ? event.target : null;
		if (elementOf(target)?.closest(".xterm") != null) return;
		const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
		if (!field && selectionTouchesSecrets(doc)) return;
		const text = copiedText(doc, event.target);
		const anchor = field ? target : (doc.getSelection()?.anchorNode ?? target);
		rememberCopy(text, anchor, store);
	};
	doc.addEventListener("copy", onCopy, true);
	const unwatch = watchClipboardWrites(doc, store);
	return () => {
		doc.removeEventListener("copy", onCopy, true);
		unwatch();
	};
}

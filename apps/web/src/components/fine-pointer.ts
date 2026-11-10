/**
 * Whether the main pointer is a mouse or trackpad with a keyboard to match (a
 * laptop or desktop). Opening a chat then puts the caret in its message box; on a
 * phone or tablet that would raise the keyboard over the chat every time one opens.
 */
export function hasFinePointer(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

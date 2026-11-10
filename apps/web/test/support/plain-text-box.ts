// The message boxes are editors (components/plain-text-box.tsx), not
// textareas: their value is the text of their paragraph, a <br> a line break.

/** The value a message box shows, "\n" for each line break. */
export function boxValue(box: HTMLElement): string {
	return [...box.querySelectorAll("p")]
		.map((paragraph) =>
			[...paragraph.childNodes]
				.map((node) => {
					if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
					// ProseMirror keeps an empty last line open with a break of its own.
					if (node instanceof HTMLBRElement) return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
					return node.textContent ?? "";
				})
				.join(""),
		)
		.join("\n");
}

/** The placeholder a message box shows while empty. */
export function boxPlaceholder(box: HTMLElement): string | null {
	return box.getAttribute("aria-placeholder");
}

/** The message box showing this placeholder (getByPlaceholderText only knows inputs and textareas). */
export function getBoxByPlaceholder(placeholder: string): HTMLElement {
	const box = [...document.querySelectorAll<HTMLElement>('[role="textbox"][aria-placeholder]')].find((element) => boxPlaceholder(element) === placeholder);
	if (box === undefined) throw new Error(`no message box with the placeholder "${placeholder}"`);
	return box;
}

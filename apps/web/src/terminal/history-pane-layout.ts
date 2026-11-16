// How the history pane (history-pane.ts) writes its pages into its terminal: all of them again, oldest first, the
// screen not drawn until done (synchronized output), each page measured in lines at the current width. Past the
// line cap, pages furthest from the rows in view go (the pane asks for them again when scrolled back to). The row
// at the bottom of the view is kept there across a rewrite, whatever was added, dropped or rewrapped.
import type { Terminal } from "@xterm/xterm";

/** Lines the pane holds at most once measured, as drawn at its width (a taller terminal is slow to write and scroll). */
export const MAX_HISTORY_LINES = 5_000;
/**
 * The pane terminal's own history: far past the cap, so a rewrite at a narrower width (rows wrap into more lines)
 * never makes xterm drop lines before they are measured and cut by page. xterm allocates lines only as they fill.
 */
export const HISTORY_SCROLLBACK = 1_000_000;

export interface Page {
	readonly firstRow: number;
	readonly rowCount: number;
	readonly atStart: boolean;
	/** The rows as the machine sent them, without the last CR LF. */
	readonly vt: Uint8Array;
	/** Lines it takes at the pane's width, measured when last written (0: not written yet). */
	lines: number;
}

/** The row at the bottom of the view: the page it belongs to and the line within it. */
export type Anchor = { readonly firstRow: number; readonly offset: number } | null;

const enc = new TextEncoder();
/** Writing again starts from a clean terminal, its cursor hidden; the screen is not drawn until all of it is written. */
const BEGIN = enc.encode("\x1bc\x1b[?2026h\x1b[?25l");
const END = enc.encode("\x1b[?2026l");
const CRLF = enc.encode("\r\n");

/** Lines the pages take: as measured, or a row a line for one not written yet. */
export function linesOf(pages: readonly Page[]): number {
	return pages.reduce((n, p) => n + (p.lines > 0 ? p.lines : p.rowCount), 0);
}

export function anchorOf(term: Terminal, pages: readonly Page[]): Anchor {
	if (pages.length === 0) return null;
	let line = term.buffer.active.viewportY + term.rows - 1;
	for (const page of pages) {
		if (line < page.lines) return { firstRow: page.firstRow, offset: line };
		line -= page.lines;
	}
	const last = pages.at(-1);
	return last === undefined ? null : { firstRow: last.firstRow, offset: Math.max(0, last.lines - 1) };
}

/**
 * Writes `pages` into `term` at `cols` × `rows` and measures them; `done` gets the lines they take. `current` false
 * (a newer write began) stops the callbacks.
 */
export function writePages(term: Terminal, pages: readonly Page[], size: { readonly cols: number; readonly rows: number }, current: () => boolean, done: (lines: number) => void): void {
	const position = () => term.buffer.active.baseY + term.buffer.active.cursorY;
	// Written at the full height (rows beyond the screen go to the terminal's history); resized once drawing waits.
	term.write(BEGIN, () => {
		if (current() && (term.cols !== size.cols || term.rows !== size.rows)) term.resize(size.cols, size.rows);
	});
	let lines = 0;
	pages.forEach((page, i) => {
		term.write(i === 0 ? page.vt : concat(CRLF, page.vt), () => {
			if (!current()) return;
			page.lines = Math.max(1, position() + 1 - lines);
			lines += page.lines;
		});
	});
	term.write(END, () => {
		if (current()) done(lines);
	});
}

/** The side to cut when nothing was just added: away from the rows in view. */
export function farSide(pages: readonly Page[], anchor: Anchor): "top" | "bottom" {
	const at = anchor === null ? pages.length - 1 : pages.findIndex((p) => p.firstRow === anchor.firstRow);
	return at < pages.length / 2 ? "bottom" : "top";
}

/** Drops pages from `side` (in place) until the rest fits the cap, one at least; true when any went. */
export function trimPages(pages: Page[], side: "top" | "bottom", lines: number): boolean {
	let total = lines;
	let dropped = false;
	while (total > MAX_HISTORY_LINES && pages.length > 1) {
		const page = side === "bottom" ? pages.pop() : pages.shift();
		total -= page?.lines ?? 0;
		dropped = true;
	}
	return dropped;
}

/** Scrolls so the anchored row is at the bottom of the view again; to the side it was on if its page went. */
export function restoreAnchor(term: Terminal, pages: readonly Page[], anchor: Anchor): void {
	if (anchor === null) {
		term.scrollToBottom();
		return;
	}
	let line = 0;
	for (const page of pages) {
		if (page.firstRow === anchor.firstRow) {
			const bottom = line + Math.min(anchor.offset, Math.max(0, page.lines - 1));
			term.scrollToLine(Math.min(term.buffer.active.baseY, Math.max(0, bottom - term.rows + 1)));
			return;
		}
		line += page.lines;
	}
	const first = pages[0];
	if (first !== undefined && anchor.firstRow < first.firstRow) term.scrollToTop();
	else term.scrollToBottom();
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

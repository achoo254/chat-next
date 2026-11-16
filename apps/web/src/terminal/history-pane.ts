// The history of a session from before this page opened it: rows before the live screen's `historyEnd`
// (LiveScreen), loaded a page at a time as the user scrolls up, in a read-only terminal of its own that sits above
// the live one (history-scroll.ts moves between them). A page goes on top by writing the pages again, oldest
// first, and the rows in view stay in view (history-pane-layout.ts). The pane holds at most MAX_HISTORY_LINES
// lines as drawn at the current width: past that, pages furthest from where the user reads go, and come back when
// scrolled to again.
// A status line says when a page loads, the top of the history, that a program cleared what was before, or that
// the history could not be loaded.
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { HISTORY_SCROLLBACK, MAX_HISTORY_LINES, anchorOf, farSide, linesOf, restoreAnchor, trimPages, writePages, type Anchor, type Page } from "./history-pane-layout.ts";
import type { HistoryReply } from "./terminal-history-requests.ts";
import type { HistoryLife } from "./terminal-link.ts";
import { MAX_HISTORY_ROWS } from "./terminal-wire.ts";

export { MAX_HISTORY_LINES };
/** A page loads while the rows in view are within this many screens of the end of what is loaded. */
export const LOAD_AHEAD_SCREENS = 3;
/** After a failure, a scroll asks again at most this often. */
export const RETRY_MS = 2_000;

export interface HistoryLabels {
	readonly loading: string;
	readonly start: string;
	readonly cleared: string;
	readonly failed: string;
}

export interface HistoryPaneDeps {
	/** The pane's box: the history goes in it, above the live terminal. */
	readonly host: HTMLElement;
	/** The live terminal's look (font, colours). */
	readonly options: () => ITerminalOptions;
	/** The live terminal's size: the history is as wide, and at most as tall. */
	readonly cols: () => number;
	readonly rows: () => number;
	/** A page: up to `maxRows` rows before `beforeRow`, for the screen that started `life` (TerminalLink.history). */
	readonly load: (life: HistoryLife, beforeRow: number, maxRows: number) => Promise<HistoryReply>;
	readonly labels: () => HistoryLabels;
	/** The history's height or rows changed: lay it out again. */
	readonly changed: () => void;
	/** A click in the history: the keyboard goes back to the live terminal (the selection stays). */
	readonly focusLive?: () => void;
	readonly now?: () => number;
}

type Status = "idle" | "loading" | "failed" | "cleared" | "start";

export class HistoryPane {
	readonly box: HTMLDivElement;
	readonly status: HTMLParagraphElement;
	private readonly screen: HTMLDivElement;
	private term: Terminal | null = null;
	private life: HistoryLife | null = null;
	private pages: Page[] = [];
	private state: Status = "idle";
	private failedAt = -Infinity;
	/** Bumped whenever what is loaded no longer follows from what was asked (a new life, cleared): answers from before are dropped. */
	private era = 0;
	private loading = false;
	/** Pages are being written again: what is in view is not measured yet, so nothing loads meanwhile. */
	private writing = false;
	/** The write in progress; a newer one makes its callbacks moot. */
	private run = 0;

	constructor(private readonly deps: HistoryPaneDeps) {
		const box = document.createElement("div");
		box.className = "tx-history";
		box.hidden = true;
		this.screen = box.appendChild(document.createElement("div"));
		this.screen.className = "tx-history-screen";
		this.status = box.appendChild(document.createElement("p"));
		this.status.className = "tx-history-status";
		this.status.setAttribute("role", "status");
		this.status.hidden = true;
		box.addEventListener("pointerup", (event) => {
			if (event.pointerType === "mouse") this.deps.focusLive?.();
		});
		deps.host.appendChild(box);
		this.box = box;
	}

	/** The live screen started from a LiveSnapshot: history before row `end` of life `epoch` can be loaded. */
	start(epoch: number, end: number): void {
		this.reset();
		this.life = { epoch, historyEnd: end };
		this.state = end <= 0 ? "start" : "idle";
		this.deps.changed();
	}

	/** A program cleared the history (ED 3, a reset) or the screen started over: what was before is gone. */
	cleared(): void {
		if (this.life === null) return;
		this.reset();
		this.state = "cleared";
		this.deps.changed();
	}

	/** No history to load: it is all in the live terminal (a replay), or the machine does not serve it. */
	off(): void {
		if (this.life === null) return;
		this.reset();
		this.life = null;
		this.deps.changed();
	}

	get available(): boolean {
		return this.life !== null;
	}

	/** The pages loaded reach the live screen: scrolling down goes on into it. */
	get connected(): boolean {
		const last = this.pages.at(-1);
		return last === undefined || this.life === null || last.firstRow + last.rowCount >= this.life.historyEnd;
	}

	/** Rows of its screen; 0 when nothing is loaded. */
	rowsShown(): number {
		if (this.pages.length === 0) return 0;
		return this.term?.rows ?? Math.min(Math.max(1, this.deps.rows()), linesOf(this.pages));
	}

	/** The history comes into view: its terminal is made again if it went (left()), from the pages kept. */
	show(): void {
		if (this.term !== null || this.pages.length === 0) return;
		this.ensureTerm();
		this.rewrite(null, null);
	}

	/** Lines loaded above the rows in view, and below them. */
	above(): number {
		return this.term?.buffer.active.viewportY ?? 0;
	}

	below(): number {
		const buffer = this.term?.buffer.active;
		return buffer === undefined ? 0 : buffer.baseY - buffer.viewportY;
	}

	/** Scrolls by whole lines (negative: older); returns how many it moved. */
	scrollBy(lines: number): number {
		const term = this.term;
		if (term === null || lines === 0) return 0;
		const before = term.buffer.active.viewportY;
		term.scrollLines(lines);
		return Math.abs(term.buffer.active.viewportY - before);
	}

	toBottom(): void {
		this.term?.scrollToBottom();
	}

	/**
	 * The view went back to the live terminal: the pane's terminal goes (its WebGL context with it) and comes back
	 * on the next scroll up; pages not joined to the live screen go too, so that scroll starts at the join.
	 */
	left(): void {
		const joined = this.connected;
		this.dispose(false);
		if (!joined) {
			this.era += 1;
			this.loading = false;
			this.pages = [];
			if (this.state === "loading") this.state = "idle";
		}
		this.deps.changed();
	}

	/** The rows in view moved towards `side`: a page loads when they are near the end of what is loaded. */
	near(side: "older" | "newer"): void {
		if (this.life === null || this.loading || this.writing) return;
		const ahead = LOAD_AHEAD_SCREENS * Math.max(1, this.deps.rows());
		if (side === "older" && (this.pages.length === 0 || this.above() < ahead)) void this.loadOlder();
		if (side === "newer" && !this.connected && this.below() < ahead) void this.loadNewer();
	}

	/** The text selected in the history, "" when none. */
	selection(): string {
		return this.term?.getSelection() ?? "";
	}

	clearSelection(): void {
		this.term?.clearSelection();
	}

	/** The live terminal changed size or font: the history follows. */
	refit(): void {
		const term = this.term;
		if (term === null) return;
		const options = this.deps.options();
		if (options.fontSize !== undefined) term.options.fontSize = options.fontSize;
		this.rewrite(null, this.anchor());
	}

	/** Says what the history is doing, at the top of what shows of it (`top`: CSS pixels into the box). */
	showStatus(top: number): void {
		const labels = this.deps.labels();
		let text = "";
		if (this.state === "loading") text = labels.loading;
		else if (this.state === "failed") text = labels.failed;
		else if (this.state === "cleared") text = labels.cleared;
		else if (this.pages.length === 0 ? this.state === "start" : this.pages[0]?.atStart === true && this.above() === 0) text = labels.start;
		if (this.status.textContent !== text) this.status.textContent = text;
		this.status.hidden = text === "";
		this.status.style.top = `${Math.max(0, top)}px`;
	}

	dispose(removeBox = true): void {
		this.run += 1;
		this.writing = false;
		this.term?.dispose();
		this.term = null;
		this.screen.replaceChildren();
		if (removeBox) {
			this.era += 1;
			this.box.remove();
		}
	}

	// --- loading ---------------------------------------------------------------------------------

	private reset(): void {
		this.era += 1;
		this.loading = false;
		this.pages = [];
		this.failedAt = -Infinity;
		this.dispose(false);
	}

	private mayLoad(): boolean {
		if (this.state === "cleared") return false;
		return this.state !== "failed" || this.now() - this.failedAt >= RETRY_MS;
	}

	private async loadOlder(): Promise<void> {
		const life = this.life;
		const top = this.pages[0];
		if (life === null || !this.mayLoad() || top?.atStart === true || (top === undefined && this.state === "start")) return;
		const before = top?.firstRow ?? life.historyEnd;
		if (before <= 0) {
			this.state = "start";
			this.deps.changed();
			return;
		}
		await this.load(before, Math.min(MAX_HISTORY_ROWS, before), "older");
	}

	private async loadNewer(): Promise<void> {
		const life = this.life;
		const last = this.pages.at(-1);
		if (life === null || last === undefined || !this.mayLoad()) return;
		const from = last.firstRow + last.rowCount;
		const before = Math.min(life.historyEnd, from + MAX_HISTORY_ROWS);
		if (before <= from) return;
		await this.load(before, before - from, "newer");
	}

	private async load(before: number, maxRows: number, side: "older" | "newer"): Promise<void> {
		const era = this.era;
		const life = this.life;
		if (life === null) return;
		this.loading = true;
		if (side === "older") this.state = "loading";
		this.deps.changed();
		const reply = await this.deps.load(life, before, maxRows);
		if (this.era !== era) return;
		this.loading = false;
		this.take(reply, side, life.epoch);
	}

	private take(reply: HistoryReply, side: "older" | "newer", epoch: number): void {
		if (reply.kind === "dropped") {
			if (this.state === "loading") this.state = "idle";
			this.deps.changed();
			return;
		}
		if (reply.kind === "failed") {
			this.state = "failed";
			this.failedAt = this.now();
			this.deps.changed();
			return;
		}
		// Another life: a program cleared the history since the screen was taken.
		if (reply.epoch !== epoch) return this.cleared();
		this.state = "idle";
		if (reply.rowCount === 0) {
			if (side === "older") this.state = "start";
			this.deps.changed();
			return;
		}
		const page: Page = { firstRow: reply.firstRow, rowCount: reply.rowCount, atStart: reply.atStart, vt: withoutLastNewline(reply.vt), lines: 0 };
		const anchor = this.anchor();
		if (side === "older") this.pages.unshift(page);
		else this.pages.push(page);
		this.ensureTerm();
		this.rewrite(side === "older" ? "bottom" : "top", anchor);
	}

	// --- the terminal ----------------------------------------------------------------------------

	private ensureTerm(): void {
		if (this.term !== null) return;
		const term = new Terminal({
			...this.deps.options(),
			cols: Math.max(1, this.deps.cols()),
			rows: Math.max(1, this.deps.rows()),
			scrollback: HISTORY_SCROLLBACK,
			disableStdin: true,
			cursorBlink: false,
			cursorInactiveStyle: "none",
		});
		// The live terminal's widths, so rows line up as the machine drew them.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(this.screen);
		// WebGL as the live terminal: xterm's DOM renderer styles rows through a <style> the site's CSP refuses (no
		// colours, the page font). The context lives only while the history shows (left() lets it go), and a lost
		// one falls back to the DOM renderer.
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// No WebGL2 here: the DOM renderer, as the live terminal falls back to.
		}
		this.term = term;
	}

	private anchor(): Anchor {
		return this.term === null ? null : anchorOf(this.term, this.pages);
	}

	/**
	 * Writes every page again and keeps `anchor` where it was. Over the cap, pages go from `trimFrom` (the side
	 * away from a page just added), or else from the side away from the view.
	 */
	private rewrite(trimFrom: "top" | "bottom" | null, anchor: Anchor): void {
		const term = this.term;
		if (term === null) return;
		const run = ++this.run;
		this.writing = true;
		const size = { cols: Math.max(1, this.deps.cols()), rows: Math.max(1, this.deps.rows()) };
		writePages(term, this.pages, size, () => run === this.run, (lines) => {
			if (lines > MAX_HISTORY_LINES && trimPages(this.pages, trimFrom ?? farSide(this.pages, anchor), lines)) {
				// The pages that went are no longer loaded: scrolling to them asks for them again.
				this.rewrite(trimFrom, anchor);
				return;
			}
			this.writing = false;
			const shown = Math.min(size.rows, Math.max(1, lines));
			if (term.rows !== shown) term.resize(size.cols, shown);
			restoreAnchor(term, this.pages, anchor);
			this.deps.changed();
		});
	}

	private now(): number {
		return this.deps.now?.() ?? performance.now();
	}
}

function withoutLastNewline(vt: Uint8Array): Uint8Array {
	const n = vt.length;
	return n >= 2 && vt[n - 2] === 0x0d && vt[n - 1] === 0x0a ? vt.subarray(0, n - 2) : vt;
}

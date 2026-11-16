// One scroll through the history and the live terminal (history-pane.ts above, the live xterm below, a thin rule
// between): scrolling up past the top of the live terminal's own history reveals the history pane pixel by pixel,
// then scrolls the pane's lines; scrolling down does the same backwards and hands back to the live terminal at
// the rule. The pane is revealed by moving both down inside the pane's box (no scrolling container of its own),
// so the live terminal keeps its size and its own scrolling.
//
// A wheel over the live terminal stays xterm's while it has history of its own to scroll, and the program's
// while it reads the mouse (mouse tracking) or shows a full screen: Shift + wheel reaches the history then.
// A finger (TouchScroller) always goes through scroll(). A key sends the view back to the newest line (toLive).

/** The part of the live xterm this uses. */
export interface LiveTerm {
	readonly rows: number;
	readonly element: HTMLElement | undefined;
	readonly buffer: { readonly active: { readonly type: string; readonly viewportY: number; readonly baseY: number } };
	readonly modes: { readonly mouseTrackingMode: string };
	scrollLines(amount: number): void;
	scrollToBottom(): void;
}

/** The part of the history pane this uses (HistoryPane). */
export interface HistoryView {
	readonly available: boolean;
	readonly connected: boolean;
	readonly box: HTMLElement;
	rowsShown(): number;
	above(): number;
	below(): number;
	scrollBy(lines: number): number;
	toBottom(): void;
	show(): void;
	left(): void;
	near(side: "older" | "newer"): void;
	showStatus(top: number): void;
}

export interface HistoryScrollDeps {
	readonly live: LiveTerm;
	readonly pane: HistoryView;
	/** One row's height in CSS pixels. */
	readonly rowHeight: () => number;
}

/** The live terminal's own history within this many screens of its top: the first page loads ahead. */
const PREFETCH_SCREENS = 3;

export class HistoryScroll {
	/** CSS pixels of the history shown above the live terminal; 0: the live terminal fills the pane. */
	private offset = 0;
	/** Pixels scrolled that did not make a whole line yet. */
	private carry = 0;

	constructor(private readonly deps: HistoryScrollDeps) {}

	get inHistory(): boolean {
		return this.offset > 0;
	}

	/** A wheel event over the pane (listened to before xterm sees it). */
	wheel(event: WheelEvent): void {
		const { live, pane } = this.deps;
		if (!pane.available) return;
		const row = this.deps.rowHeight();
		// Shift + wheel is a sideways scroll on some systems: its distance comes as deltaX.
		let dy = event.deltaY !== 0 ? event.deltaY : event.shiftKey ? event.deltaX : 0;
		if (dy === 0 || row <= 0) return;
		if (event.deltaMode === 1) dy *= row;
		else if (event.deltaMode === 2) dy *= row * live.rows;
		if (this.offset === 0) {
			const buffer = live.buffer.active;
			const programs = buffer.type === "alternate" || live.modes.mouseTrackingMode !== "none";
			if (programs ? !event.shiftKey || dy > 0 : dy > 0 || buffer.viewportY > 0) {
				// xterm scrolls its own history (or the program takes the wheel); the first page loads ahead.
				if (!programs && dy < 0 && buffer.viewportY < PREFETCH_SCREENS * live.rows) pane.near("older");
				return;
			}
		}
		event.preventDefault();
		event.stopPropagation();
		this.scroll(dy);
	}

	/** Scrolls by `dy` CSS pixels (negative: older), across the live terminal, the rule and the history. */
	scroll(dy: number): void {
		const { live, pane } = this.deps;
		const row = this.deps.rowHeight();
		if (row <= 0 || dy === 0) return;
		const buffer = live.buffer.active;
		if (dy < 0) {
			let px = -dy;
			if (this.offset === 0 && buffer.viewportY > 0) px = this.lines(px, buffer.viewportY, (n) => live.scrollLines(-n));
			if (px > 0 && pane.available) {
				if (this.offset === 0) pane.show();
				this.carry = 0;
				const room = this.height() + 1 - this.offset;
				const take = Math.min(room, px);
				this.offset += take;
				px -= take;
				if (px > 0) this.lines(px, pane.above(), (n) => pane.scrollBy(-n));
			}
			if (this.offset > 0 || buffer.viewportY < PREFETCH_SCREENS * live.rows) pane.near("older");
		} else {
			let px = dy;
			if (this.offset > 0) {
				px = this.lines(px, pane.below(), (n) => pane.scrollBy(n));
				// Pages between here and the live screen are not loaded yet: wait for them at the bottom of the history.
				if (px > 0 && !pane.connected) px = 0;
				if (px > 0) {
					this.carry = 0;
					const take = Math.min(this.offset, px);
					this.offset -= take;
					px -= take;
					if (this.offset === 0) pane.left();
				}
				if (this.offset > 0) pane.near("newer");
			}
			if (px > 0 && this.offset === 0) this.lines(px, buffer.baseY - buffer.viewportY, (n) => live.scrollLines(n));
		}
		this.layout();
	}

	/** Back to the newest line of the live terminal (a key was typed). */
	toLive(): void {
		const { live, pane } = this.deps;
		const was = this.offset;
		this.offset = 0;
		this.carry = 0;
		pane.toBottom();
		if (was > 0) pane.left();
		live.scrollToBottom();
		this.layout();
	}

	/** Places the history and the live terminal for the offset (after a scroll, or the history changed size). */
	layout(): void {
		const { live, pane } = this.deps;
		const element = live.element;
		const height = this.height();
		this.offset = pane.available ? Math.min(this.offset, height + 1) : 0;
		if (this.offset === 0) {
			pane.box.hidden = true;
			if (element !== undefined) element.style.transform = "";
			return;
		}
		pane.box.hidden = false;
		pane.box.style.height = `${height}px`;
		pane.box.style.transform = `translateY(${this.offset - height - 1}px)`;
		if (element !== undefined) element.style.transform = `translateY(${this.offset}px)`;
		pane.showStatus(height + 1 - this.offset);
	}

	/** The history's height: its rows, or one row for its status when none is loaded. */
	private height(): number {
		const row = this.deps.rowHeight();
		return Math.max(1, this.deps.pane.rowsShown()) * row;
	}

	/** Scrolls whole lines for `px` pixels, at most `avail`; returns the pixels left over past that. */
	private lines(px: number, avail: number, move: (n: number) => void): number {
		const row = this.deps.rowHeight();
		const total = this.carry + px;
		const n = Math.floor(total / row);
		if (n <= avail) {
			if (n > 0) move(n);
			this.carry = total - n * row;
			return 0;
		}
		if (avail > 0) move(avail);
		this.carry = 0;
		return total - avail * row;
	}
}

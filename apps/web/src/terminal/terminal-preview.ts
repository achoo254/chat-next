// A long session opened fresh replays every byte since it began (the owner's
// rule: no line is cut), which takes seconds over the relay and would show
// its whole history scrolling past. The machine first sends the session as it
// renders it now (TerminalSink.preview): this cover shows that at once, in a
// read-only terminal over the pane, while the real one takes the replay out of
// sight. Once the replay reached the preview and the output went quiet (the
// program redraws for this screen's size right after attaching), the real
// terminal shows, at its newest line, and the cover goes.
//
// The cover looks like the real terminal (WebGL: xterm's DOM renderer styles its rows with a <style> the
// site's CSP refuses, which drew them in the page font without colours), and the pane is usable under it:
// the real terminal is only transparent, so it keeps the keyboard, and what is typed reaches the program
// while the replay catches up. A small chip says the rows shown are still being brought up to date.
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { RenderedScreen } from "./terminal-link.ts";

/** After the replay caught up, output quiet this long means the program is done redrawing. */
export const QUIET_MS = 150;
/** After catching up, the real terminal shows at the latest this long later, quiet or not (a turn may stream on). */
export const SETTLE_MAX_MS = 1_500;
/** Whatever happens, the cover goes this long after it showed: a replay that never ends is still shown. */
export const COVER_MAX_MS = 15_000;
/** Rows of history the cover keeps: the machine's rendering carries at most a few hundred. */
const COVER_SCROLLBACK = 1_000;

export interface PreviewCoverDeps {
	/** Where the cover goes: the pane's box, the real terminal's element inside it. */
	readonly host: HTMLElement;
	/** The real terminal's element: hidden while the cover shows. */
	readonly real: () => HTMLElement | undefined;
	/** Brings the real terminal to its newest line when it shows. */
	readonly showReal: () => void;
	/** The cover takes the real terminal's look (font, colours). */
	readonly options: () => ConstructorParameters<typeof Terminal>[0];
	/**
	 * The pane's size: the rendering is for the session's size on the machine (maybe another device's), and is fitted
	 * to the pane once written, so its newest rows stay in sight (rows that no longer fit go to the cover's history).
	 */
	readonly size: () => { readonly cols: number; readonly rows: number };
	/** A click on the cover gives the keyboard to the real terminal under it. */
	readonly focusReal?: () => void;
	/** What the chip over the cover says while the replay catches up. */
	readonly label?: string;
	readonly now?: () => number;
}

export class PreviewCover {
	private term: Terminal | null = null;
	private box: HTMLDivElement | null = null;
	private shownAt = 0;
	private caughtUpAt: number | null = null;
	private lastOutputAt = 0;
	private timer: number | null = null;

	constructor(private readonly deps: PreviewCoverDeps) {}

	private now(): number {
		return this.deps.now?.() ?? performance.now();
	}

	/** Covers the pane with the machine's rendering; the real terminal goes out of sight. */
	show(preview: RenderedScreen): void {
		this.clear();
		const box = document.createElement("div");
		box.className = "tx-preview";
		// The cover's own terminal never takes the focus: a click goes to the real one under it.
		box.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse") event.preventDefault();
			this.deps.focusReal?.();
		});
		const screen = box.appendChild(document.createElement("div"));
		screen.className = "tx-preview-screen";
		screen.setAttribute("aria-hidden", "true");
		if (this.deps.label !== undefined && this.deps.label !== "") {
			const chip = box.appendChild(document.createElement("p"));
			chip.className = "tx-preview-chip";
			chip.setAttribute("role", "status");
			chip.textContent = this.deps.label;
		}
		this.deps.host.appendChild(box);
		const term = new Terminal({ ...this.deps.options(), cols: preview.cols, rows: preview.rows, scrollback: COVER_SCROLLBACK, disableStdin: true, cursorBlink: false });
		// The real terminal's widths (emoji, wide characters), so the rows line up as the machine drew them.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(screen);
		try {
			term.loadAddon(new WebglAddon());
		} catch {
			// No WebGL2 here: the DOM renderer, as the real terminal falls back to.
		}
		this.term = term;
		this.box = box;
		term.write(preview.vt, () => {
			if (this.term !== term) return;
			const { cols, rows } = this.deps.size();
			if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) term.resize(cols, rows);
			term.scrollToBottom();
		});
		this.hideReal(true);
		this.shownAt = this.now();
		this.caughtUpAt = null;
		this.tick();
	}

	/** Output went to the real terminal (the replay, or the program redrawing). */
	output(): void {
		this.lastOutputAt = this.now();
	}

	/** The replay reached what the cover shows: the real terminal shows once the output is quiet. */
	caughtUp(): void {
		if (this.term === null) return;
		this.caughtUpAt = this.now();
	}

	get showing(): boolean {
		return this.term !== null;
	}

	/** The pane goes: nothing left behind. */
	dispose(): void {
		this.clear();
	}

	/** Checks every 50 ms whether the real terminal may show. */
	private tick(): void {
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (this.term === null) return;
			const now = this.now();
			const settled = this.caughtUpAt !== null && (now - this.lastOutputAt >= QUIET_MS || now - this.caughtUpAt >= SETTLE_MAX_MS);
			if (settled || now - this.shownAt >= COVER_MAX_MS) this.reveal();
			else this.tick();
		}, 50);
	}

	private reveal(): void {
		this.clear();
		this.deps.showReal();
	}

	private hideReal(hidden: boolean): void {
		const real = this.deps.real();
		// Transparent, not hidden or removed: the real terminal keeps its size, takes the replay out of sight and
		// keeps the keyboard, so typing during the catch-up reaches the program.
		if (real !== undefined) real.style.opacity = hidden ? "0" : "";
	}

	private clear(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.term?.dispose();
		this.term = null;
		this.box?.remove();
		this.box = null;
		this.caughtUpAt = null;
		this.hideReal(false);
	}
}

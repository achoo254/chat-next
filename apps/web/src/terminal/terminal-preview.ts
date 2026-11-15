// A long session opened fresh replays every byte since it began (the owner's
// rule: no line is cut), which takes seconds over the relay and would show
// its whole history scrolling past. The machine first sends the session as it
// renders it now (TerminalSink.preview): this cover shows that at once, in a
// read-only terminal over the pane, while the real one takes the replay out of
// sight. Once the replay reached the preview and the output went quiet (the
// program redraws for this screen's size right after attaching), the real
// terminal shows, at its newest line, and the cover goes.
import { Unicode11Addon } from "@xterm/addon-unicode11";
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
		box.setAttribute("aria-hidden", "true");
		this.deps.host.appendChild(box);
		const term = new Terminal({ ...this.deps.options(), cols: preview.cols, rows: preview.rows, scrollback: COVER_SCROLLBACK, disableStdin: true, cursorBlink: false });
		// The real terminal's widths (emoji, wide characters), so the rows line up as the machine drew them.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(box);
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
		// Hidden, not removed: the real terminal keeps its size and takes the replay while out of sight.
		if (real !== undefined) real.style.visibility = hidden ? "hidden" : "";
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

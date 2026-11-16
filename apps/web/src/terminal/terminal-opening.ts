// A pane that just attached keeps the loading screen until its terminal has something to show: the dock's
// "opening" screen hands over to the same screen in the pane, and the pane appears drawn, not empty, half
// replayed or redrawing. It opens once the first output went quiet (the program finished drawing for this
// pane's size), at once when the machine's preview covers it, and after a bounded wait whatever happens.

/** After the first output, quiet this long means the terminal is drawn. */
export const OPEN_QUIET_MS = 120;
/** After the first output, the terminal shows at the latest this long later (output may stream on). */
export const OPEN_SETTLE_MS = 1_200;
/** Nothing came at all (an idle session that drew nothing yet): the terminal shows anyway. */
export const OPEN_MAX_MS = 4_000;
const TICK_MS = 50;

export class OpeningGate {
	private readonly startedAt: number;
	private firstAt: number | null = null;
	private lastAt = 0;
	private timer: number | null = null;
	private done = false;

	constructor(
		private readonly onOpen: () => void,
		private readonly now: () => number = () => performance.now(),
	) {
		this.startedAt = this.now();
		this.tick();
	}

	get opened(): boolean {
		return this.done;
	}

	/** Output reached the terminal (a snapshot, the replay, the program drawing). */
	content(): void {
		if (this.done) return;
		const now = this.now();
		this.firstAt ??= now;
		this.lastAt = now;
	}

	/** Something else shows the session now (the preview, the end of the session): no reason to wait. */
	open(): void {
		if (this.done) return;
		this.stop();
		this.done = true;
		this.onOpen();
	}

	/** The pane goes: no callback after this. */
	dispose(): void {
		this.stop();
		this.done = true;
	}

	private tick(): void {
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (this.done) return;
			const now = this.now();
			const drawn = this.firstAt !== null && (now - this.lastAt >= OPEN_QUIET_MS || now - this.firstAt >= OPEN_SETTLE_MS);
			if (drawn || now - this.startedAt >= OPEN_MAX_MS) this.open();
			else this.tick();
		}, TICK_MS);
	}

	private stop(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}

// Vertical swipes on the terminal of a touch screen. xterm 6 scrolls through
// its own scrollable element, which a finger does not move on iOS, so the
// pane turns a swipe into lines itself: one line per row height dragged,
// then a glide that slows down after a flick. A finger that moved past a few
// pixels is a scroll, not a tap (no keyboard comes up).

/** Movement under this many CSS pixels is still a tap. */
export const TAP_SLOP_PX = 8;
/** The glide's speed is kept by this much each frame (16 ms). */
const FRICTION = 0.95;
/** Below this speed (px/ms) the glide stops. */
const STOP_SPEED = 0.02;

export interface TouchScrollerOptions {
	/** The height of one row in CSS pixels. */
	rowHeight(): number;
	/** Scrolls by whole lines: negative towards older output. */
	scrollLines(lines: number): void;
	/** Animation frames (requestAnimationFrame in a page; a fake in tests). */
	frame?(callback: (now: number) => void): number;
	cancelFrame?(id: number): void;
}

export class TouchScroller {
	private lastY = 0;
	private lastT = 0;
	private startY = 0;
	/** Pixels dragged (and glided) since the finger came down, and the lines already scrolled for them. */
	private total = 0;
	private lines = 0;
	private speed = 0;
	private glide = 0;
	/** The finger moved past the slop: a scroll. */
	moved = false;

	constructor(private readonly opts: TouchScrollerOptions) {}

	start(y: number, t: number): void {
		this.stop();
		this.startY = this.lastY = y;
		this.lastT = t;
		this.total = 0;
		this.lines = 0;
		this.speed = 0;
		this.moved = false;
	}

	move(y: number, t: number): void {
		if (!this.moved && Math.abs(y - this.startY) < TAP_SLOP_PX) return;
		this.moved = true;
		const dy = y - this.lastY;
		const dt = Math.max(1, t - this.lastT);
		// Recent movement weighs most, so a flick at the end of a slow drag still glides.
		this.speed = 0.8 * (dy / dt) + 0.2 * this.speed;
		this.lastY = y;
		this.lastT = t;
		this.drag(dy);
	}

	/** The finger lifted: a flick glides on. */
	end(t: number): void {
		if (!this.moved || t - this.lastT > 100 || Math.abs(this.speed) < STOP_SPEED * 4) return;
		const frame = this.opts.frame ?? ((cb) => requestAnimationFrame(cb));
		let last = t;
		const step = (now: number) => {
			const dt = Math.min(48, Math.max(1, now - last));
			last = now;
			this.speed *= FRICTION ** (dt / 16);
			if (Math.abs(this.speed) < STOP_SPEED) {
				this.glide = 0;
				return;
			}
			this.drag(this.speed * dt);
			this.glide = frame(step);
		};
		this.glide = frame(step);
	}

	stop(): void {
		if (this.glide !== 0) (this.opts.cancelFrame ?? cancelAnimationFrame)(this.glide);
		this.glide = 0;
	}

	/** The finger (or the glide) moved `dy` pixels down: older output comes into view. */
	private drag(dy: number): void {
		const row = this.opts.rowHeight();
		if (row <= 0) return;
		this.total += dy;
		const target = Math.trunc(this.total / row);
		if (target === this.lines) return;
		const lines = target - this.lines;
		this.lines = target;
		this.opts.scrollLines(-lines);
	}
}

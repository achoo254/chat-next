// When the Live Map draws: never on its own (an idle minute is 0 frames
// under reduced motion), frames while something moves and one more for a
// still change, the idle scene's gentle motion at 20 frames a second at most
// (and none with reduced motion or save-data), none while
// the page is hidden, the Capacitor app is in the background, the canvas is
// off screen or the GPU context is lost (work asked for meanwhile is drawn on
// return).
import { describe, expect, it, vi } from "vitest";
import { AMBIENT_FPS, createFrameGate, type DrawResult, type FrameGateDeps } from "../../src/machines/observatory/render/frame-gate.ts";

/** A fake requestAnimationFrame at 60 frames per second. */
class FakeFrames {
	private queue = new Map<number, (now: number) => void>();
	private next = 1;
	now = 0;
	timers: { fire(): void } | null = null;
	request = (cb: (now: number) => void): number => {
		const id = this.next++;
		this.queue.set(id, cb);
		return id;
	};
	cancel = (id: number): void => {
		this.queue.delete(id);
	};
	get pending(): number {
		return this.queue.size;
	}
	/** Runs the browser for `ms`, one frame every 16 ms. */
	run(ms: number): void {
		const end = this.now + ms;
		while (this.now < end) {
			this.now += 16;
			this.timers?.fire();
			const due = [...this.queue.values()];
			this.queue.clear();
			for (const cb of due) cb(this.now);
		}
	}
}

class FakePage extends EventTarget {
	visibilityState: DocumentVisibilityState = "visible";
	listeners = 0;
	override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
		this.listeners += 1;
		super.addEventListener(...args);
	}
	override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
		this.listeners -= 1;
		super.removeEventListener(...args);
	}
	set(state: DocumentVisibilityState): void {
		this.visibilityState = state;
		this.dispatchEvent(new Event("visibilitychange"));
	}
}

/** setTimeout run by the fake frame clock. */
class FakeTimers {
	private timers = new Map<number, { at: number; run: () => void }>();
	private next = 1;
	constructor(private readonly frames: FakeFrames) {}
	set = (run: () => void, ms: number): number => {
		const id = this.next++;
		this.timers.set(id, { at: this.frames.now + ms, run });
		return id;
	};
	clear = (id: number): void => {
		this.timers.delete(id);
	};
	/** Runs the timers due by now. */
	fire(): void {
		for (const [id, t] of [...this.timers]) {
			if (t.at <= this.frames.now) {
				this.timers.delete(id);
				t.run();
			}
		}
	}
	get pending(): number {
		return this.timers.size;
	}
}

function setup(moving: () => boolean | DrawResult = () => false, ambient: () => boolean = () => false) {
	const frames = new FakeFrames();
	const page = new FakePage();
	let onScreen: ((v: boolean) => void) | null = null;
	let foreground: ((v: boolean) => void) | null = null;
	const offScreen = vi.fn();
	const offApp = vi.fn();
	const timers = new FakeTimers(frames);
	frames.timers = timers;
	const deps: FrameGateDeps = {
		requestFrame: frames.request,
		cancelFrame: frames.cancel,
		setTimer: timers.set,
		clearTimer: timers.clear,
		now: () => frames.now,
		ambientAllowed: ambient,
		page: page as unknown as Document,
		watchOnScreen: (_el, cb) => {
			onScreen = cb;
			return offScreen;
		},
		// Like native-app.ts: the Capacitor listener arrives asynchronously.
		watchAppState: (cb) => {
			foreground = cb;
			return Promise.resolve(offApp);
		},
	};
	const draw = vi.fn((_now: number): DrawResult => {
		const r = moving();
		return r === true ? "moving" : r === false ? "still" : r;
	});
	const gate = createFrameGate(document.createElement("div"), draw, deps);
	return {
		frames,
		timers,
		page,
		gate,
		draw,
		offScreen,
		offApp,
		screen: (v: boolean) => onScreen?.(v),
		app: (v: boolean) => foreground?.(v),
	};
}

describe("the frame gate", () => {
	it("draws 0 frames over an idle minute", () => {
		const { frames, gate, draw } = setup();
		frames.run(60_000);
		expect(gate.frames).toBe(0);
		expect(draw).not.toHaveBeenCalled();
		expect(frames.pending).toBe(0);
	});

	it("draws the idle scene's motion at 20 frames a second at most when ambient motion is allowed", () => {
		const { frames, gate } = setup(() => "ambient", () => true);
		gate.wake();
		frames.run(60_000);
		expect(gate.frames).toBeGreaterThan(60 * 10);
		expect(gate.frames).toBeLessThanOrEqual(60 * AMBIENT_FPS + 1);
	});

	it("draws 0 frames of idle motion with reduced motion or save-data (ambient not allowed), after the first", () => {
		const { frames, gate, timers } = setup(() => "ambient", () => false);
		gate.wake();
		frames.run(60_000);
		expect(gate.frames).toBe(1);
		expect(frames.pending).toBe(0);
		expect(timers.pending).toBe(0);
	});

	it("stops the idle motion while the page is hidden and resumes when shown", () => {
		const { frames, gate, page } = setup(() => "ambient", () => true);
		gate.wake();
		frames.run(1_000);
		const before = gate.frames;
		page.set("hidden");
		frames.run(30_000);
		expect(gate.frames).toBe(before);
		page.set("visible");
		frames.run(1_000);
		expect(gate.frames).toBeGreaterThan(before);
	});

	it("wakes once a moment later when asked (a camera move that becomes due)", () => {
		const { frames, gate } = setup();
		gate.wakeIn(500);
		frames.run(400);
		expect(gate.frames).toBe(0);
		frames.run(200);
		expect(gate.frames).toBe(1);
	});

	it("draws while something moves, then stops asking for frames", () => {
		let left = 10;
		const { frames, gate } = setup(() => --left > 0);
		gate.wake();
		frames.run(60_000);
		expect(gate.frames).toBe(10);
		expect(frames.pending).toBe(0);
	});

	it("a still change is one frame", () => {
		const { frames, gate } = setup();
		gate.wake();
		gate.wake();
		frames.run(1_000);
		expect(gate.frames).toBe(1);
	});

	it("stops while the page is hidden and draws what was asked once it shows again", () => {
		const { frames, gate, page } = setup(() => true);
		gate.wake();
		frames.run(100);
		const before = gate.frames;
		page.set("hidden");
		frames.run(10_000);
		expect(gate.frames).toBe(before);
		expect(frames.pending).toBe(0);
		page.set("visible");
		frames.run(100);
		expect(gate.frames).toBeGreaterThan(before);
	});

	it("stops when the Capacitor app goes to the background (appStateChange) and resumes in the foreground", async () => {
		const { frames, gate, app } = setup(() => true);
		await Promise.resolve();
		gate.wake();
		frames.run(100);
		const before = gate.frames;
		app(false);
		frames.run(60_000);
		expect(gate.frames).toBe(before);
		expect(gate.allowed).toBe(false);
		app(true);
		frames.run(100);
		expect(gate.frames).toBeGreaterThan(before);
	});

	it("does not draw a wake asked for while in the background until the app returns", () => {
		const { frames, gate, app } = setup();
		app(false);
		gate.wake();
		frames.run(5_000);
		expect(gate.frames).toBe(0);
		app(true);
		frames.run(100);
		expect(gate.frames).toBe(1);
	});

	it("stops while the canvas is off screen", () => {
		const { frames, gate, screen } = setup(() => true);
		screen(false);
		gate.wake();
		frames.run(5_000);
		expect(gate.frames).toBe(0);
		screen(true);
		frames.run(32);
		expect(gate.frames).toBeGreaterThan(0);
	});

	it("stops while the GPU context is lost", () => {
		const { frames, gate } = setup(() => true);
		gate.wake();
		frames.run(100);
		const before = gate.frames;
		gate.setContextLost(true);
		frames.run(5_000);
		expect(gate.frames).toBe(before);
		gate.setContextLost(false);
		frames.run(32);
		expect(gate.frames).toBeGreaterThan(before);
	});

	it("dispose cancels the frame and removes every listener", async () => {
		const { frames, gate, page, offScreen, offApp } = setup(() => true);
		await Promise.resolve();
		gate.wake();
		gate.dispose();
		frames.run(1_000);
		expect(gate.frames).toBe(0);
		expect(page.listeners).toBe(0);
		expect(offScreen).toHaveBeenCalledOnce();
		expect(offApp).toHaveBeenCalledOnce();
		gate.wake();
		frames.run(1_000);
		expect(gate.frames).toBe(0);
	});

	it("stops the app-state listener that arrives after dispose", async () => {
		const { gate, offApp } = setup();
		gate.dispose();
		await Promise.resolve();
		await Promise.resolve();
		expect(offApp).toHaveBeenCalledOnce();
	});
});

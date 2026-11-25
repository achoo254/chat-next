// When the Live Map draws a frame. `wake()` asks for a frame (a new move, a
// changed look), `wakeIn(ms)` asks for one later (a camera move that becomes
// due), and the draw callback says what it still has:
//
// - "moving": something moves with the session's events (a packet, flowing
//   energy, the model thinking, the camera easing): the next display frame;
// - "ambient": only the idle scene's gentle motion (the portal turning, the
//   tower breathing): frames at AMBIENT_FPS at most, and only while ambient
//   motion is allowed (not with reduced motion or save-data), otherwise none;
// - "still": nothing: no next frame, so an idle scene under reduced motion
//   draws 0 frames.
//
// Frames also stop while the page is hidden, while the Capacitor app is in
// the background (the WebView's visibility does not follow it on Android,
// docs/mobile-app.md), while the canvas is off screen (IntersectionObserver),
// and while the GPU context is lost. Work asked for while stopped is drawn
// once frames are allowed again. `frames` counts every frame drawn, for tests
// and the idle check.

export type DrawResult = "moving" | "ambient" | "still";

/** The idle scene's frame rate at most. */
export const AMBIENT_FPS = 20;
const AMBIENT_MS = 1000 / AMBIENT_FPS;

export interface FrameGateDeps {
	readonly requestFrame: (draw: (now: number) => void) => number;
	readonly cancelFrame: (id: number) => void;
	/** The page: its visibility and its visibilitychange event. */
	readonly page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
	/** Calls back whether `el` is on screen; returns a stop. Absent: always on screen. */
	readonly watchOnScreen?: (el: Element, onChange: (onScreen: boolean) => void) => () => void;
	/** The app's foreground changes (Capacitor appStateChange); returns a stop. Absent outside the app. */
	readonly watchAppState?: (onChange: (foreground: boolean) => void) => Promise<() => void> | (() => void);
	/** Whether idle motion may run now (no reduced motion, no save-data); absent: never. */
	readonly ambientAllowed?: () => boolean;
	/** Timers for the ambient rate and wakeIn; the window's by default. */
	readonly setTimer?: (run: () => void, ms: number) => number;
	readonly clearTimer?: (id: number) => void;
	/** The timers' clock (ms); performance.now by default. */
	readonly now?: () => number;
}

export interface FrameGate {
	/** Asks for a frame (and more while the draw callback reports motion). */
	wake(): void;
	/** Asks for a frame in `ms` (sooner asks win). */
	wakeIn(ms: number): void;
	/** The GPU context was lost (true) or restored (false). */
	setContextLost(lost: boolean): void;
	readonly frames: number;
	/** Frames may be drawn now. */
	readonly allowed: boolean;
	/** A frame is asked for (now or by a timer). */
	readonly scheduled: boolean;
	dispose(): void;
}

/** `draw(now)` draws one frame and says what still moves. */
export function createFrameGate(host: Element, draw: (now: number) => DrawResult, deps: FrameGateDeps): FrameGate {
	const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => window.setTimeout(run, ms));
	const clearTimer = deps.clearTimer ?? ((id: number) => window.clearTimeout(id));
	const clockNow = deps.now ?? (() => performance.now());
	let pageVisible = deps.page.visibilityState !== "hidden";
	let onScreen = true;
	let foreground = true;
	let contextLost = false;
	let disposed = false;
	let wanted = false;
	let frameId: number | null = null;
	/** The ambient rate's timer, or a wakeIn's. */
	let timer: { id: number; at: number } | null = null;
	let frames = 0;

	const allowed = (): boolean => !disposed && pageVisible && onScreen && foreground && !contextLost;

	const tick = (now: number): void => {
		frameId = null;
		if (!allowed()) return;
		frames += 1;
		wanted = false;
		const result = draw(now);
		if (result === "moving") {
			wanted = true;
			schedule();
		} else if (result === "ambient" && deps.ambientAllowed?.() === true) later(AMBIENT_MS);
	};

	function schedule(): void {
		if (frameId !== null || !allowed()) return;
		frameId = deps.requestFrame(tick);
	}

	/** A frame in `ms` (a sooner one asked already wins). */
	function later(ms: number): void {
		if (!allowed()) {
			wanted = true;
			return;
		}
		const at = clockNow() + ms;
		if (timer !== null) {
			if (timer.at <= at) return;
			clearTimer(timer.id);
		}
		const id = setTimer(() => {
			if (timer?.id === id) timer = null;
			wanted = true;
			schedule();
		}, Math.max(0, ms));
		timer = { id, at };
	}

	function stop(): void {
		if (timer !== null) {
			clearTimer(timer.id);
			timer = null;
			wanted = true;
		}
		if (frameId === null) return;
		deps.cancelFrame(frameId);
		frameId = null;
		// The frame that did not run still has to be drawn later.
		wanted = true;
	}

	const update = (): void => {
		if (allowed()) {
			if (wanted) schedule();
		} else stop();
	};

	const onVisibility = (): void => {
		pageVisible = deps.page.visibilityState !== "hidden";
		update();
	};
	deps.page.addEventListener("visibilitychange", onVisibility);
	const stopOnScreen = deps.watchOnScreen?.(host, (visible) => {
		onScreen = visible;
		update();
	});
	let stopAppState: (() => void) | null = null;
	const app = deps.watchAppState?.((fg) => {
		foreground = fg;
		update();
	});
	if (app instanceof Promise) {
		app.then(
			(off) => {
				if (disposed) off();
				else stopAppState = off;
			},
			(error: unknown) => console.warn("live map: app state not followed", error),
		);
	} else if (app !== undefined) stopAppState = app;

	return {
		wake() {
			wanted = true;
			schedule();
		},
		wakeIn(ms) {
			later(ms);
		},
		setContextLost(lost) {
			contextLost = lost;
			update();
		},
		get frames() {
			return frames;
		},
		get allowed() {
			return allowed();
		},
		get scheduled() {
			return frameId !== null || timer !== null;
		},
		dispose() {
			if (disposed) return;
			stop();
			disposed = true;
			wanted = false;
			deps.page.removeEventListener("visibilitychange", onVisibility);
			stopOnScreen?.();
			stopAppState?.();
			stopAppState = null;
		},
	};
}

/** IntersectionObserver as a FrameGateDeps.watchOnScreen; absent where the browser has none. */
export function intersectionWatcher(): FrameGateDeps["watchOnScreen"] {
	if (typeof IntersectionObserver !== "function") return undefined;
	return (el, onChange) => {
		const observer = new IntersectionObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last !== undefined) onChange(last.isIntersecting);
		});
		observer.observe(el);
		return () => observer.disconnect();
	};
}

// When the Live Map draws a frame. Nothing runs on its own: `wake()` asks for
// a frame (a new move, a changed still look), and the draw callback says
// whether it still has something moving; when it has not, no next frame is
// asked for, so an idle scene draws 0 frames. Frames also stop while the page
// is hidden, while the Capacitor app is in the background (the WebView's
// visibility does not follow it on Android, docs/mobile-app.md), while the
// canvas is off screen (IntersectionObserver), and while the GPU context is
// lost. Work asked for while stopped is drawn once frames are allowed again.
// `frames` counts every frame drawn, for tests and the idle check.

export interface FrameGateDeps {
	readonly requestFrame: (draw: (now: number) => void) => number;
	readonly cancelFrame: (id: number) => void;
	/** The page: its visibility and its visibilitychange event. */
	readonly page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
	/** Calls back whether `el` is on screen; returns a stop. Absent: always on screen. */
	readonly watchOnScreen?: (el: Element, onChange: (onScreen: boolean) => void) => () => void;
	/** The app's foreground changes (Capacitor appStateChange); returns a stop. Absent outside the app. */
	readonly watchAppState?: (onChange: (foreground: boolean) => void) => Promise<() => void> | (() => void);
}

export interface FrameGate {
	/** Asks for a frame (and more while the draw callback reports motion). */
	wake(): void;
	/** The GPU context was lost (true) or restored (false). */
	setContextLost(lost: boolean): void;
	readonly frames: number;
	/** Frames may be drawn now. */
	readonly allowed: boolean;
	/** A frame is asked for. */
	readonly scheduled: boolean;
	dispose(): void;
}

/** `draw(now)` draws one frame and returns whether something still moves. */
export function createFrameGate(host: Element, draw: (now: number) => boolean, deps: FrameGateDeps): FrameGate {
	let pageVisible = deps.page.visibilityState !== "hidden";
	let onScreen = true;
	let foreground = true;
	let contextLost = false;
	let disposed = false;
	let wanted = false;
	let frameId: number | null = null;
	let frames = 0;

	const allowed = (): boolean => !disposed && pageVisible && onScreen && foreground && !contextLost;

	const tick = (now: number): void => {
		frameId = null;
		if (!allowed()) return;
		frames += 1;
		wanted = false;
		const moving = draw(now);
		if (moving) wanted = true;
		if (wanted) schedule();
	};

	function schedule(): void {
		if (frameId !== null || !allowed()) return;
		frameId = deps.requestFrame(tick);
	}

	function stop(): void {
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
			return frameId !== null;
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

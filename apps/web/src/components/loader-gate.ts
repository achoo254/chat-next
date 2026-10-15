// When a loader may appear (mockups/auth.html#loading). A wait shorter than
// LOADER_DELAY_MS shows no loader at all, only a still, empty frame; once a
// loader is on screen it stays at least LOADER_MIN_MS so it never blinks.
// Loaders that take over from one another in the same region (the screen's
// code, then its data) share one gate, so the wait is counted once and the
// loader shows as one continuous loader. While the index.html splash is still
// up, a gate holds the splash instead of drawing a second loader.

/**
 * 20 ms past React's 300 ms Suspense reveal throttle: content that arrives in
 * under 300 ms is committed at the 300 ms mark, before this fires.
 */
export const LOADER_DELAY_MS = 320;
export const LOADER_MIN_MS = 400;

/**
 * idle: nothing loading. wait: loading, nothing drawn yet (or the splash is
 * covering). show: the loader is on screen for less than LOADER_MIN_MS.
 * shown: on screen for longer; it may leave.
 */
export type LoaderPhase = "idle" | "wait" | "show" | "shown";

export interface LoaderClock {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/** Runs `run` once the current commit is over (a microtask). */
	defer(run: () => void): void;
}

export const systemClock: LoaderClock = {
	now: () => performance.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	defer: (run) => queueMicrotask(run),
};

/** Something that already covers the screen and can be kept up (the splash). */
export interface LoaderCover {
	/** Whether it is still up and may be held. */
	readonly active: boolean;
	/** Keeps it up until the returned release is called. */
	hold(): () => void;
}

type Listener = () => void;

export class LoaderGate {
	private readonly clock: LoaderClock;
	private readonly cover: LoaderCover | null;
	private readonly listeners = new Set<Listener>();
	private count = 0;
	/** Holders that stand for a Suspense fallback (their content waits for LOADER_MIN_MS). */
	private fallbacks = 0;
	private phase: LoaderPhase = "idle";
	private shownAt = 0;
	private timer: unknown = null;
	private releaseCover: (() => void) | null = null;
	private minWait: Promise<void> | null = null;
	private resolveMinWait: (() => void) | null = null;

	constructor(clock: LoaderClock = systemClock, cover: LoaderCover | null = null) {
		this.clock = clock;
		this.cover = cover;
	}

	readonly subscribe = (listener: Listener): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getPhase = (): LoaderPhase => this.phase;

	/** When the loader went on screen (clock time); meaningful in "show" and "shown". */
	get since(): number {
		return this.shownAt;
	}

	/**
	 * Registers something loading. A loader taking over from another in the
	 * same commit continues its wait or its time on screen. `fallback` marks a
	 * Suspense fallback, whose content then waits for `contentWait()`.
	 */
	acquire(fallback = false): () => void {
		this.count += 1;
		if (fallback) this.fallbacks += 1;
		if (this.phase === "idle") this.start();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.count -= 1;
			if (fallback) this.fallbacks -= 1;
			if (this.count === 0) this.clock.defer(() => this.settle());
		};
	}

	/**
	 * What Suspense content must wait for before it replaces a fallback loader
	 * that is on screen for less than LOADER_MIN_MS; null when it may show now.
	 */
	contentWait(): Promise<void> | null {
		if (this.phase !== "show" || this.fallbacks === 0) return null;
		this.minWait ??= new Promise<void>((resolve) => {
			this.resolveMinWait = resolve;
		});
		return this.minWait;
	}

	private start(): void {
		if (this.cover?.active === true) {
			// The splash is still up: keep it rather than drawing a second loader.
			this.releaseCover = this.cover.hold();
			this.set("wait");
			return;
		}
		this.set("wait");
		this.schedule(LOADER_DELAY_MS, () => {
			this.shownAt = this.clock.now();
			this.set("show");
			this.schedule(LOADER_MIN_MS, () => this.minElapsed());
		});
	}

	private minElapsed(): void {
		this.set("shown");
		const resolve = this.resolveMinWait;
		this.minWait = null;
		this.resolveMinWait = null;
		resolve?.();
	}

	/** After the commit that released the last holder: stop unless another took over. */
	private settle(): void {
		if (this.count > 0 || this.phase === "idle") return;
		this.cancel();
		const release = this.releaseCover;
		this.releaseCover = null;
		// Content waiting on the minimum has nothing left to wait for.
		const resolve = this.resolveMinWait;
		this.minWait = null;
		this.resolveMinWait = null;
		resolve?.();
		this.set("idle");
		release?.();
	}

	private schedule(ms: number, run: () => void): void {
		this.cancel();
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			run();
		}, ms);
	}

	private cancel(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
	}

	private set(phase: LoaderPhase): void {
		if (this.phase === phase) return;
		this.phase = phase;
		for (const listener of [...this.listeners]) listener();
	}
}

/**
 * The index.html splash as a cover: up from the first paint until nothing
 * holds it any more, then hidden for good.
 */
export class SplashCover implements LoaderCover {
	private holders = 0;
	private done = false;
	private readonly element: HTMLElement | null;
	private readonly clock: LoaderClock;

	constructor(element: HTMLElement | null, clock: LoaderClock = systemClock) {
		this.element = element;
		this.clock = clock;
	}

	get active(): boolean {
		return this.element !== null && !this.done;
	}

	hold(): () => void {
		this.holders += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holders -= 1;
			if (this.holders === 0) this.clock.defer(() => this.settle());
		};
	}

	private settle(): void {
		if (this.holders > 0 || this.done || this.element === null) return;
		this.done = true;
		this.element.hidden = true;
	}
}

let splash: SplashCover | null = null;
let splashElement: HTMLElement | null = null;

/** The splash of this page (index.html), or an inactive cover where there is none (tests, the visual harness). */
export function pageSplash(): SplashCover {
	const element = typeof document === "undefined" ? null : document.getElementById("splash");
	if (splash === null || element !== splashElement) {
		splash = new SplashCover(element);
		splashElement = element;
	}
	return splash;
}

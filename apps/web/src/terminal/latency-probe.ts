// Diagnostic measurement of the terminal, off unless the page sets
// localStorage "terminal:probe" to "1": for a keystroke, the time from the
// key event to the moment xterm finished writing the first output that came
// back for that session (the acceptance number), and apart from it the time
// from that write to the next animation frame (paint). Samples stay in the
// page; window.__terminalProbe reads them (and a session's visible text, for
// automated checks). Nothing is sent anywhere.

const KEY = "terminal:probe";
const MAX_SAMPLES = 5_000;

export interface ProbeStats {
	readonly n: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly max: number;
}

export interface LatencyProbe {
	/** A key event for `session` (the first one waiting is the one measured). */
	key(session: number): void;
	/** Output for `session` is about to be written: the pending key's start time, taken. */
	take(session: number): number | null;
	/** That write finished: records echo and, at the next frame, paint. */
	written(start: number): void;
	/** Lets the probe read a session's screen (for automated checks). */
	screen(session: number, read: (() => string) | null): void;
}

function stats(samples: readonly number[]): ProbeStats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
	return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}

function enabled(): boolean {
	try {
		return window.localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

interface ProbeGlobal {
	__terminalProbe?: {
		readonly echo: number[];
		readonly paint: number[];
		stats(): { echo: ProbeStats; paint: ProbeStats };
		reset(): void;
		text(session: number): string;
	};
}

let shared: LatencyProbe | null | undefined;

/** The probe when the flag is on (one per page), else null. */
export function latencyProbe(): LatencyProbe | null {
	if (shared !== undefined) return shared;
	if (!enabled()) {
		shared = null;
		return shared;
	}
	const echo: number[] = [];
	const paint: number[] = [];
	const pending = new Map<number, number>();
	const screens = new Map<number, () => string>();
	const push = (list: number[], value: number) => {
		list.push(value);
		if (list.length > MAX_SAMPLES) list.shift();
	};
	(window as unknown as ProbeGlobal).__terminalProbe = {
		echo,
		paint,
		stats: () => ({ echo: stats(echo), paint: stats(paint) }),
		reset: () => {
			echo.length = 0;
			paint.length = 0;
			pending.clear();
		},
		text: (session) => screens.get(session)?.() ?? "",
	};
	shared = {
		key(session) {
			if (!pending.has(session)) pending.set(session, performance.now());
		},
		take(session) {
			const start = pending.get(session);
			if (start === undefined) return null;
			pending.delete(session);
			return start;
		},
		written(start) {
			const done = performance.now();
			push(echo, done - start);
			requestAnimationFrame(() => push(paint, performance.now() - done));
		},
		screen(session, read) {
			if (read === null) screens.delete(session);
			else screens.set(session, read);
		},
	};
	return shared;
}

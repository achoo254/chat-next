// Feeds the render loop gate (engine/render-loop-gate.ts) its signals: the
// page's visibility, whether the canvas is on screen (IntersectionObserver:
// another tab of the session, or scrolled away), the Capacitor app going to
// the background (the WebView's visibility does not follow it on Android),
// and a lost GPU context. Calls `onChange` when the decision flips.
import { LOOP_START, loopShouldRun, type LoopSignals } from "./engine/render-loop-gate.ts";

export interface RenderGate {
	contextLost(): void;
	readonly running: boolean;
	dispose(): void;
}

export function createRenderGate(host: HTMLElement, onChange: (run: boolean) => void): RenderGate {
	let signals: LoopSignals = { ...LOOP_START, pageVisible: document.visibilityState !== "hidden" };
	let running = false;
	let disposed = false;
	const apply = (next: Partial<LoopSignals>): void => {
		signals = { ...signals, ...next };
		const run = !disposed && loopShouldRun(signals);
		if (run === running) return;
		running = run;
		onChange(run);
	};
	const onVisibility = (): void => apply({ pageVisible: document.visibilityState !== "hidden" });
	document.addEventListener("visibilitychange", onVisibility);
	let observer: IntersectionObserver | null = null;
	if (typeof IntersectionObserver === "function") {
		observer = new IntersectionObserver((entries) => {
			const entry = entries[entries.length - 1];
			if (entry !== undefined) apply({ onScreen: entry.isIntersecting });
		});
		observer.observe(host);
	}
	let stopAppState: (() => void) | null = null;
	if (import.meta.env.VITE_NATIVE === "true") {
		void import("../native/native-app.ts")
			.then((native) => {
				if (disposed) return;
				stopAppState = native.subscribeAppState((foreground) => apply({ appActive: foreground }));
			})
			.catch((error: unknown) => console.warn("office: app state not followed", error));
	}
	apply({});
	return {
		get running() {
			return running;
		},
		contextLost() {
			apply({ contextLost: true });
		},
		dispose() {
			disposed = true;
			document.removeEventListener("visibilitychange", onVisibility);
			observer?.disconnect();
			stopAppState?.();
			if (running) {
				running = false;
				onChange(false);
			}
		},
	};
}

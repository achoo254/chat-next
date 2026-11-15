// When the office's render loop runs (plan decision 7): only while the page
// shows, the canvas is on screen (the Office tab is open and not scrolled
// away), the app is in the foreground (Capacitor pause) and the GPU context
// is alive. The decision is pure; office-world.ts feeds it the signals.

export interface LoopSignals {
	readonly pageVisible: boolean;
	readonly onScreen: boolean;
	readonly appActive: boolean;
	readonly contextLost: boolean;
}

export const LOOP_START: LoopSignals = { pageVisible: true, onScreen: true, appActive: true, contextLost: false };

export function loopShouldRun(s: LoopSignals): boolean {
	return s.pageVisible && s.onScreen && s.appActive && !s.contextLost;
}

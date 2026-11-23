// The page observatory-csp.e2e.ts opens: built with the app (same Vite config,
// same chunks of the Live Map renderer) and served under the production CSP.
// It mounts the scene on the shipped assets, plays a few real events through
// the reducer, and reports what happened on window.__liveMapHarness and
// document.body's data-status ("ready" or "still" with the error).
import { applyEvents, fromSnapshot, takeAnimations, type LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapEvent } from "../../src/machines/observatory/live-map-types.ts";
import type { LiveMapHandle } from "../../src/machines/observatory/render/live-map-app.ts";
import { assetBase, loadSceneAssets } from "../../src/machines/observatory/render/scene-table.ts";

interface Harness {
	readonly renderer: string;
	frames(): number;
	play(): number;
	log(): readonly { eventId: string; kind: string }[];
	destroy(): void;
}

declare global {
	interface Window {
		__liveMapHarness?: Harness;
	}
}

const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);
const at = (ms: number, seq: number, id: string): { at: number; seq: number; id: string; provisional: false } => ({ at: T0 + ms, seq, id, provisional: false });
const EVENTS: LiveMapEvent[] = [
	{ kind: "prompt", promptId: "p1", ...at(0, 1, "prompt:p1") },
	{ kind: "tool", toolUseId: "t1", agentId: "", toolName: "Read", mcpServer: "", target: "src/app.ts", station: "FILES", stationFlags: 0, ...at(100, 2, "tool:t1") },
	{ kind: "tool", toolUseId: "t1", agentId: "", toolName: "Read", mcpServer: "", target: "src/app.ts", station: "FILES", stationFlags: 0, success: true, durationMs: 40, ...at(200, 3, "tool:t1") },
	{ kind: "lifecycle", name: "stop", agentId: "", toolUseId: "", station: "CORE", label: "", ...at(300, 4, "event:stop") },
];

async function start(): Promise<void> {
	const host = document.getElementById("host");
	if (host === null) throw new Error("no host");
	const assets = await loadSceneAssets(assetBase(import.meta.env.BASE_URL));
	let state: LiveMapState = fromSnapshot({ sessionId: "s1", epoch: 1n, seq: 0, info: null, live: null, events: [], earlier: "" });
	const { mountLiveMap } = await import("../../src/machines/observatory/render/live-map-app.ts");
	const handle: LiveMapHandle = await mountLiveMap({ host, assets, state, width: host.clientWidth, height: host.clientHeight, saveData: false, record: true });
	window.__liveMapHarness = {
		renderer: handle.renderer,
		frames: () => handle.frames(),
		play() {
			state = applyEvents(state, state.epoch, EVENTS).state;
			const [animations, rest] = takeAnimations(state);
			state = rest;
			handle.update(state, animations);
			return animations.length;
		},
		log: () => handle.animationLog(),
		destroy: () => handle.destroy(),
	};
	document.body.dataset.status = "ready";
}

start().catch((error: unknown) => {
	document.body.dataset.status = "still";
	document.body.dataset.error = error instanceof Error ? error.message : String(error);
});

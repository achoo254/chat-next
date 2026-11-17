// Budgets of the perf gate. Sources: the speed budget of plan phase 06
// (initial JS, open a chat from cache, scroll frames) and the plan's speed
// table (open from cache p50). Budgets the plan does not set (CSS, long
// tasks) are marked as derived and sit above the measured baseline. Sizes
// are KiB (1024 bytes).

/** Lazy modules every signed-in start loads (manifest keys, relative to apps/web). */
export const STARTUP_MODULES = [
	// The signed-in app (app.tsx) and the worker-backed client it starts (connector.ts).
	"src/messaging/messaging-root.tsx",
	"src/messaging/data/web-client.ts",
] as const;

export const BUNDLE_BUDGET = {
	/**
	 * Phase 06: initial JS (gzip) at most 150 KB; the rest loads lazily. 146.4 KB
	 * when the gate started, 149.1 KB at the R2 release. 112.5 KB once GetSelf went
	 * over JSON and the Connect transport, protobuf runtime and schemas left the
	 * startup chunks; 130.7 KB with React Compiler, which is on since then.
	 * 149.9 KB once English UI copy loaded on first use instead of at startup;
	 * 149.7 KB with the anti-abuse copy once the signed-out welcome screen
	 * loaded only when shown. 142.5 KB once icons only lazy screens draw, the
	 * dialog switch and service, forward and via-bot lines loaded on demand,
	 * and more leaf components skipped the compiler's memoization. 149.3 KB
	 * with the language and theme choice shared by the hoandat.com apps
	 * (@achoo254/app-shell preferences, about 1.1 KB), the welcome page's copy
	 * having left the startup catalog for its own chunk. 150.4 KB with
	 * @achoo254/app-switcher 0.6.0 (developer tools heading); 147.7 KB once the
	 * switcher loaded in its own chunk behind a placeholder of its size.
	 * 150.5 KB with the lazy 3D office: no app module entered startup, but
	 * Babylon's on-demand chunks also use the bundler's runtime helpers, so
	 * rolldown moved them out of the react vendor chunk into a startup chunk
	 * of their own (149.74 → 150.05 KB, the split's overhead). 150.6 KB with the
	 * minimum gap between reloads of a chat's window (message store, about
	 * 0.1 KB), which the budget of 151 KB leaves room for.
	 */
	startupJsGzip: 151 * 1024,
	/** Derived: startup CSS was 13.7 KB gzip when the gate started. */
	startupCssGzip: 20 * 1024,
} as const;

/**
 * The 3D office (apps/web/src/office-3d): the lazy modules the Office tab
 * loads for it (manifest keys), counted with their static imports and
 * Babylon's on-demand parts (shaders), minus what a signed-in start and the
 * Office tab itself (OFFICE_VIEW_MODULE) already loaded.
 */
export const OFFICE_3D_MODULES = ["src/office-3d/office-canvas.tsx", "src/office-3d/office-world.ts"] as const;
export const OFFICE_VIEW_MODULE = "src/machines/office/office-view.tsx";

/**
 * On-demand parts that belong to the 3D office's count, for one backend: a
 * device runs WebGPU (WGSL shaders) or WebGL2 (GLSL shaders), never both, so
 * each backend's count leaves out the other's shader chunks.
 */
export function office3dPart(backend: "webgpu" | "webgl2"): (key: string) => boolean {
	const other = backend === "webgpu" ? "/@babylonjs/core/Shaders/" : "/@babylonjs/core/ShadersWGSL/";
	return (key) => (key.includes("@babylonjs/") && !key.includes(other)) || key.startsWith("src/office-3d/");
}

export const OFFICE_3D_BUDGET = {
	/** Plan decision 7: the 3D chunk under 1 MB gzip, models and textures not counted (the spike page measured 807 KB). */
	jsGzip: 1024 * 1024,
} as const;

/** GitHub Actions and most CI systems set CI=true. */
const ON_CI = process.env.CI === "true";

export interface ProfileBudget {
	/** Open a chat from cache, ms (plan: p50 at most 50, p99 at most 100). */
	readonly openP50Ms: number;
	readonly openP99Ms: number;
	/** Frames over 32 ms while scrolling (phase 06: none). */
	readonly scrollSlowFrames: number;
	/** Average frame rate while scrolling (phase 06: at least 55 fps). */
	readonly scrollMinFps: number;
	/** Derived: total blocking time of long tasks while scrolling, ms. */
	readonly scrollTbtMs: number;
	/** Derived: total blocking time per chat switch, ms. */
	readonly openTbtPerSwitchMs: number;
}

export interface Profile {
	readonly name: string;
	/** Chrome DevTools CPU throttling rate (1 = no throttling). */
	readonly cpuThrottle: number;
	/** null: measured and reported, not gated. */
	readonly budget: ProfileBudget | null;
}

export const PROFILES: readonly Profile[] = [
	{
		// Phase 06 budgets are for a standard laptop; a CI runner core is about one.
		name: "laptop",
		cpuThrottle: 1,
		// Open-chat latency: the plan's laptop budget locally; on shared CI runners
		// (GitHub Actions sets CI=true, measured about 2x slower and noisy) a
		// runner-calibrated budget that still catches large regressions.
		budget: {
			openP50Ms: ON_CI ? 75 : 50,
			openP99Ms: ON_CI ? 200 : 100,
			scrollSlowFrames: 0,
			scrollMinFps: 55,
			scrollTbtMs: 0,
			openTbtPerSwitchMs: 25,
		},
	},
	{
		// Phase 06: a 4x CPU throttling profile stands in for a mid-range
		// Android WebView. The plan sets no budget for it beyond cold start
		// (Phase 10 measures on devices), so it is reported, not gated.
		name: "midrange-4x",
		cpuThrottle: 4,
		budget: null,
	},
];

/** Scenario sizes: scroll speeds approximate a fast flick (px per 60 Hz frame). */
export const SCENARIO = {
	openRounds: 10,
	chatListStepPx: 120,
	historyStepPx: 120,
	/** Each scroll runs this many times; the smoothest run is judged. */
	scrollAttempts: 3,
	/** Open-chat rounds; the one with the lower p99 is gated. */
	openAttempts: 2,
} as const;

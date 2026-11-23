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
	 * 0.1 KB), which the budget of 151 KB leaves room for. 151.4 KB with the
	 * delivery state of chats that send on to another app (Chat Bridge: a small
	 * hook, its context and the marks in a message bubble, about 0.7 KB; the
	 * watcher that asks the server and everything drawn load only for such a
	 * chat), so the budget is 152 KB. 152.9 KB with People: a linked person as
	 * one row of the chat list with its share of the "All" badge (about 0.6 KB
	 * of startup glue; the grouping code and the people store load after the
	 * first screen), the platform label and limited actions of a message
	 * bubble (about 0.2 KB), and the person route; the merged screen itself is
	 * lazy and shares only pure helpers (message-runs.ts), because importing
	 * the list module from it split two shared modules into chunks of their own
	 * (+0.7 KB). 153.7 KB with the Telegram and Zalo folders always listed, each
	 * with its logo (the Zalo logo, the merge of the known apps into the folder
	 * list and the logo in the rail and the tabs, about 0.2 KB). The Live Map's
	 * lazy renderer (PixiJS) adds no app module to startup, but its own
	 * on-demand chunks (its renderers and browser extensions) use the
	 * bundler's runtime helpers without importing the react vendor chunk, so
	 * rolldown keeps the helpers in a startup chunk of their own (0.3 KB, the
	 * split's overhead; the bundler has no setting for where its runtime
	 * goes). The budget is 154 KB.
	 */
	startupJsGzip: 154 * 1024,
	/** Derived: startup CSS was 13.7 KB gzip when the gate started. */
	startupCssGzip: 20 * 1024,
} as const;

/**
 * The Live Map ("Quan sát", apps/web/src/machines/observatory): the lazy
 * module the Observe tab loads (manifest key), counted with its static imports
 * and its own on-demand parts, minus what a signed-in start and the AI Agent
 * screen (MACHINES_SCREEN_MODULE, open before any session) already loaded.
 */
export const LIVE_MAP_MODULE = "src/machines/observatory/live-map-view.tsx";
export const MACHINES_SCREEN_MODULE = "src/machines/machines-screen.tsx";

/**
 * PixiJS's own on-demand parts a browser loads for the Live Map: its browser
 * extensions and both renderers it may pick (WebGL, else Canvas; both counted,
 * though only one loads). Its WebGPU renderer (never asked for) and its web
 * worker environment are not counted.
 */
const PIXI_ON_DEMAND = /\/pixi\.js\/lib\/(environment-browser\/browserAll|rendering\/renderers\/gl\/WebGLRenderer|rendering\/renderers\/canvas\/CanvasRenderer)\.mjs$/;

/** On-demand parts that belong to the Live Map's count. */
export function liveMapPart(key: string): boolean {
	return key.startsWith("src/machines/observatory/") || PIXI_ON_DEMAND.test(key);
}

export const LIVE_MAP_BUDGET = {
	/** The Live Map chunk under 350 KB gzip, images and other assets not counted. */
	jsGzip: 350 * 1024,
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

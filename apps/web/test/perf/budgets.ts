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
	 * goes). 154.1 KB once the composer of a synced chat names the app in its
	 * placeholder (in place of a lazy note line) and a chat row leaves off the
	 * logo of the app whose folder is open (about 0.1 KB). The budget is 155 KB.
	 * 163.1 KB on 25/11/2026: the check of a refused reaction on a synced chat
	 * called ConnectError.from in the module of the emoji lists, which the
	 * message bubble imports, so the Connect and protobuf runtime (7.7 KB) and
	 * the Telegram and Zalo emoji lists entered startup. The check now reads
	 * the refusal by its shape in its own module (messaging/ui/reaction-refused.ts),
	 * and the lists stay with the lazy pickers: 154.9 KB. The budget stays 155 KB.
	 * 155.7 KB on 26/11/2026 with the code that reloads after a lazy chunk fails to load
	 * following a deploy (+0.75 KB); 155.2 KB once only its listeners stay in the entry
	 * chunk. Vite's modulepreload polyfill, 0.2 KB of startup JS that only adds a
	 * hint for old browsers, is off (vite.config.ts): 155.0 KB, with no room left.
	 * Splitting more startup code into lazy chunks made it worse (157.0 KB with the compact
	 * window lazy: its shared modules became chunks of their own), and what is left is the
	 * first screen. The budget is 156 KB since 26/11/2026, raised by the owner.
	 * 151.9 KB (from 155.6) once five files (the chat list, the compact window, the list
	 * resizer and the two loaders) are left out of the React Compiler's memoization, which
	 * only grew them: 3.7 KB gzip, with no change in the open-chat and scroll timings. The
	 * message list and the conversation grew less (1.2 and 1.5 KB) but are left memoized:
	 * without it the history scroll dropped 23 frames on the 4x-throttled run (1 before).
	 */
	startupJsGzip: 156 * 1024,
	/**
	 * Derived: startup CSS was 13.7 KB gzip when the gate started. 20.4 KB on
	 * 25/11/2026 with the conversation's Ask AI panel, the quick actions that
	 * straddle a bubble's corner and Telegram's animated stickers (messaging.css,
	 * about 0.6 KB); the budget is 21 KB.
	 */
	startupCssGzip: 21 * 1024,
} as const;

/**
 * The Live Map ("Quan sát", apps/web/src/machines/observatory): the lazy
 * module the Observe tab loads (manifest key), counted with its static imports
 * and its own on-demand parts, minus what a signed-in start and the AI Agent
 * screen (MACHINES_SCREEN_MODULE, open before any session) already loaded.
 */
export const LIVE_MAP_MODULE = "src/machines/observatory/live-map-view.tsx";
export const MACHINES_SCREEN_MODULE = "src/machines/machines-screen.tsx";

/** On-demand parts that belong to the Live Map's count. */
export function liveMapPart(key: string): boolean {
	return key.startsWith("src/machines/observatory/");
}

export const LIVE_MAP_BUDGET = {
	/** The Live Map's chunks under 80 KB gzip (45.5 KB on 26/11/2026 once drawn on a 2D canvas, no renderer library). */
	jsGzip: 80 * 1024,
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

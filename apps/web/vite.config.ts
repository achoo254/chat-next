import { defineConfig } from "vitest/config";
import { loadChatBrand } from "./brand-files.ts";
import { brandAssets } from "./vite-brand.ts";
import { langBootstrap } from "./vite-lang-bootstrap.ts";
import { reactPlugins } from "./vite-react.ts";
import { serviceWorker } from "./vite-service-worker.ts";
import { themeBootstrap } from "./vite-theme-bootstrap.ts";

const SIDE_EFFECT_FREE = /\/packages\/(core|proto-ts)\/src\//;

// The Go server listens here in development (see server/cmd/server).
const API_ORIGIN = "http://127.0.0.1:4600";

export default defineConfig({
	plugins: [...reactPlugins(), brandAssets(), themeBootstrap(), langBootstrap(), serviceWorker(loadChatBrand().pushSenderName)],
	server: {
		// brand.config.json devOrigins lists this origin; never fall back to another port.
		port: 5173,
		strictPort: true,
		proxy: {
			"/rpc": API_ORIGIN,
			"/auth": API_ORIGIN,
			"/healthz": API_ORIGIN,
			// HTTP Bot API (bots call it; the e2e scenarios play a bot through it). It
			// answers only on the app's own host, so the Host header stays as sent.
			"/bot/": { target: API_ORIGIN, changeOrigin: false },
			// Incoming webhooks: the URL shown in the group panel uses this origin, and
			// the server checks the Host header, as for /bot/.
			"/hook/": { target: API_ORIGIN, changeOrigin: false },
			// Realtime gateway (same origin as in production).
			"/ws": { target: API_ORIGIN, ws: true },
		},
	},
	// The client core runs in a module worker that loads chunks and SQLite WebAssembly.
	worker: { format: "es" },
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
	build: {
		// CSP is default-src 'self': fonts and images must be files, never data: URIs.
		assetsInlineLimit: 0,
		rollupOptions: {
			// The client core and the generated protocol code run nothing at import
			// time. Saying so lets the R0 entry import one helper from the core
			// barrel without pinning every core module into the first chunk.
			treeshake: { moduleSideEffects: (id: string) => !SIDE_EFFECT_FREE.test(id) },
		},
	},
	test: {
		environment: "jsdom",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup.ts"],
		// The messaging tests run the real client core against the in-memory server.
		testTimeout: 20_000,
		// Shared 16 GB machine: never more than two test workers.
		maxWorkers: 2,
	},
});

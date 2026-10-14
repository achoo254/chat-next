import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import brand from "../../brand.config.json" with { type: "json" };

const SIDE_EFFECT_FREE = /\/packages\/(core|proto-ts)\/src\//;

// The Go server listens here in development (see server/cmd/server).
const API_ORIGIN = "http://127.0.0.1:4600";

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Fills the product name and description into index.html from brand.config.json. */
function brandHtml(): Plugin {
	return {
		name: "app-brand-html",
		transformIndexHtml: {
			order: "pre",
			handler: (html) =>
				html
					.replaceAll("%APP_NAME%", escapeHtml(brand.appName))
					.replaceAll("%APP_DESCRIPTION%", escapeHtml(brand.description)),
		},
	};
}

export default defineConfig({
	plugins: [react(), brandHtml()],
	server: {
		// brand.config.json devOrigins lists this origin; never fall back to another port.
		port: 5173,
		strictPort: true,
		proxy: {
			"/rpc": API_ORIGIN,
			"/auth": API_ORIGIN,
			"/healthz": API_ORIGIN,
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

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import brand from "../../brand.config.json" with { type: "json" };

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
		},
	},
	build: {
		// CSP is default-src 'self': fonts and images must be files, never data: URIs.
		assetsInlineLimit: 0,
	},
	test: {
		environment: "jsdom",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup.ts"],
	},
});

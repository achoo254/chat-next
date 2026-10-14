// Build of the visual harness (test only): `vite build -c test/visual/vite.config.ts`
// then `vite preview -c test/visual/vite.config.ts`.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const HOLD_MAX_MS = 20_000;

/**
 * Lets a harness page hold its load event until a scenario has clicked
 * through (?open=): the page puts an image on /__hold before load and calls
 * /__release when done; the image answers then (or after 20 seconds). Render
 * checks capture the page after load, so they see the finished state. One
 * page at a time, as render checks run.
 */
function holdLoad(): Plugin {
	let release: (() => void) | null = null;
	return {
		name: "harness-hold-load",
		configurePreviewServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.startsWith("/__hold") === true) {
					release?.();
					const done = () => {
						clearTimeout(timer);
						if (release === done) release = null;
						res.statusCode = 204;
						res.end();
					};
					const timer = setTimeout(done, HOLD_MAX_MS);
					release = done;
					return;
				}
				if (req.url?.startsWith("/__release") === true) {
					release?.();
					res.statusCode = 204;
					res.end();
					return;
				}
				next();
			});
		},
	};
}

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react(), holdLoad()],
	worker: { format: "es" },
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
	build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
	preview: { port: 5174, strictPort: true },
});

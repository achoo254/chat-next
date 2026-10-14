// Build of the visual harness (test only): `vite build -c test/visual/vite.config.ts`
// then `vite preview -c test/visual/vite.config.ts`. The perf gate
// (test/perf/perf-gate.ts) builds and serves it the same way.
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { reactPlugins } from "../../vite-react.ts";

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

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root,
	plugins: [...reactPlugins(), holdLoad()],
	worker: { format: "es" },
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
	build: {
		outDir: "dist",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		// index.html: render checks; perf.html: the perf gate (test/perf).
		rollupOptions: { input: { index: `${root}index.html`, perf: `${root}perf.html` } },
	},
	preview: { port: 5174, strictPort: true },
});

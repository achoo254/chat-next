// Builds the app shell's service worker (src/sw/service-worker.ts) into
// /sw.js of a production build. Once the app's files are written, it lists
// them (index.html, the hashed assets, fonts, icons, the manifest) and hashes
// their contents into the build's version; both are compiled into the
// worker, so every build ships a worker of its own and a new build installs
// as an update. The dev server has no worker.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

export const SERVICE_WORKER_FILE = "sw.js";

/** Build output the worker does not cache: itself, source maps and Vite's manifest. */
function cached(fileName: string): boolean {
	return fileName !== SERVICE_WORKER_FILE && !fileName.endsWith(".map") && !fileName.startsWith(".vite/");
}

export interface AppShell {
	readonly version: string;
	/** Absolute paths, sorted. */
	readonly files: readonly string[];
}

/** The shell of a build: its cached files and a version that changes with any of their contents. */
export function appShell(output: ReadonlyMap<string, string | Uint8Array>): AppShell {
	const hash = createHash("sha256");
	const files: string[] = [];
	for (const fileName of [...output.keys()].sort()) {
		if (!cached(fileName)) continue;
		hash.update(fileName).update("\0").update(output.get(fileName) ?? "").update("\0");
		files.push(`/${fileName}`);
	}
	return { version: hash.digest("hex").slice(0, 16), files };
}

export function serviceWorker(): Plugin {
	return {
		name: "app-service-worker",
		apply: "build",
		async writeBundle(options, bundle) {
			const outDir = options.dir;
			if (outDir === undefined) throw new Error("service worker: the build has no output directory");
			const output = new Map<string, string | Uint8Array>();
			for (const [fileName, item] of Object.entries(bundle)) output.set(fileName, item.type === "chunk" ? item.code : item.source);
			const shell = appShell(output);
			await build({
				configFile: false,
				logLevel: "warn",
				publicDir: false,
				define: { __APP_SHELL__: JSON.stringify(shell) },
				build: {
					outDir,
					emptyOutDir: false,
					copyPublicDir: false,
					minify: true,
					lib: { entry: fileURLToPath(new URL("./src/sw/service-worker.ts", import.meta.url)), formats: ["iife"], name: "appShellWorker", fileName: () => SERVICE_WORKER_FILE },
				},
			});
		},
	};
}

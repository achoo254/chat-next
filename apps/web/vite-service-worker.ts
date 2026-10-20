// Builds the app shell's service worker (src/sw/service-worker.ts) into
// /sw.js of a production build. Once the app's files are written, it lists
// them (index.html, the hashed assets, fonts, icons, the manifest), hashes
// their contents into the build's version and finds the entry script
// index.html loads (the build's name in build messages); all three are
// compiled into the worker, with the brand's push sender name, so every build ships a worker of its own and a new build installs
// as an update. The dev server has no worker.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import type { AppShellBuild } from "./src/sw/app-shell-worker.ts";

export const SERVICE_WORKER_FILE = "sw.js";

/** Build output the worker does not cache: itself, source maps and Vite's manifest. */
function cached(fileName: string): boolean {
	return fileName !== SERVICE_WORKER_FILE && !fileName.endsWith(".map") && !fileName.startsWith(".vite/");
}

/** The entry script index.html loads, the same one the page finds (register-service-worker.ts). */
export function entryScript(indexHtml: string): string {
	const src = /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
	if (src === undefined) throw new Error("service worker: index.html loads no module script from /assets/");
	return src;
}

/** The shell of a build: its cached files, a version that changes with any of their contents, and its entry. */
export function appShell(output: ReadonlyMap<string, string | Uint8Array>): AppShellBuild {
	const hash = createHash("sha256");
	const files: string[] = [];
	for (const fileName of [...output.keys()].sort()) {
		if (!cached(fileName)) continue;
		hash.update(fileName).update("\0").update(output.get(fileName) ?? "").update("\0");
		files.push(`/${fileName}`);
	}
	const index = output.get("index.html");
	if (index === undefined) throw new Error("service worker: the build has no index.html");
	const html = typeof index === "string" ? index : new TextDecoder().decode(index);
	return { version: hash.digest("hex").slice(0, 16), files, entry: entryScript(html) };
}

/** `pushSenderName`: the brand's title of push notifications that hide the message. */
export function serviceWorker(pushSenderName: string): Plugin {
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
				define: { __APP_SHELL__: JSON.stringify(shell), __PUSH_APP_NAME__: JSON.stringify(pushSenderName) },
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

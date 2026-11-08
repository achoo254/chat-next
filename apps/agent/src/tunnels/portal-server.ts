/** HTTP server that serves the portal SPA at localhost:<port> with SPA fallback */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { listenWithPortFallback } from "./listen-with-port-fallback.js";
import { isLocalRequest } from "./local-origin.ts";
import { portalAssets } from "./portal-assets.ts";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
};

let activeServer: http.Server | null = null;

function serveFile(res: http.ServerResponse, filePath: string): void {
	const ext = path.extname(filePath);
	const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end("Portal file unreadable");
			return;
		}
		res.writeHead(200, { "content-type": contentType });
		res.end(data);
	});
}

/**
 * Serves the portal on `port`, or the next free port when it is taken,
 * so parallel CLI runs do not collide. Resolves with the bound port.
 * Only the known portal files are served (a fixed map, so no path can
 * leave it); any other path gets index.html for the SPA router.
 */
export async function startPortalServer(port: number): Promise<number> {
	const assets = portalAssets();
	const index = assets["/index.html"];

	const server = http.createServer((req, res) => {
		if (!isLocalRequest(req)) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("Forbidden");
			return;
		}
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		const file = assets[pathname] ?? index;
		if (!file) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Portal not built. Run: pnpm --filter @achoo254/tunelo-agent build:portal");
			return;
		}
		serveFile(res, file);
	});

	const { port: boundPort } = await listenWithPortFallback(server, port);
	activeServer = server;
	return boundPort;
}

export function stopPortalServer(): Promise<void> {
	return new Promise((resolve) => {
		if (!activeServer) {
			resolve();
			return;
		}
		activeServer.close(() => {
			activeServer = null;
			resolve();
		});
	});
}

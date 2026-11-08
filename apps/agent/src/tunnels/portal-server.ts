/** HTTP server that serves the portal SPA at localhost:<port> with SPA fallback */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listenWithPortFallback } from "./listen-with-port-fallback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/** Resolve portal-dist directory relative to this file at runtime */
function resolveDistDir(): string {
	// When compiled: dist/portal-server.js → ../portal-dist
	// When running as tsx: src/portal-server.ts → ../portal-dist
	return path.resolve(__dirname, "..", "portal-dist");
}

function serveFile(
	res: http.ServerResponse,
	filePath: string,
	fallbackPath: string,
): void {
	const ext = path.extname(filePath);
	const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

	fs.readFile(filePath, (err, data) => {
		if (err) {
			// SPA fallback: serve index.html for unknown paths
			fs.readFile(fallbackPath, (fallbackErr, fallbackData) => {
				if (fallbackErr) {
					res.writeHead(404, { "content-type": "text/plain" });
					res.end("Portal not built. Run: pnpm build:portal");
					return;
				}
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
				});
				res.end(fallbackData);
			});
			return;
		}
		res.writeHead(200, { "content-type": contentType });
		res.end(data);
	});
}

/**
 * Serves the portal on `port`, or the next free port when it is taken,
 * so parallel CLI runs do not collide. Resolves with the bound port.
 */
export async function startPortalServer(port: number): Promise<number> {
	const distDir = resolveDistDir();
	const indexPath = path.join(distDir, "index.html");

	const server = http.createServer((req, res) => {
		const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;

		// Sanitize path to prevent directory traversal
		const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
		const filePath = path.join(distDir, safePath);

		// Ensure resolved path stays within distDir
		if (!filePath.startsWith(distDir)) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end("Forbidden");
			return;
		}

		// If path is a directory, serve index.html inside it
		const targetPath =
			safePath === "/" || safePath.endsWith("/") ? indexPath : filePath;

		serveFile(res, targetPath, indexPath);
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

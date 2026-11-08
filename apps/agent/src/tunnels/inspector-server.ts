/** HTTP server for the request inspector dashboard — serves UI + JSON API + SSE */

import http from "node:http";
import { getInspectorHtml } from "./inspector-ui.js";
import { listenWithPortFallback } from "./listen-with-port-fallback.js";
import type { InspectorEntry, RequestStore } from "./request-store.js";

interface InspectorServerOptions {
	/** Preferred port — the next free one is used when it is taken */
	port: number;
	store: RequestStore;
	/** Callback to replay a request by ID — returns the new entry */
	onReplay?: (id: string) => Promise<InspectorEntry | null>;
	/** Callback to replay a custom request */
	onReplayCustom?: (req: {
		method: string;
		path: string;
		headers: Record<string, string>;
		body: string | null;
	}) => Promise<InspectorEntry | null>;
	/** Get active tunnel info */
	getTunnels?: () => Array<{
		subdomain: string;
		localPort: number;
		url: string;
	}>;
}

/** Simple sliding-window rate limiter */
function createRateLimiter(maxPerSec: number) {
	let count = 0;
	setInterval(() => {
		count = 0;
	}, 1000);
	return {
		allow(): boolean {
			if (count >= maxPerSec) return false;
			count++;
			return true;
		},
	};
}

export interface InspectorServerHandle {
	server: http.Server;
	/** Port the inspector is actually reachable on */
	port: number;
	/** True when the preferred port was busy */
	fellBack: boolean;
}

export async function startInspectorServer(
	options: InspectorServerOptions,
): Promise<InspectorServerHandle> {
	const { port, store, onReplay, onReplayCustom, getTunnels } = options;
	const sseClients = new Set<http.ServerResponse>();
	const replayLimiter = createRateLimiter(10);

	// Push new entries to all SSE clients
	store.onAdd((entry) => {
		const data = `data: ${JSON.stringify(toSummary(entry))}\n\n`;
		for (const client of sseClients) {
			client.write(data);
		}
	});

	const server = http.createServer((req, res) => {
		// Base is only needed so relative request targets parse; the host is irrelevant.
		const url = new URL(req.url ?? "/", "http://localhost");
		const pathname = url.pathname;

		// CORS for local dev
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Dashboard HTML
		if (pathname === "/" && req.method === "GET") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(getInspectorHtml());
			return;
		}

		// Active tunnels
		if (pathname === "/api/tunnels" && req.method === "GET") {
			const tunnels = getTunnels?.() ?? [];
			sendJson(res, 200, tunnels);
			return;
		}

		// Request list (summaries, no bodies)
		if (pathname === "/api/requests" && req.method === "GET") {
			const filter = {
				subdomain: url.searchParams.get("subdomain") ?? undefined,
				status: url.searchParams.get("status") ?? undefined,
				q: url.searchParams.get("q") ?? undefined,
			};
			sendJson(res, 200, store.list(filter));
			return;
		}

		// Clear all requests
		if (pathname === "/api/requests" && req.method === "DELETE") {
			store.clear();
			sendJson(res, 200, { ok: true });
			return;
		}

		// SSE stream
		if (pathname === "/api/events" && req.method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(":ok\n\n");
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		// Request detail
		const detailMatch = pathname.match(/^\/api\/requests\/([^/]+)$/);
		if (detailMatch && req.method === "GET") {
			const entry = store.get(detailMatch[1]);
			if (!entry) {
				sendJson(res, 404, { error: "Not found" });
				return;
			}
			sendJson(res, 200, entry);
			return;
		}

		// Replay by ID
		const replayMatch = pathname.match(/^\/api\/requests\/([^/]+)\/replay$/);
		if (replayMatch && req.method === "POST") {
			if (!replayLimiter.allow()) {
				sendJson(res, 429, {
					error: "Replay rate limit exceeded (max 10/sec)",
				});
				return;
			}
			if (!onReplay) {
				sendJson(res, 501, { error: "Replay not available" });
				return;
			}
			onReplay(replayMatch[1])
				.then((entry) => {
					if (!entry) {
						sendJson(res, 404, { error: "Original request not found" });
						return;
					}
					sendJson(res, 200, toSummary(entry));
				})
				.catch((err) => {
					sendJson(res, 500, { error: (err as Error).message });
				});
			return;
		}

		// Custom replay
		if (pathname === "/api/replay" && req.method === "POST") {
			if (!replayLimiter.allow()) {
				sendJson(res, 429, {
					error: "Replay rate limit exceeded (max 10/sec)",
				});
				return;
			}
			if (!onReplayCustom) {
				sendJson(res, 501, { error: "Custom replay not available" });
				return;
			}
			collectBody(req, (body) => {
				try {
					const data = JSON.parse(body);
					onReplayCustom(data)
						.then((entry) => {
							if (!entry) {
								sendJson(res, 500, { error: "Replay failed" });
								return;
							}
							sendJson(res, 200, toSummary(entry));
						})
						.catch((err) => {
							sendJson(res, 500, { error: (err as Error).message });
						});
				} catch {
					sendJson(res, 400, { error: "Invalid JSON" });
				}
			});
			return;
		}

		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not Found");
	});

	const { port: boundPort, fellBack } = await listenWithPortFallback(
		server,
		port,
	);

	return { server, port: boundPort, fellBack };
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
}

const MAX_REPLAY_BODY = 1024 * 1024; // 1MB limit for replay requests

function collectBody(
	req: http.IncomingMessage,
	cb: (body: string) => void,
	onError?: (msg: string) => void,
): void {
	const chunks: Buffer[] = [];
	let size = 0;
	req.on("data", (chunk: Buffer) => {
		size += chunk.length;
		if (size > MAX_REPLAY_BODY) {
			req.destroy();
			onError?.("Request body too large");
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => cb(Buffer.concat(chunks).toString("utf-8")));
}

function toSummary(entry: InspectorEntry): Record<string, unknown> {
	const {
		requestBody,
		responseBody,
		requestHeaders,
		responseHeaders,
		...summary
	} = entry;
	return summary;
}

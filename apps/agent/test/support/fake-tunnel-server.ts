import http from "node:http";
import type { ClientToServerMessage, TunnelRequest } from "@tunelo/shared";
import { type WebSocket, WebSocketServer } from "ws";
import type { LinkInfo } from "../api-client.js";

export interface FakeTunnelServer {
	/** ws:// URL for `--server`. */
	wsUrl: string;
	/** Control sockets currently open. */
	openSockets(): number;
	/** Keys sent in `auth` messages. */
	authKeys: string[];
	/** Links `GET /api/links` lists and `DELETE /api/links/:id` removes. */
	links: LinkInfo[];
	close(): Promise<void>;
}

interface Pending {
	res: http.ServerResponse;
}

/**
 * A tiny tunnel server: accepts any `auth`, hands out
 * `http://127.0.0.1:<port>/t/<subdomain>` as the public URL, and relays GETs
 * on that URL through the control socket (streaming frames).
 */
export async function startFakeTunnelServer(): Promise<FakeTunnelServer> {
	const sockets = new Map<string, WebSocket>();
	const pending = new Map<string, Pending>();
	const authKeys: string[] = [];
	const links: LinkInfo[] = [];
	let seq = 0;
	let base = "";

	const server = http.createServer((req, res) => {
		if (req.url?.startsWith("/api/links")) {
			handleLinks(req, res, links);
			return;
		}
		const match = req.url?.match(/^\/t\/([^/]+)(\/.*)?$/);
		const ws = match?.[1] ? sockets.get(match[1]) : undefined;
		if (!match || !ws) {
			res.writeHead(502).end("no tunnel");
			return;
		}
		const id = `r${++seq}`;
		pending.set(id, { res });
		const request: TunnelRequest = {
			type: "request",
			id,
			method: req.method ?? "GET",
			path: match[2] ?? "/",
			headers: {},
			body: null,
			subdomain: match[1],
		};
		ws.send(JSON.stringify(request));
	});

	const wss = new WebSocketServer({ server, path: "/tunnel" });
	wss.on("connection", (ws) => {
		let subdomain = "";
		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString()) as ClientToServerMessage;
			if (msg.type === "auth") {
				authKeys.push(msg.key);
				subdomain = msg.subdomain || `sub${++seq}`;
				sockets.set(subdomain, ws);
				ws.send(
					JSON.stringify({
						type: "auth-result",
						success: true,
						subdomain,
						url: `${base}/t/${subdomain}`,
					}),
				);
			} else if (msg.type === "stream-start") {
				pending.get(msg.id)?.res.writeHead(msg.status);
			} else if (msg.type === "stream-data") {
				pending.get(msg.id)?.res.write(Buffer.from(msg.data, "base64"));
			} else if (msg.type === "stream-end") {
				pending.get(msg.id)?.res.end();
				pending.delete(msg.id);
			} else if (msg.type === "response") {
				const entry = pending.get(msg.id);
				entry?.res.writeHead(msg.status);
				entry?.res.end(msg.body ? Buffer.from(msg.body, "base64") : undefined);
				pending.delete(msg.id);
			}
		});
		ws.on("close", () => {
			if (sockets.get(subdomain) === ws) sockets.delete(subdomain);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	base = `http://127.0.0.1:${port}`;
	return {
		wsUrl: `ws://127.0.0.1:${port}`,
		openSockets: () => sockets.size,
		authKeys,
		links,
		close: () =>
			new Promise((resolve) => {
				for (const ws of wss.clients) ws.terminate();
				wss.close();
				server.close(() => resolve());
			}),
	};
}

/** The machine side of the link API: list and revoke, Bearer token required. */
function handleLinks(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	links: LinkInfo[],
): void {
	const send = (status: number, body: unknown): void => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (!req.headers.authorization?.startsWith("Bearer ")) {
		send(401, { error: { code: "TUNELO_AUTH_002", message: "Key required" } });
		return;
	}
	if (req.method === "GET" && req.url === "/api/links") {
		send(200, { links });
		return;
	}
	const id = decodeURIComponent(req.url?.split("/")[3] ?? "");
	const index = links.findIndex((link) => link.id === id);
	if (req.method === "DELETE" && index !== -1) {
		links.splice(index, 1);
		send(200, { ok: true });
		return;
	}
	send(404, { error: { code: "TUNELO_LINK_005", message: "Link not found" } });
}

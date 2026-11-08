// The inspector holds the headers and bodies of everyone who called the
// tunnel and can replay requests into the local app. Other web pages
// (CORS, DNS rebinding) must not reach it.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchInspectorRequests } from "../../src/tunnels/inspector-client.js";
import { startInspectorServer } from "../../src/tunnels/inspector-server.js";
import { RequestStore } from "../../src/tunnels/request-store.js";

let inspector: http.Server;
let port = 0;
const replayed: string[] = [];

beforeAll(async () => {
	const store = new RequestStore();
	store.add({
		id: "r1",
		timestamp: 0,
		method: "GET",
		path: "/secret",
		requestHeaders: { authorization: "Bearer SECRET-FROM-TUNNEL" },
		requestBody: null,
		status: 200,
		responseHeaders: {},
		responseBody: null,
		durationMs: 1,
		entryType: "normal",
	});
	const handle = await startInspectorServer({
		port: 47380,
		store,
		onReplayCustom: async (req) => {
			replayed.push(req.path);
			return null;
		},
	});
	inspector = handle.server;
	port = handle.port;
});

afterAll(async () => {
	await new Promise<void>((r) => inspector.close(() => r()));
});

function send(
	target: number,
	path: string,
	headers: Record<string, string>,
	method = "GET",
	body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: target, path, method, headers }, (res) => {
			let text = "";
			res.on("data", (c: Buffer) => (text += c.toString()));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

describe("request inspector", () => {
	test("refuses another site's page and sends no CORS headers", async () => {
		const res = await send(port, "/api/requests", { host: `127.0.0.1:${port}`, origin: "https://evil.example" });
		expect(res.status).toBe(403);
		expect(res.body).not.toContain("SECRET");
		expect(res.headers["access-control-allow-origin"]).toBeUndefined();
		const preflight = await send(port, "/api/replay", { host: `127.0.0.1:${port}`, origin: "https://evil.example" }, "OPTIONS");
		expect(preflight.status).toBe(403);
	});

	test("refuses a DNS rebinding page (a Host that is not loopback)", async () => {
		const res = await send(port, "/api/requests", { host: `rebind.evil.example:${port}` });
		expect(res.status).toBe(403);
	});

	test("refuses a replay from another site", async () => {
		const res = await send(
			port,
			"/api/replay",
			{ host: `localhost:${port}`, origin: "https://evil.example", "content-type": "application/json" },
			"POST",
			JSON.stringify({ method: "POST", path: "/admin", headers: {}, body: null }),
		);
		expect(res.status).toBe(403);
		expect(replayed).toEqual([]);
	});

	test("its own page works: same origin, under localhost, 127.0.0.1 or [::1]", async () => {
		for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
			const page = await send(port, "/", { host });
			expect(page.status).toBe(200);
		}
		const list = await send(port, "/api/requests", { host: `localhost:${port}`, origin: `http://localhost:${port}` });
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)).toHaveLength(1);
		await send(
			port,
			"/api/replay",
			{ host: `localhost:${port}`, origin: `http://localhost:${port}`, "content-type": "application/json" },
			"POST",
			JSON.stringify({ method: "GET", path: "/again", headers: {}, body: null }),
		);
		expect(replayed).toEqual(["/again"]);
	});

	test("`tunelo watch` and the MCP tools still read it", async () => {
		const summaries = await fetchInspectorRequests(port);
		expect(summaries.map((s) => s.id)).toEqual(["r1"]);
	});
});

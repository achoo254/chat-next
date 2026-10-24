import { afterEach, describe, expect, it } from "vitest";
import { ApiError, Client, InputFile, NetworkError } from "../src/index.ts";
import { fail, hangUp, jsonOf, ok, sendJson, startFake } from "./fake-server.ts";
import type { FakeServer, Route } from "./fake-server.ts";

const TOKEN = "42:secret-token-value";
let fake: FakeServer | undefined;

afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

async function setup(route: Route, retries = 3): Promise<{ client: Client; server: FakeServer }> {
	fake = await startFake(route);
	return { client: new Client(TOKEN, { baseUrl: `${fake.url}/bot/v1/`, retries }), server: fake };
}

/** Answers each request with the next route; the last one repeats. */
function sequence(...routes: Route[]): Route {
	let i = 0;
	return (request, res) => {
		const route = routes[Math.min(i++, routes.length - 1)];
		route?.(request, res);
	};
}

const message = { chat: { id: 7, type: "private" }, seq: 3, date: 1 };

describe("Client options", () => {
	it("needs the base URL of the user's chat server", () => {
		expect(() => new Client(TOKEN, { baseUrl: "" })).toThrow(/needs options\.baseUrl/);
		// A JavaScript caller can leave the options out entirely.
		expect(() => new (Client as unknown as new (token: string) => Client)(TOKEN)).toThrow(/needs options\.baseUrl/);
	});

	it("refuses a base URL that is not an absolute http(s) URL", () => {
		expect(() => new Client(TOKEN, { baseUrl: "chat.example.com/bot/v1" })).toThrow(/absolute http\(s\) URL/);
		expect(() => new Client(TOKEN, { baseUrl: "ftp://chat.example.com/bot/v1" })).toThrow(/http\(s\) URL/);
		for (const bad of [" https://chat.example.com/bot/v1", "https://chat.example.com/bot/v1?a=1", "https://chat.example.com/bot/v1#x", "https://u:p@chat.example.com/bot/v1"]) {
			expect(() => new Client(TOKEN, { baseUrl: bad })).toThrow(/plain URL/);
		}
	});

	it("drops trailing slashes of the base URL", async () => {
		const { client, server } = await setup((_req, res) => ok(res, { id: 1 }));
		await client.request("GET", "/me");
		expect(server.requests[0]?.url.pathname).toBe("/bot/v1/me");
	});
});

describe("Client envelope", () => {
	it("returns the result and sends the token and JSON body", async () => {
		const { client, server } = await setup((_req, res) => ok(res, message));
		const result = await client.sendMessage({ chat_id: 7, text: "chào" });
		expect(result).toEqual(message);
		const [request] = server.requests;
		expect(request?.method).toBe("POST");
		expect(request?.url.pathname).toBe("/bot/v1/messages");
		expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(request?.headers["content-type"]).toBe("application/json");
		expect(jsonOf(request)).toEqual({ chat_id: 7, text: "chào" });
	});

	it("encodes query parameters and keeps empty strings", async () => {
		const { client, server } = await setup((_req, res) => ok(res, []));
		await client.getUpdates({ offset: 5, timeout: 0, allowed_updates: "" });
		await client.deleteWebhook({ drop_pending: true });
		expect(server.requests[0]?.url.search).toBe("?offset=5&timeout=0&allowed_updates=");
		expect(server.requests[1]?.method).toBe("DELETE");
		expect(server.requests[1]?.url.search).toBe("?drop_pending=true");
	});

	it("turns an error envelope into ApiError without the token", async () => {
		const { client } = await setup((_req, res) => fail(res, 403, "no_consent"));
		const error = await client.sendMessage({ chat_id: 7, text: "x" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 403, code: "no_consent", description: "no_consent happened", retryAfter: 0 });
		expect(String(error)).not.toContain("secret-token-value");
	});

	it("reports a body that is not an envelope as invalid_response", async () => {
		const { client } = await setup((_req, res) => {
			res.writeHead(502, { "Content-Type": "text/html" });
			res.end("<html>bad gateway</html>");
		});
		await expect(client.getMe()).rejects.toMatchObject({ status: 502, code: "invalid_response" });
	});
});

describe("Client retries", () => {
	it("retries 429 rate_limited after retry_after", async () => {
		const { client, server } = await setup(
			sequence(
				(_req, res) => fail(res, 429, "rate_limited", 1),
				(_req, res) => ok(res, message),
			),
		);
		const started = Date.now();
		await expect(client.sendMessage({ chat_id: 7, text: "x" })).resolves.toEqual(message);
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(server.requests).toHaveLength(2);
	});

	it("retries 503 unavailable and reads Retry-After when the envelope has none", async () => {
		const { client, server } = await setup(
			sequence(
				(_req, res) => fail(res, 503, "unavailable", undefined, { "Retry-After": "1" }),
				(_req, res) => ok(res, true),
			),
		);
		await client.setCommands({ commands: [] });
		expect(server.requests).toHaveLength(2);
	});

	it("gives up after the configured retries", async () => {
		const { client, server } = await setup((_req, res) => fail(res, 503, "unavailable", 0, { "Retry-After": "7" }), 0);
		await expect(client.getMe()).rejects.toMatchObject({ status: 503, code: "unavailable", retryAfter: 7 });
		expect(server.requests).toHaveLength(1);
	});

	it("retries at most `retries` times", async () => {
		const { client, server } = await setup((_req, res) => fail(res, 429, "rate_limited", 1), 1);
		await expect(client.getMe()).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfter: 1 });
		expect(server.requests).toHaveLength(2);
	});

	it("does not retry other errors", async () => {
		const { client, server } = await setup(
			sequence(
				(_req, res) => fail(res, 500, "internal"),
				(_req, res) => fail(res, 429, "bulk_quota"),
			),
		);
		await expect(client.getMe()).rejects.toMatchObject({ code: "internal" });
		await expect(client.getMe()).rejects.toMatchObject({ code: "bulk_quota" });
		expect(server.requests).toHaveLength(2);
	});

	it("does not retry a POST whose connection failed", async () => {
		const { client, server } = await setup((_req, res) => hangUp(res));
		const error = await client.sendMessage({ chat_id: 7, text: "x" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkError);
		expect(String(error)).not.toContain("secret-token-value");
		expect(server.requests).toHaveLength(1);
	});

	it("retries a GET whose connection failed", async () => {
		const { client, server } = await setup(
			sequence(
				(_req, res) => hangUp(res),
				(_req, res) => ok(res, { id: 1 }),
			),
		);
		await expect(client.getMe()).resolves.toEqual({ id: 1 });
		expect(server.requests).toHaveLength(2);
	});
});

describe("Client uploads", () => {
	async function formOf(server: FakeServer, index: number): Promise<FormData> {
		const request = server.requests[index];
		const contentType = request?.headers["content-type"] ?? "";
		expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
		return new Response(request?.body, { headers: { "content-type": contentType } }).formData();
	}

	it("sends sendMediaUpload as multipart with the file in part `file`", async () => {
		const { client, server } = await setup((_req, res) => ok(res, message));
		await client.sendMediaUpload({
			chat_id: 7,
			kind: "document",
			file: new InputFile("hello.txt", new TextEncoder().encode("xin chào")),
			text: "Tệp mẫu",
			entities: JSON.stringify([{ type: "bold", offset: 0, length: 3 }]),
		});
		expect(server.requests[0]?.url.pathname).toBe("/bot/v1/messages:sendMedia");
		const form = await formOf(server, 0);
		expect(form.get("chat_id")).toBe("7");
		expect(form.get("kind")).toBe("document");
		expect(form.get("text")).toBe("Tệp mẫu");
		expect(JSON.parse(String(form.get("entities")))).toEqual([{ type: "bold", offset: 0, length: 3 }]);
		const file = form.get("file");
		expect(file).toBeInstanceOf(Blob);
		expect((file as globalThis.File).name).toBe("hello.txt");
		expect((file as Blob).size).toBe(9);
		expect(await (file as Blob).text()).toBe("xin chào");
	});

	it("sends sendAlbumUpload with one part per attach name", async () => {
		const { client, server } = await setup((_req, res) => ok(res, [message, message]));
		const items = JSON.stringify([
			{ attach: "one", kind: "document" },
			{ attach: "two", kind: "document", text: "second" },
		]);
		await client.sendAlbumUpload(
			{ chat_id: 7, items },
			{ one: new InputFile("a.txt", new Uint8Array([1, 2])), two: new InputFile("b.txt", new Blob(["bee"])) },
		);
		const form = await formOf(server, 0);
		expect(form.get("items")).toBe(items);
		expect((form.get("one") as globalThis.File).name).toBe("a.txt");
		expect((form.get("two") as globalThis.File).name).toBe("b.txt");
		expect(await (form.get("two") as Blob).text()).toBe("bee");
	});

	it("refuses an album whose attach names and files differ", async () => {
		const { client, server } = await setup((_req, res) => ok(res, []));
		const items = JSON.stringify([{ attach: "one", kind: "document" }]);
		expect(() => client.sendAlbumUpload({ chat_id: 7, items }, {})).toThrow(TypeError);
		expect(() =>
			client.sendAlbumUpload({ chat_id: 7, items }, { one: new InputFile("a", new Uint8Array()), extra: new InputFile("b", new Uint8Array()) }),
		).toThrow(TypeError);
		expect(server.requests).toHaveLength(0);
	});

	it("downloads a file without the token", async () => {
		const { client, server } = await setup((req, res) => {
			if (req.url.pathname === "/missing") {
				sendJson(res, 404, { ok: false, error: { code: "not_found", description: "gone" } });
				return;
			}
			res.writeHead(200, { "Content-Type": "application/octet-stream" });
			res.end(Buffer.from([1, 2, 3]));
		});
		const bytes = await client.downloadFile({ url: `${server.url}/f/abc?sig=1` });
		expect(Array.from(bytes)).toEqual([1, 2, 3]);
		expect(server.requests[0]?.headers.authorization).toBeUndefined();
		await expect(client.downloadFile(`${server.url}/missing`)).rejects.toMatchObject({ status: 404, code: "not_found" });
	});
});

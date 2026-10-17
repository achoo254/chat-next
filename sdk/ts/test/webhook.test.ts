import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWebhook, webhookHandler } from "../src/index.ts";
import type { Update, WebhookHandlerOptions } from "../src/index.ts";

// Test vector of docs/bot-api/README.md.
const SECRET = "my_secret";
const TIMESTAMP = "1760500000";
const BODY = '{"update_id":1}';
const SIGNATURE = "v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1";
const AT = new Date(Number(TIMESTAMP) * 1000);

function headers(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		"x-bot-api-secret-token": SECRET,
		"x-bot-timestamp": TIMESTAMP,
		"x-bot-signature": SIGNATURE,
		...overrides,
	};
}

describe("verifyWebhook", () => {
	it("accepts the documented test vector", () => {
		expect(verifyWebhook(headers(), BODY, SECRET, AT)).toBe(true);
		expect(verifyWebhook(new Headers(headers()), new TextEncoder().encode(BODY), SECRET, AT)).toBe(true);
	});

	it("rejects a wrong secret token", () => {
		expect(verifyWebhook(headers({ "x-bot-api-secret-token": "other" }), BODY, SECRET, AT)).toBe(false);
		expect(verifyWebhook(headers(), BODY, "other", AT)).toBe(false);
	});

	it("rejects a wrong signature or a changed body", () => {
		expect(verifyWebhook(headers({ "x-bot-signature": SIGNATURE.replace(/.$/, "0") }), BODY, SECRET, AT)).toBe(false);
		expect(verifyWebhook(headers(), '{"update_id":2}', SECRET, AT)).toBe(false);
		const { "x-bot-signature": _dropped, ...unsigned } = headers();
		expect(verifyWebhook(unsigned, BODY, SECRET, AT)).toBe(false);
	});

	it("allows 5 minutes of clock skew and no more", () => {
		const shifted = (seconds: number): Date => new Date(AT.getTime() + seconds * 1000);
		expect(verifyWebhook(headers(), BODY, SECRET, shifted(300))).toBe(true);
		expect(verifyWebhook(headers(), BODY, SECRET, shifted(-300))).toBe(true);
		expect(verifyWebhook(headers(), BODY, SECRET, shifted(301))).toBe(false);
		expect(verifyWebhook(headers(), BODY, SECRET, shifted(-301))).toBe(false);
	});
});

describe("webhookHandler", () => {
	let server: Server | undefined;

	afterEach(async () => {
		const s = server;
		server = undefined;
		if (s !== undefined) {
			s.closeAllConnections();
			await new Promise((resolve) => s.close(resolve));
		}
	});

	async function serve(onUpdate: WebhookHandlerOptions["onUpdate"]): Promise<string> {
		server = createServer(webhookHandler({ secret: SECRET, onUpdate, onError: () => {} }));
		const s = server;
		await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`;
	}

	function signed(body: string, secret = SECRET): Record<string, string> {
		const ts = String(Math.floor(Date.now() / 1000));
		const signature = "v1=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
		return {
			"content-type": "application/json",
			"x-bot-api-secret-token": secret,
			"x-bot-timestamp": ts,
			"x-bot-signature": signature,
		};
	}

	function post(url: string, update: object, secret = SECRET): Promise<Response> {
		const body = JSON.stringify(update);
		return fetch(url, { method: "POST", headers: signed(body, secret), body });
	}

	it("answers 401 without a body and skips the handler when the check fails", async () => {
		const onUpdate = vi.fn();
		const url = await serve(onUpdate);
		const res = await post(url, { update_id: 1 }, "wrong");
		expect(res.status).toBe(401);
		expect(await res.text()).toBe("");
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("answers 204 when the handler returns nothing", async () => {
		const seen: Update[] = [];
		const url = await serve((update) => {
			seen.push(update);
		});
		const res = await post(url, { update_id: 5, message: { seq: 1 } });
		expect(res.status).toBe(204);
		expect(seen).toEqual([{ update_id: 5, message: { seq: 1 } }]);
	});

	it("answers 200 with the handler's WebhookAnswer", async () => {
		const url = await serve(() => ({ method: "sendMessage", chat_id: 42, text: "Đã nhận" }));
		const res = await post(url, { update_id: 6 });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");
		expect(await res.json()).toEqual({ method: "sendMessage", chat_id: 42, text: "Đã nhận" });
	});

	it("answers 200 to a repeated update_id without running the handler again", async () => {
		const onUpdate = vi.fn();
		const url = await serve(onUpdate);
		expect((await post(url, { update_id: 7 })).status).toBe(204);
		const again = await post(url, { update_id: 7 });
		expect(again.status).toBe(200);
		expect(await again.text()).toBe("");
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it("answers 500 when the handler throws, and runs it again on redelivery", async () => {
		let calls = 0;
		const url = await serve(() => {
			calls++;
			if (calls === 1) {
				throw new Error("boom");
			}
		});
		expect((await post(url, { update_id: 8 })).status).toBe(500);
		expect((await post(url, { update_id: 8 })).status).toBe(204);
		expect(calls).toBe(2);
	});

	it("answers 413 to a body over 1 MiB", async () => {
		const onUpdate = vi.fn();
		const url = await serve(onUpdate);
		const res = await post(url, { update_id: 9, pad: "x".repeat(1 << 20) });
		expect(res.status).toBe(413);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("answers 405 to other methods and 400 to a body that is not an update", async () => {
		const url = await serve(() => {});
		expect((await fetch(url)).status).toBe(405);
		const body = '{"hello":1}';
		expect((await fetch(url, { method: "POST", headers: signed(body), body })).status).toBe(400);
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { ApiError, Client, poll } from "../src/index.ts";
import type { Update } from "../src/index.ts";
import { fail, ok, startFake } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";

let fake: FakeServer | undefined;

afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

const update = (id: number): Update => ({
	update_id: id,
	message: { chat: { id: 1, type: "private" }, seq: id, date: 1, text: `m${id}` },
});

describe("poll", () => {
	it("acknowledges with offset = last update_id + 1, also after a handler error", async () => {
		const stop = new AbortController();
		let calls = 0;
		fake = await startFake((_req, res) => {
			calls++;
			if (calls === 1) {
				ok(res, [update(10), update(11)]);
			} else if (calls === 2) {
				stop.abort();
				ok(res, []);
			} else {
				ok(res, []);
			}
		});
		const client = new Client("1:t", { baseUrl: fake.url });
		const handled: number[] = [];
		const errors: number[] = [];
		await poll(
			client,
			(u) => {
				handled.push(u.update_id);
				if (u.update_id === 10) {
					throw new Error("handler failed");
				}
			},
			{ signal: stop.signal, onError: (_e, u) => errors.push(u.update_id) },
		);

		expect(handled).toEqual([10, 11]);
		expect(errors).toEqual([10]);
		const queries = fake.requests.map((r) => Object.fromEntries(r.url.searchParams));
		expect(queries[0]).toEqual({ timeout: "50" });
		expect(queries[1]).toEqual({ timeout: "50", offset: "12" });
		// The aborted request may not have reached the server's answer, so the
		// loop acknowledges once more on the way out.
		expect(queries.at(-1)).toMatchObject({ offset: "12" });
		expect(fake.requests.every((r) => r.url.pathname === "/updates")).toBe(true);
	});

	it("sends allowed_updates on the first request only", async () => {
		const stop = new AbortController();
		fake = await startFake((_req, res) => {
			if (fake?.requests.length === 2) {
				stop.abort();
			}
			ok(res, []);
		});
		const client = new Client("1:t", { baseUrl: fake.url });
		await poll(client, () => {}, { signal: stop.signal, allowedUpdates: ["message", "reaction"] });
		expect(fake.requests[0]?.url.searchParams.get("allowed_updates")).toBe("message,reaction");
		expect(fake.requests[1]?.url.searchParams.has("allowed_updates")).toBe(false);
	});

	it("stops with the ApiError on 409 conflict", async () => {
		fake = await startFake((_req, res) => fail(res, 409, "conflict"));
		const client = new Client("1:t", { baseUrl: fake.url });
		const error = await poll(client, () => {}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, code: "conflict" });
		expect(fake.requests).toHaveLength(1);
	});

	it("waits and continues after a server error", async () => {
		const stop = new AbortController();
		let calls = 0;
		fake = await startFake((_req, res) => {
			calls++;
			if (calls === 1) {
				fail(res, 500, "internal");
				return;
			}
			stop.abort();
			ok(res, []);
		});
		const client = new Client("1:t", { baseUrl: fake.url });
		const retries: number[] = [];
		await poll(client, () => {}, { signal: stop.signal, onRetry: (_e, delayMs) => retries.push(delayMs) });
		expect(retries).toEqual([1000]);
		expect(calls).toBe(2);
	});

	it("returns at once when the signal is already aborted", async () => {
		fake = await startFake((_req, res) => ok(res, []));
		const client = new Client("1:t", { baseUrl: fake.url });
		await poll(client, () => {}, { signal: AbortSignal.abort() });
		expect(fake.requests).toHaveLength(0);
	});
});

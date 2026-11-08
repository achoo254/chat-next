import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listenWithPortFallback } from "./listen-with-port-fallback.js";

const openServers: http.Server[] = [];

function newServer(): http.Server {
	const server = http.createServer();
	openServers.push(server);
	return server;
}

afterEach(async () => {
	await Promise.all(
		openServers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					if (!server.listening) {
						resolve();
						return;
					}
					server.close(() => resolve());
				}),
		),
	);
});

/** Grab a real free port so tests never guess at what the machine has open */
async function reserveEphemeralPort(): Promise<number> {
	const holder = newServer();
	const { port } = await listenWithPortFallback(holder, 0);
	return port;
}

/**
 * Hold two adjacent ports, `first` and `first + 1`. Another process (a
 * busy CI runner) may already own the port after a random free one, so
 * retry with a new pair until both bind; returns `first`.
 */
async function reserveAdjacentPorts(): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const first = await reserveEphemeralPort();
		const next = newServer();
		const second = await listenWithPortFallback(next, first + 1, {
			maxAttempts: 1,
		});
		if (second.port === first + 1) return first;
		await new Promise<void>((resolve) => next.close(() => resolve()));
	}
	throw new Error("could not hold two adjacent free ports");
}

describe("listenWithPortFallback", () => {
	it("binds the preferred port when it is free", async () => {
		const free = await reserveEphemeralPort();
		const holder = openServers[openServers.length - 1];
		await new Promise<void>((resolve) => holder.close(() => resolve()));

		const result = await listenWithPortFallback(newServer(), free);

		expect(result.port).toBe(free);
		expect(result.fellBack).toBe(false);
	});

	it("moves to the next port when the preferred one is taken", async () => {
		const taken = await reserveEphemeralPort();

		const result = await listenWithPortFallback(newServer(), taken);

		expect(result.port).not.toBe(taken);
		expect(result.port).toBeGreaterThan(taken);
		expect(result.fellBack).toBe(true);
	});

	it("falls back to an ephemeral port when every candidate is taken", async () => {
		const first = await reserveAdjacentPorts();

		// Only two candidates are probed, and both are already bound.
		const result = await listenWithPortFallback(newServer(), first, {
			maxAttempts: 2,
		});

		expect(result.fellBack).toBe(true);
		expect(result.port).not.toBe(first);
		expect(result.port).not.toBe(first + 1);
	});

	it("keeps two concurrent inspectors on distinct ports", async () => {
		const base = await reserveEphemeralPort();
		const holder = openServers[openServers.length - 1];
		await new Promise<void>((resolve) => holder.close(() => resolve()));

		const first = await listenWithPortFallback(newServer(), base);
		const second = await listenWithPortFallback(newServer(), base);

		expect(first.port).toBe(base);
		expect(second.port).not.toBe(first.port);
	});
});

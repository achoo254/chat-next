import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemTimers } from "@app/platform";
import { ClientPlatform } from "@app/proto-ts/auth";
import { backoffDelay, DEFAULT_BACKOFF } from "../src/transport/backoff.ts";
import { deadAfterMs, RealtimeConnection, type RealtimeHandlers } from "../src/transport/realtime.ts";
import { FakeServer } from "./support/fake-server.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

function recorder(): RealtimeHandlers & { hellos: number; ended: string[]; failedHandshakes: number; states: string[] } {
	const log = { hellos: 0, ended: [] as string[], failedHandshakes: 0, states: [] as string[] };
	return Object.assign(log, {
		onHello: () => {
			log.hellos++;
		},
		onUpdates: () => undefined,
		onSessionEnded: (reason: string) => {
			log.ended.push(reason);
		},
		onHandshakeFailed: () => {
			log.failedHandshakes++;
		},
		onStateChange: (state: string) => {
			log.states.push(state);
		},
	});
}

function connect(server: FakeServer, userId: number, handlers: RealtimeHandlers, random = () => 0.5): RealtimeConnection {
	const connection = new RealtimeConnection(
		{
			url: "wss://chat.example.test/ws",
			socket: server.socketFactory(userId),
			timers: systemTimers,
			platform: ClientPlatform.WEB,
			appVersion: "test",
			random,
		},
		handlers,
	);
	connection.start();
	return connection;
}

describe("backoff", () => {
	it("grows exponentially with jitter inside [cap/2, cap] and stops at the maximum", () => {
		expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(250);
		expect(backoffDelay(0, DEFAULT_BACKOFF, () => 1)).toBe(500);
		expect(backoffDelay(3, DEFAULT_BACKOFF, () => 0.5)).toBe(3000);
		expect(backoffDelay(40, DEFAULT_BACKOFF, () => 1)).toBe(30_000);
		expect(backoffDelay(40, DEFAULT_BACKOFF, () => 0)).toBe(15_000);
	});
});

describe("realtime connection", () => {
	it("declares a silent socket dead after heartbeat plus margin and reconnects", async () => {
		const server = new FakeServer();
		const user = server.addUser("Tôi");
		server.heartbeatMs = 10_000;
		const handlers = recorder();
		const connection = connect(server, user, handlers);
		await vi.advanceTimersByTimeAsync(10);
		expect(handlers.hellos).toBe(1);
		expect(connection.connectionState).toBe("connected");

		// The network silently drops everything (no FIN, no pong).
		server.silent = true;
		await vi.advanceTimersByTimeAsync(deadAfterMs(10_000) - 100);
		expect(connection.connectionState).toBe("connected");
		await vi.advanceTimersByTimeAsync(200);
		expect(connection.connectionState).not.toBe("connected");

		server.silent = false;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(handlers.hellos).toBe(2);
		expect(connection.connectionState).toBe("connected");
		connection.stop();
	});

	it("keeps a healthy socket alive with pings", async () => {
		const server = new FakeServer();
		const user = server.addUser("Tôi");
		server.heartbeatMs = 10_000;
		const handlers = recorder();
		const connection = connect(server, user, handlers);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(handlers.hellos).toBe(1);
		expect(connection.connectionState).toBe("connected");
		connection.stop();
	});

	it("backs off while the server is unreachable, then reconnects", async () => {
		const server = new FakeServer();
		const user = server.addUser("Tôi");
		server.online = false;
		const handlers = recorder();
		const connection = connect(server, user, handlers, () => 0);
		await vi.advanceTimersByTimeAsync(5_000);
		// 250 + 500 + 1000 + 2000 ms of waits fit in 5 s: a handful of tries, not a storm.
		expect(handlers.failedHandshakes).toBeGreaterThanOrEqual(3);
		expect(handlers.failedHandshakes).toBeLessThanOrEqual(6);
		server.online = true;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(handlers.hellos).toBe(1);
		connection.stop();
	});

	it("reconnects on ResyncFrame and reports SessionRevokedFrame", async () => {
		const server = new FakeServer();
		const user = server.addUser("Tôi");
		const a = server.addUser("An");
		const handlers = recorder();
		const connection = connect(server, user, handlers);
		await vi.advanceTimersByTimeAsync(10);
		server.restoreWithNewEpoch(server.createChat(1, "", [user, a]), 0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(handlers.hellos).toBe(2);
		server.revokeSessions(user);
		await vi.advanceTimersByTimeAsync(10);
		expect(handlers.ended).toEqual(["revoked_by_user"]);
		connection.stop();
	});
});

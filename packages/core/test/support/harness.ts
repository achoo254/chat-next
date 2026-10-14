import { vi } from "vitest";
import { systemTimers, type NotificationRequest, type Platform } from "@app/platform";
import { databaseName } from "../../src/auth/web.ts";
import { startApp, type ChatCore, type StartOptions } from "../../src/app/start-app.ts";
import type { FakeServer } from "./fake-server.ts";
import type { MemorySqlFactory } from "./node-sql.ts";

export const TENANT = "chat.example.test";

export interface TestPlatform extends Platform {
	readonly notifications: NotificationRequest[];
	readonly cleared: string[];
	setForeground(foreground: boolean): void;
	goOnline(): void;
}

export function testPlatform(server: FakeServer, userId: number, sql: MemorySqlFactory): TestPlatform {
	let foreground = true;
	const foregroundListeners = new Set<(value: boolean) => void>();
	const onlineListeners = new Set<() => void>();
	let nextRandom = 1;
	const notifications: NotificationRequest[] = [];
	const cleared: string[] = [];
	return {
		sql,
		lifecycle: {
			isForeground: () => foreground,
			onForegroundChange: (listener) => {
				foregroundListeners.add(listener);
				return () => foregroundListeners.delete(listener);
			},
			onOnline: (listener) => {
				onlineListeners.add(listener);
				return () => onlineListeners.delete(listener);
			},
		},
		notify: {
			show: (request) => notifications.push(request),
			clear: (tag) => cleared.push(tag),
		},
		socket: server.socketFactory(userId),
		timers: systemTimers,
		frame: (callback) => queueMicrotask(callback),
		randomId: () => userId * 1_000_000 + nextRandom++,
		notifications,
		cleared,
		setForeground: (value) => {
			foreground = value;
			for (const listener of foregroundListeners) listener(value);
		},
		goOnline: () => {
			for (const listener of onlineListeners) listener();
		},
	};
}

export async function startTestApp(
	server: FakeServer,
	userId: number,
	sql: MemorySqlFactory,
	extra: Partial<StartOptions> = {},
): Promise<{ core: ChatCore; platform: TestPlatform }> {
	const platform = testPlatform(server, userId, sql);
	const result = await startApp(platform, {
		api: server.apiFor(userId),
		realtimeUrl: "wss://chat.example.test/ws",
		appVersion: "test",
		client: "web",
		tenant: TENANT,
		...extra,
	});
	if (result.status !== "active") throw new Error(`app did not start: ${result.reason}`);
	return { core: result.core, platform };
}

/** Advances fake time until the core has been connected and idle for a while. */
export async function settle(core: ChatCore, maxMs = 120_000, needConnection = true): Promise<void> {
	let quiet = 0;
	for (let elapsed = 0; elapsed < maxMs; elapsed += 20) {
		await vi.advanceTimersByTimeAsync(20);
		const idle = !core.busy && (!needConnection || core.connectionState() === "connected");
		quiet = idle ? quiet + 1 : 0;
		if (quiet >= 10) return;
	}
	throw new Error("core did not settle");
}

export function dbName(userId: number): string {
	return databaseName(TENANT, userId);
}

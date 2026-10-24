// Success criterion: with two tabs one writes the database and the other
// works normally through it; closing the leader tab hands over to the other.
// Runs the real core against the in-memory protocol server of @achoo254/chat-core's
// tests, with a database that survives the hand-over like an OPFS file.
import { afterEach, describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { startApp, type ChatCore, type HistoryView } from "@achoo254/chat-core";
import { systemTimers, type Platform } from "@achoo254/chat-platform";
import { FakeServer } from "../../core/test/support/fake-server.ts";
import { MemorySqlFactory } from "../../core/test/support/node-sql.ts";
import { LeaderLock, type LockManagerLike } from "../src/leader.ts";
import type { CoreMethod } from "../src/protocol.ts";
import { TabHub, type LeaderCore } from "../src/tab-hub.ts";
import { RelayedLifecycle } from "../src/worker-platform.ts";

class FakeLocks implements LockManagerLike {
	private held = false;
	private readonly queue: (() => void)[] = [];

	request(_name: string, _options: { mode: "exclusive" }, callback: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			const run = (): void => {
				this.held = true;
				callback()
					.then(resolve, reject)
					.finally(() => {
						this.held = false;
						this.queue.shift()?.();
					});
			};
			if (this.held) this.queue.push(run);
			else run();
		});
	}
}

const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const run of cleanup.splice(0)) run();
});

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function openTab(
	id: string,
	server: FakeServer,
	self: number,
	sql: MemorySqlFactory,
	locks: FakeLocks,
): { hub: TabHub; cores: ChatCore[]; events: string[] } {
	const cores: ChatCore[] = [];
	const events: string[] = [];
	const lifecycle = new RelayedLifecycle(true);
	const channel = new BroadcastChannel("chat-core:two-tabs");
	const hub = new TabHub({
		tabId: id,
		channel,
		lock: new LeaderLock(locks, "leader"),
		startLeader: async (): Promise<LeaderCore> => {
			const platform: Platform = {
				sql,
				lifecycle,
				notify: { show: () => undefined, clear: () => undefined },
				socket: server.socketFactory(self),
				timers: systemTimers,
				frame: (cb) => {
					setTimeout(cb, 0);
				},
				randomId: () => Math.floor(Math.random() * 2 ** 40) + 1,
			};
			const result = await startApp(platform, {
				api: server.apiFor(self),
				realtimeUrl: "wss://chat.example.test/ws",
				appVersion: "test",
				client: "web",
				tenant: "chat.example.test",
				userIdHint: self,
			});
			if (result.status !== "active") throw new Error(result.reason);
			const core = result.core;
			cores.push(core);
			return {
				invoke: async (method: CoreMethod, args: unknown[]) => {
					const fn = core[method] as (...callArgs: unknown[]) => unknown;
					return fn.apply(core, args);
				},
				subscribe: (listener) => core.events.subscribeBatches(listener),
				close: () => core.close(),
			};
		},
		onEvents: (keys) => events.push(...keys),
		onEnded: () => undefined,
		onRole: () => undefined,
		onUser: () => undefined,
		onForeground: (value) => lifecycle.setForeground(value),
		onOnline: () => lifecycle.reportOnline(),
		onError: (err, context) => {
			throw new Error(`${context}: ${String(err)}`);
		},
	});
	hub.start(true);
	cleanup.push(() => hub.close());
	return { hub, cores, events };
}

describe("two tabs on one database", () => {
	it("serves the follower through the leader and survives closing the leader", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, a]);
		const sql = new MemorySqlFactory();
		const locks = new FakeLocks();

		const first = openTab("A", server, self, sql, locks);
		await until(() => first.cores.length === 1 && first.cores[0]?.connectionState() === "connected");
		const second = openTab("B", server, self, sql, locks);

		// The follower sends; the leader's core writes and the server receives it.
		await second.hub.call("sendText", [chat, "từ tab B", { randomId: 4242 }]);
		await until(() => server.expectedMessages(chat, self).length === 1);
		server.sendMessage(a, chat, "trả lời");
		await until(async () => {
			const view = (await second.hub.call("history", [chat])) as HistoryView;
			return view.messages.length === 2;
		});
		expect(second.events).toContain(`history:${chat}`);
		expect(second.cores).toHaveLength(0); // the follower never opened the database

		// Close the leader tab: the follower takes over the same database.
		first.hub.close();
		await until(() => second.cores.length === 1 && second.cores[0]?.connectionState() === "connected");
		server.sendMessage(a, chat, "sau khi đổi tab");
		await until(async () => {
			const view = (await second.hub.call("history", [chat])) as HistoryView;
			return view.messages.length === 3;
		});
		const view = (await second.hub.call("history", [chat])) as HistoryView;
		expect(view.messages.map((m) => m.text)).toEqual(["từ tab B", "trả lời", "sau khi đổi tab"]);
		expect(view.messages.every((m) => !m.stale)).toBe(true);
	});
});

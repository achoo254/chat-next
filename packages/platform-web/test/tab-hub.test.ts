// Two tabs in one process: Node's BroadcastChannel connects them like the
// browser's, and an in-memory lock manager stands in for navigator.locks.
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEndReason } from "@app/core";
import { LeaderLock, type LockManagerLike } from "../src/leader.ts";
import type { CoreMethod } from "../src/protocol.ts";
import { TabHub, type LeaderCore } from "../src/tab-hub.ts";

/** Exclusive locks granted in request order, like navigator.locks. */
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

interface Tab {
	readonly hub: TabHub;
	readonly id: string;
	readonly roles: string[];
	readonly events: (readonly string[])[];
	readonly ended: SessionEndReason[];
	readonly foreground: boolean[];
	readonly invoked: { method: CoreMethod; args: unknown[] }[];
	emit(keys: readonly string[]): void;
}

const channels: BroadcastChannel[] = [];
const hubs: TabHub[] = [];

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.close();
	for (const channel of channels.splice(0)) channel.close();
});

/** A tab whose leader core answers "dialogs" with its own id and can be told to hang. */
function openTab(id: string, locks: FakeLocks, options: { hang?: CoreMethod } = {}): Tab {
	const roles: string[] = [];
	const events: (readonly string[])[] = [];
	const ended: SessionEndReason[] = [];
	const foreground: boolean[] = [];
	const invoked: { method: CoreMethod; args: unknown[] }[] = [];
	const listeners = new Set<(keys: readonly string[]) => void>();
	const channel = new BroadcastChannel("chat-core:test");
	channels.push(channel);
	const hub = new TabHub({
		tabId: id,
		channel,
		lock: new LeaderLock(locks, "leader"),
		startLeader: async (): Promise<LeaderCore> => ({
			invoke: async (method, args) => {
				invoked.push({ method, args });
				if (method === options.hang) return new Promise(() => undefined);
				return `${method} from ${id}`;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			close: async () => undefined,
		}),
		onEvents: (keys) => events.push(keys),
		onEnded: (reason) => ended.push(reason),
		onRole: (role) => roles.push(role),
		onUser: () => undefined,
		onForeground: (value) => foreground.push(value),
		onOnline: () => undefined,
		onError: (err) => {
			throw err;
		},
	});
	hubs.push(hub);
	hub.start(false);
	return {
		hub,
		id,
		roles,
		events,
		ended,
		foreground,
		invoked,
		emit: (keys) => {
			for (const listener of listeners) listener(keys);
		},
	};
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("tab hub: one tab owns the database", () => {
	it("elects one leader and serves the other tab's calls through it", async () => {
		const locks = new FakeLocks();
		const first = openTab("A", locks);
		await until(() => first.roles.includes("leader"));
		const second = openTab("B", locks);
		expect(await second.hub.call("dialogs", [10])).toBe("dialogs from A");
		expect(first.invoked).toEqual([{ method: "dialogs", args: [10] }]);
		expect(second.roles).toEqual([]);
		expect(await first.hub.call("search", ["x"])).toBe("search from A");
	});

	it("broadcasts change events and the session end to every tab", async () => {
		const locks = new FakeLocks();
		const first = openTab("A", locks);
		await until(() => first.roles.includes("leader"));
		const second = openTab("B", locks);
		await second.hub.call("dialogs", []);
		first.emit(["dialogs", "history:5"]);
		await until(() => second.events.length > 0);
		expect(second.events).toEqual([["dialogs", "history:5"]]);
		expect(first.events).toEqual([["dialogs", "history:5"]]);
		first.hub.broadcastEnded("revoked_by_user");
		await until(() => second.ended.length > 0);
		expect(second.ended).toEqual(["revoked_by_user"]);
	});

	it("hands over when the leader tab closes, re-sending unanswered calls", async () => {
		const locks = new FakeLocks();
		const first = openTab("A", locks, { hang: "sendText" });
		await until(() => first.roles.includes("leader"));
		const second = openTab("B", locks);
		const sending = second.hub.call("sendText", [1, "xin chào", { randomId: 42 }]);
		await until(() => first.invoked.length === 1);
		first.hub.close(); // the tab goes away before answering
		await until(() => second.roles.includes("leader"));
		expect(await sending).toBe("sendText from B");
		// Same idempotency key on both leaders: the core sends it once.
		expect(second.invoked).toEqual([{ method: "sendText", args: [1, "xin chào", { randomId: 42 }] }]);
		expect(await second.hub.call("dialogs", [])).toBe("dialogs from B");
	});

	it("answers a method it does not know instead of leaving the caller waiting", async () => {
		const locks = new FakeLocks();
		const first = openTab("A", locks);
		await until(() => first.roles.includes("leader"));
		const second = openTab("B", locks);
		// A tab of another build calls a method the leader's build lacks.
		const unknown = "methodOfAnotherBuild" as CoreMethod;
		await expect(second.hub.call(unknown, [])).rejects.toThrow("unsupported method");
		expect(first.invoked).toEqual([]);
		expect(await second.hub.call("dialogs", [])).toBe("dialogs from A");
	});

	it("counts the app as foreground while any tab is visible", async () => {
		const locks = new FakeLocks();
		const first = openTab("A", locks);
		await until(() => first.roles.includes("leader"));
		const second = openTab("B", locks);
		await second.hub.call("dialogs", []);
		second.hub.setForeground(true);
		await until(() => first.foreground.at(-1) === true);
		second.hub.setForeground(false);
		await until(() => first.foreground.at(-1) === false);
		first.hub.setForeground(true);
		expect(first.foreground.at(-1)).toBe(true);
	});
});

// MachineLink against a fake machine running the real handshake: requests by
// id, pings while active, reconnecting with the thread cursor, ThreadReset,
// a broken frame, devices the machine does not know (yet) or that were
// revoked, a machine key that changed, and asking the directory for a new
// tunnel.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, HandshakeErrorCode, ItemSchema, Role, ThreadInfoSchema, type Item } from "@achoo254/chat-proto/remote/remote";
import { encodeHandshakeError, generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { DeviceRegistrationRefused } from "../../src/machines/link/device-registration.ts";
import { MachineLink, mergeThreadInfo, RemoteError, UNKNOWN_DEVICE_WAITS_MS, UNSYNCED_RETRY_MS, type LinkDeps, type Timers } from "../../src/machines/link/machine-link.ts";
import { orderedItems } from "../../src/machines/transcript/reducer.ts";
import { defaultAnswer as defaultAnswerOf, FakeMachine, until, type FakeSocket } from "./fake-machine.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const URL_B = "wss://def.tunnel.hoandat.com";

/** Timeouts run at once (no backoff waits); intervals only when tick() says. */
function testTimers() {
	const intervals = new Set<() => void>();
	let now = 1_000_000;
	const timers: Timers & { tick(ms: number): void } = {
		setTimeout: (fn) => setTimeout(fn, 0),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		setInterval: (fn) => {
			intervals.add(fn);
			return fn;
		},
		clearInterval: (handle) => {
			intervals.delete(handle as () => void);
		},
		now: () => now,
		tick(ms) {
			now += ms;
			for (const fn of [...intervals]) fn();
		},
	};
	return timers;
}

const textItem = (id: string, seq: bigint, value: string, clientMsgId = ""): Item =>
	create(ItemSchema, { id, seq, revision: 1, at: seq, body: { case: "text", value: { role: Role.ASSISTANT, text: value, clientMsgId } } });

let machine: FakeMachine;
let device: KeyPair;
let timers: ReturnType<typeof testTimers>;

beforeEach(async () => {
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	timers = testTimers();
});

function link(overrides: Partial<LinkDeps> = {}): MachineLink {
	let n = 0;
	return new MachineLink({
		device: () => Promise.resolve(device),
		expectedKey: () => machine.keys.publicKey,
		tunnelUrl: () => URL_A,
		refreshTunnel: () => Promise.resolve(URL_A),
		socket: machine.factory,
		timers,
		random: () => 0,
		newId: () => `c${++n}`,
		...overrides,
	});
}

describe("MachineLink", () => {
	it("opens with the key the account lists, then asks for the machine info and the threads", async () => {
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		await until(() => l.snapshot().info !== null && l.snapshot().listed, "info and list");
		expect(l.snapshot().info?.name).toBe("Mac mini");
		expect(machine.sent("machineInfoRequest")).toHaveLength(1);
		expect(machine.sent("threadList")).toHaveLength(1);
		l.stop();
	});

	it("drops a thread the machine deleted from every list here", async () => {
		machine.handler = (frame) =>
			frame.body.case === "threadList"
				? [{ case: "threadListResult", value: { threads: [{ id: "t1", title: "a", open: true }, { id: "t2", title: "b" }], openSessions: 1, maxSessions: 3 } }]
				: defaultAnswerOf(frame);
		const l = link();
		l.start();
		await until(() => l.snapshot().threads.length === 2, "two threads");
		machine.send(machine.socket, { case: "threadDeleted", value: { threadId: "t1", trashed: 2 } });
		await until(() => l.snapshot().threads.length === 1, "one left");
		expect(l.snapshot().threads.map((t) => t.id)).toEqual(["t2"]);
		expect(l.snapshot().openSessions).toBe(0);
		l.stop();
	});

	it("keeps the machine's secret prompts apart from every journal, and drops them when closed", async () => {
		const l = link();
		const unwatch = l.watch("t1");
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		const prompt = { requestId: "r1", threadId: "t1", name: "GH_PASSWORD", purpose: "sign in", origin: "https://github.com", expiresAt: 5n };
		machine.send(machine.socket, { case: "secretPrompt", value: prompt });
		await until(() => l.snapshot().secretPrompts.size === 1, "prompt");
		expect(l.snapshot().secretPrompts.get("r1")).toMatchObject({ name: "GH_PASSWORD", origin: "https://github.com" });
		expect(l.journal("t1").items.size).toBe(0);
		machine.send(machine.socket, { case: "secretPromptEnded", value: { requestId: "r1" } });
		await until(() => l.snapshot().secretPrompts.size === 0, "ended");

		// After a reconnect the machine sends what is still open again; nothing stale stays.
		machine.send(machine.socket, { case: "secretPrompt", value: { ...prompt, requestId: "r2" } });
		await until(() => l.snapshot().secretPrompts.size === 1, "second prompt");
		machine.socket.drop();
		await until(() => l.snapshot().status.kind === "open" && machine.sockets.length === 2, "reconnected");
		await until(() => l.snapshot().secretPrompts.size === 0, "cleared on reconnect");
		unwatch();
		l.stop();
	});

	it("keeps each thread's git changes as the machine last sent them, and drops them with the thread", async () => {
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		machine.send(machine.socket, { case: "gitChanges", value: { threadId: "t1", git: true, files: [{ path: "a.txt", added: 1 }] } });
		await until(() => l.snapshot().gitChanges.has("t1"), "git changes");
		expect(l.snapshot().gitChanges.get("t1")?.files.map((f) => f.path)).toEqual(["a.txt"]);
		expect(l.journal("t1").items.size).toBe(0);
		machine.send(machine.socket, { case: "threadDeleted", value: { threadId: "t1", trashed: 0 } });
		await until(() => !l.snapshot().gitChanges.has("t1"), "dropped");
		l.stop();
	});

	it("pings only while the user looks at the machine", async () => {
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		timers.tick(10_000);
		expect(machine.sent("ping")).toHaveLength(0);
		l.setActive(true);
		await until(() => machine.sent("ping").length === 1, "first ping");
		timers.tick(10_000);
		await until(() => machine.sent("ping").length === 2, "second ping");
		l.setActive(false);
		timers.tick(10_000);
		expect(machine.sent("ping")).toHaveLength(2);
		l.stop();
	});

	it("resubscribes a watched thread from its cursor after reconnecting, and reloads after a reset", async () => {
		machine.handler = (frame) => {
			if (frame.body.case !== "threadSubscribe") return undefined;
			const cursor = frame.body.value.cursor;
			if (cursor === undefined || cursor.seq === 0n) {
				return [{ case: "threadItems", value: { threadId: "t1", items: [textItem("a", 1n, "one"), textItem("b", 2n, "two")], cursor: { epoch: 7n, seq: 2n } } }];
			}
			// The agent restarted: another epoch, so the thread resets and the snapshot follows.
			return [
				{ case: "threadReset", value: { threadId: "t1", reason: 1 } },
				{ case: "threadItems", value: { threadId: "t1", items: [textItem("c", 1n, "fresh")], cursor: { epoch: 8n, seq: 1n } } },
			];
		};
		const l = link();
		const unwatch = l.watch("t1");
		l.start();
		await until(() => l.journal("t1").items.size === 2, "first items");
		expect(machine.sent("threadSubscribe")[0]?.cursor).toMatchObject({ epoch: 0n, seq: 0n });

		machine.socket.drop();
		await until(() => machine.sent("threadSubscribe").length === 2, "resubscribe");
		expect(machine.sent("threadSubscribe")[1]?.cursor).toMatchObject({ epoch: 7n, seq: 2n });
		await until(() => l.journal("t1").cursor?.epoch === 8n, "reset applied");
		expect(orderedItems(l.journal("t1")).map((i) => i.id)).toEqual(["c"]);
		unwatch();
		l.stop();
	});

	it("closes a thread's session and keeps following it while it is shown", async () => {
		machine.handler = (frame) => {
			if (frame.body.case !== "threadSubscribe") return defaultAnswerOf(frame);
			return [{ case: "threadItems", value: { threadId: "t1", items: [textItem("a", 1n, "one")], cursor: { epoch: 7n, seq: 1n } } }];
		};
		const l = link();
		const unwatch = l.watch("t1");
		l.start();
		await until(() => l.journal("t1").items.size === 1, "first items");
		// The machine stops following a closed thread for this device: it is followed again, from its cursor.
		await l.closeThread("t1");
		expect(machine.sent("threadClose")).toEqual([expect.objectContaining({ threadId: "t1" })]);
		await until(() => machine.sent("threadSubscribe").length === 2, "followed again");
		expect(machine.sent("threadSubscribe")[1]?.cursor).toMatchObject({ epoch: 7n, seq: 1n });
		// A thread no longer shown is only closed.
		await l.closeThread("t2");
		expect(machine.sent("threadSubscribe").filter((s) => s.threadId === "t2")).toEqual([]);
		unwatch();
		l.stop();
	});

	it("asks the directory at once when the first attempt has no address yet", async () => {
		let refreshed = 0;
		const l = link({
			tunnelUrl: () => "",
			refreshTunnel: () => {
				refreshed++;
				return Promise.resolve(URL_A);
			},
		});
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		expect(refreshed).toBe(1);
		expect(machine.sockets).toHaveLength(1);
		l.stop();
	});

	it("keeps each thread's ThreadInfo apart from its journal, merged on update and kept over a reset", async () => {
		machine.handler = (frame, socket) => {
			if (frame.body.case !== "threadSubscribe") return defaultAnswerOf(frame);
			const threadId = frame.body.value.threadId;
			setTimeout(() => {
				machine.send(socket, {
					case: "threadInfo",
					value: {
						threadId,
						permissionMode: "default",
						gitBranch: "main",
						commands: [{ name: "review", builtin: true }],
						rateLimits: { fiveHour: { utilization: 4, resetsAt: 9n } },
					},
				});
				// A later one without rate limits or commands keeps the known ones.
				machine.send(socket, { case: "threadInfo", value: { threadId, permissionMode: "plan", gitBranch: "dev", linesAdded: 3 } });
				machine.send(socket, { case: "threadReset", value: { threadId, reason: 1 } });
			}, 0);
			return [{ case: "threadItems", value: { threadId, items: [], cursor: frame.body.value.cursor } }];
		};
		const l = link();
		const unwatch = l.watch("t1");
		l.start();
		await until(() => l.snapshot().threadInfo.get("t1")?.permissionMode === "plan", "second info");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const info = l.snapshot().threadInfo.get("t1");
		expect(info).toMatchObject({ gitBranch: "dev", linesAdded: 3, rateLimits: { fiveHour: { utilization: 4 } } });
		expect(info?.commands.map((c) => c.name)).toEqual(["review"]);
		expect(l.snapshot().threadInfo.has("t2")).toBe(false);
		unwatch();
		l.stop();
	});

	it("lets a newer ThreadInfo replace the older one where it knows better", () => {
		const first = create(ThreadInfoSchema, { threadId: "t", permissionMode: "default", commands: [{ name: "a" }], rateLimits: { sevenDay: { utilization: 50 } } });
		const second = create(ThreadInfoSchema, { threadId: "t", permissionMode: "acceptEdits", commands: [{ name: "b" }], rateLimits: { sevenDay: { utilization: 60 } } });
		expect(mergeThreadInfo(undefined, first)).toBe(first);
		expect(mergeThreadInfo(first, second)).toBe(second);
		const bare = create(ThreadInfoSchema, { threadId: "t", permissionMode: "auto" });
		const merged = mergeThreadInfo(second, bare);
		expect(merged.permissionMode).toBe("auto");
		expect(merged.commands.map((c) => c.name)).toEqual(["b"]);
		expect(merged.rateLimits?.sevenDay?.utilization).toBe(60);
	});

	it("forgets the rate limits of the profile a session left", () => {
		const onTeam = create(ThreadInfoSchema, { threadId: "t", accountId: "", rateLimits: { fiveHour: { utilization: 100 } } });
		const sameProfile = create(ThreadInfoSchema, { threadId: "t", accountId: "" });
		expect(mergeThreadInfo(onTeam, sameProfile).rateLimits?.fiveHour?.utilization).toBe(100);
		const moved = create(ThreadInfoSchema, { threadId: "t", accountId: "p2", machineAccountId: "p2" });
		expect(mergeThreadInfo(onTeam, moved).rateLimits).toBeUndefined();
	});

	it("keeps the machine's profile as the machine last announced it, unasked", async () => {
		machine.handler = (frame, socket) => {
			if (frame.body.case === "machineInfoRequest") {
				setTimeout(() => {
					machine.send(socket, {
						case: "machineAccounts",
						value: { accounts: { accounts: [{ provider: "claude", id: "", email: "team@example.com" }] }, sessions: [{ threadId: "t1", accountId: "", provider: "claude" }] },
					});
					machine.send(socket, {
						case: "machineAccounts",
						value: {
							accounts: {
								selectedByProvider: { claude: "p2" },
								accounts: [
									{ provider: "claude", id: "", email: "team@example.com" },
									{ provider: "claude", id: "p2", email: "max@example.com" },
								],
							},
							sessions: [{ threadId: "t1", accountId: "", switchPending: true, provider: "claude" }],
						},
					});
				}, 0);
			}
			return defaultAnswerOf(frame);
		};
		const l = link();
		expect(l.snapshot().machineAccounts).toBeNull();
		l.start();
		await until(() => l.snapshot().machineAccounts?.accounts?.selectedByProvider.claude === "p2", "announced accounts");
		expect(l.snapshot().machineAccounts?.sessions).toMatchObject([{ threadId: "t1", accountId: "", switchPending: true }]);
		l.stop();
	});

	it("matches answers to requests and rejects machine errors", async () => {
		machine.handler = (frame) => {
			if (frame.body.case === "threadSend") return [{ case: "error", value: { code: ErrorCode.NOT_FOUND, message: "no such thread" } }];
			if (frame.body.case === "dirList") return [{ case: "dirListResult", value: { path: "/home/u", entries: [{ name: "code", git: true }] } }];
			return undefined;
		};
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		const listed = await l.request({ case: "dirList", value: { path: "" } });
		expect(listed.body.case === "dirListResult" && listed.body.value.entries[0]?.name).toBe("code");
		await expect(l.send("t1", "hi")).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
		await expect(l.send("t1", "hi")).rejects.toBeInstanceOf(RemoteError);
		// A refused message does not stay on screen.
		expect(l.snapshot().pending.get("t1")).toBeUndefined();
		l.stop();
	});

	it("shows a sent message until the machine echoes its client id", async () => {
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		await l.send("t1", "hello");
		expect(l.snapshot().pending.get("t1")).toEqual([{ clientMsgId: "c1", text: "hello" }]);
		machine.send(machine.socket, { case: "threadItems", value: { threadId: "t1", items: [textItem("u", 1n, "hello", "c1")], cursor: { epoch: 1n, seq: 1n } } });
		await until(() => l.snapshot().pending.get("t1") === undefined, "echo");
		l.stop();
	});

	it("answers /clear with the new thread and does not keep the command on screen", async () => {
		machine.handler = (frame) =>
			frame.body.case === "threadSend" ? [{ case: "threadCreated", value: { thread: { id: "t2", dir: "/work", provider: "claude" } } }] : undefined;
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		const opened = await l.send("t1", "/clear");
		expect(opened?.id).toBe("t2");
		expect(l.snapshot().pending.get("t1")).toBeUndefined();
		l.stop();
	});

	it("reconnects when a frame cannot be opened", async () => {
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open");
		machine.socket.deliver(new Uint8Array(40));
		await until(() => machine.sockets.length === 2 && l.snapshot().status.kind === "open", "reconnected");
		expect(machine.sockets[0]?.closed).toBe(true);
		l.stop();
	});

	it("asks the directory for a new tunnel after repeated failures", async () => {
		machine.unreachable.add(URL_A);
		let current = URL_A;
		let refreshed = 0;
		const l = link({
			tunnelUrl: () => current,
			refreshTunnel: () => {
				refreshed += 1;
				current = URL_B;
				return Promise.resolve(current);
			},
		});
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open on the new tunnel");
		expect(refreshed).toBe(1);
		expect(machine.sockets.map((s) => s.url)).toEqual([URL_A, URL_A, URL_A, URL_B]);
		l.stop();
	});

	it("waits for a machine that does not know this device yet, a little longer each time, then says it refused", async () => {
		machine.trusted = [];
		const waits: number[] = [];
		const l = link({ timers: { ...timers, setTimeout: (fn, ms) => (waits.push(ms), setTimeout(fn, 0)) } });
		l.start();
		await until(() => l.snapshot().status.kind === "failed", "refused");
		expect(l.snapshot().status).toEqual({ kind: "failed", reason: "refused" });
		expect(waits).toEqual(UNKNOWN_DEVICE_WAITS_MS);
		expect(UNKNOWN_DEVICE_WAITS_MS.reduce((a, b) => a + b, 0)).toBe(15_000);
		expect(machine.sockets).toHaveLength(UNKNOWN_DEVICE_WAITS_MS.length + 1);
	});

	it("opens once the machine learns about this device while the link waits", async () => {
		machine.trusted = [];
		const l = link({
			timers: {
				...timers,
				setTimeout: (fn) =>
					setTimeout(() => {
						// The machine's next heartbeat brought the account's new device.
						machine.trusted = [device.publicKey];
						fn();
					}, 0),
			},
		});
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open after the sync");
		expect(machine.sockets).toHaveLength(2);
		l.stop();
	});

	it("stops for good, without retrying, when the account revoked this device", async () => {
		machine.trusted = [];
		machine.revoked = [device.publicKey];
		const l = link();
		l.start();
		await until(() => l.snapshot().status.kind === "failed", "revoked");
		expect(l.snapshot().status).toEqual({ kind: "failed", reason: "revoked" });
		await new Promise((r) => setTimeout(r, 20));
		expect(machine.sockets).toHaveLength(1);
	});

	it("refuses a machine answering with another key than the account lists", async () => {
		const impostor = await FakeMachine.create();
		impostor.trusted = [device.publicKey];
		const changed = link({ socket: impostor.factory });
		changed.start();
		await until(() => changed.snapshot().status.kind === "failed", "key changed");
		expect(changed.snapshot().status).toEqual({ kind: "failed", reason: "key-changed" });
	});

	it("remembers the key of a link that opened, and refuses a listed key that differs from it without a socket", async () => {
		const remembered: Uint8Array[] = [];
		const first = link({ seenKey: () => Promise.resolve(null), rememberKey: (key) => (remembered.push(key), Promise.resolve()) });
		first.start();
		await until(() => remembered.length === 1, "the key remembered");
		expect(remembered[0]).toEqual(machine.keys.publicKey);
		first.stop();

		const sockets = machine.sockets.length;
		const other = await generateKeyPair();
		const changed = link({ seenKey: () => Promise.resolve(machine.keys.publicKey), expectedKey: () => other.publicKey });
		changed.start();
		await until(() => changed.snapshot().status.kind === "failed", "key changed");
		expect(changed.snapshot().status).toEqual({ kind: "failed", reason: "key-changed" });
		expect(machine.sockets).toHaveLength(sockets);
	});

	it("waits for the directory while it lists no key for the machine", async () => {
		let refreshed = 0;
		const l = link({
			expectedKey: () => (refreshed >= 2 ? machine.keys.publicKey : null),
			refreshTunnel: () => {
				refreshed += 1;
				return Promise.resolve(URL_A);
			},
		});
		l.start();
		await until(() => l.snapshot().status.kind === "open", "open once the key is listed");
		expect(refreshed).toBeGreaterThanOrEqual(2);
		l.stop();
	});

	it("says the machine cannot reach the chat when it answers BUSY, and asks again only after a long wait", async () => {
		const waits: number[] = [];
		let answers = 0;
		const l = link({
			timers: { ...timers, setTimeout: (fn, ms) => (waits.push(ms), ms === UNSYNCED_RETRY_MS ? 0 : setTimeout(fn, 0)) },
			socket: (url) => {
				answers += 1;
				// The machine's trusted list is stale: it answers every Hello with BUSY.
				const socket = machine.factory(url) as FakeSocket;
				socket.send = () => socket.deliver(encodeHandshakeError(HandshakeErrorCode.BUSY));
				return socket;
			},
		});
		l.start();
		await until(() => l.snapshot().status.kind === "failed", "unsynced");
		expect(l.snapshot().status).toEqual({ kind: "failed", reason: "machine-unsynced" });
		expect(waits).toEqual([UNSYNCED_RETRY_MS]);
		expect(answers).toBe(1);
		l.stop();
	});

	it("says the session must sign in again when the account takes no device from it", async () => {
		const l = link({ device: () => Promise.reject(new DeviceRegistrationRefused("session-revoked")) });
		l.start();
		await until(() => l.snapshot().status.kind === "failed", "session revoked");
		expect(l.snapshot().status).toEqual({ kind: "failed", reason: "session-revoked" });
		expect(machine.sockets).toHaveLength(0);
	});

	it("never opens an address outside the tunnel domain", async () => {
		let refreshed = 0;
		const l = link({
			tunnelUrl: () => "wss://evil.example.com",
			refreshTunnel: () => {
				refreshed += 1;
				return Promise.resolve("wss://evil.example.com");
			},
		});
		l.start();
		await until(() => refreshed > 0, "a refresh");
		expect(machine.sockets).toHaveLength(0);
		l.stop();
	});
});

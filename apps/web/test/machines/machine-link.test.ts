// MachineLink against a fake machine running the real handshake: requests by
// id, pings while active, reconnecting with the thread cursor, ThreadReset,
// a broken frame, refused devices, and asking the directory for a new tunnel.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ItemSchema, Role, ThreadInfoSchema, type Item } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { MachineLink, mergeThreadInfo, RemoteError, type LinkDeps, type Timers } from "../../src/machines/link/machine-link.ts";
import { orderedItems } from "../../src/machines/transcript/reducer.ts";
import { defaultAnswer as defaultAnswerOf, FakeMachine, until } from "./fake-machine.ts";

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
	machine.paired = [device.publicKey];
	timers = testTimers();
});

function link(overrides: Partial<LinkDeps> = {}): MachineLink {
	let n = 0;
	return new MachineLink({
		device: () => Promise.resolve(device),
		deviceName: "test",
		pinned: () => Promise.resolve(machine.keys.publicKey),
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
	it("opens with the pinned key, then asks for the machine info and the threads", async () => {
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
		const onTeam = create(ThreadInfoSchema, { threadId: "t", profileId: "", rateLimits: { fiveHour: { utilization: 100 } } });
		const sameProfile = create(ThreadInfoSchema, { threadId: "t", profileId: "" });
		expect(mergeThreadInfo(onTeam, sameProfile).rateLimits?.fiveHour?.utilization).toBe(100);
		const moved = create(ThreadInfoSchema, { threadId: "t", profileId: "p2", machineProfileId: "p2" });
		expect(mergeThreadInfo(onTeam, moved).rateLimits).toBeUndefined();
	});

	it("keeps the machine's profile as the machine last announced it, unasked", async () => {
		machine.handler = (frame, socket) => {
			if (frame.body.case === "machineInfoRequest") {
				setTimeout(() => {
					machine.send(socket, {
						case: "machineProfile",
						value: { profiles: { selectedId: "", profiles: [{ id: "", email: "team@example.com" }] }, sessions: [{ threadId: "t1", profileId: "" }] },
					});
					machine.send(socket, {
						case: "machineProfile",
						value: {
							profiles: { selectedId: "p2", profiles: [{ id: "", email: "team@example.com" }, { id: "p2", email: "max@example.com" }] },
							sessions: [{ threadId: "t1", profileId: "", switchPending: true }],
						},
					});
				}, 0);
			}
			return defaultAnswerOf(frame);
		};
		const l = link();
		expect(l.snapshot().machineProfile).toBeNull();
		l.start();
		await until(() => l.snapshot().machineProfile?.profiles?.selectedId === "p2", "announced profile");
		expect(l.snapshot().machineProfile?.sessions).toMatchObject([{ threadId: "t1", profileId: "", switchPending: true }]);
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

	it("stops for good when the device is not paired or not accepted", async () => {
		const unpaired = link({ pinned: () => Promise.resolve(null) });
		unpaired.start();
		await until(() => unpaired.snapshot().status.kind === "failed", "unpaired");
		expect(unpaired.snapshot().status).toEqual({ kind: "failed", reason: "unpaired" });
		expect(machine.sockets).toHaveLength(0);

		machine.paired = [];
		const refused = link();
		refused.start();
		await until(() => refused.snapshot().status.kind === "failed", "refused");
		expect(refused.snapshot().status).toEqual({ kind: "failed", reason: "refused" });

		const impostor = await FakeMachine.create();
		impostor.paired = [device.publicKey];
		const changed = link({ socket: impostor.factory });
		changed.start();
		await until(() => changed.snapshot().status.kind === "failed", "key changed");
		expect(changed.snapshot().status).toEqual({ kind: "failed", reason: "key-changed" });
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

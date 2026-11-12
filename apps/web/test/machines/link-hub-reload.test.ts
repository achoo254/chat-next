// "Refresh the machine's status": the hub asks the directory again and
// restarts the machine's link, so a stale state is read anew; a link stopped
// because the machine's key changed takes the key the account lists now only
// through this explicit refresh.
import { create } from "@bufbuild/protobuf";
import { KeyChallengeSchema } from "@achoo254/chat-proto/machines";
import { generateKeyPair, random, type KeyPair } from "@achoo254/chat-remote-protocol";
import { describe, expect, it } from "vitest";
import type { DeviceKeyStore } from "../../src/machines/link/device-keys.ts";
import { LinkHub } from "../../src/machines/link/link-hub.ts";
import type { MachineEntry, MachinesDirectory } from "../../src/machines/machines-client.ts";
import type { SocketFactory } from "../../src/machines/link/socket.ts";
import { until } from "./fake-machine.ts";

const listedKey = new Uint8Array(32).fill(5);

const entry: MachineEntry = {
	ref: "5",
	id: 5,
	name: "Server",
	os: "linux",
	arch: "x64",
	agentVersion: "3.0.0",
	claudeVersion: "",
	tunnelUrl: "wss://m-5.tunnel.hoandat.com",
	createdAt: 0,
	lastSeenAt: 0,
	publicKey: listedKey,
};

async function makeHub(seen: Uint8Array | null) {
	let listed = 0;
	let seenReads = 0;
	let seenKey = seen;
	const device: KeyPair = await generateKeyPair();
	const server = await generateKeyPair();
	const keys: DeviceKeyStore = {
		device: () => Promise.resolve(device),
		renew: () => Promise.resolve(device),
		seenMachineKey: () => {
			seenReads += 1;
			return Promise.resolve(seenKey);
		},
		rememberMachineKey: (_ref, key) => {
			seenKey = key;
			return Promise.resolve();
		},
		forgetMachineKey: () => {
			seenKey = null;
			return Promise.resolve();
		},
	};
	const sockets: string[] = [];
	const socket: SocketFactory = (url) => {
		sockets.push(url);
		throw new Error("no socket in this test");
	};
	const directory: Pick<MachinesDirectory, "list" | "keyChallenge" | "registerDevice"> = {
		list: () => {
			listed += 1;
			return Promise.resolve([entry]);
		},
		keyChallenge: () => Promise.resolve(create(KeyChallengeSchema, { serverKey: server.publicKey, nonce: random(32), expiresAt: 0n })),
		registerDevice: (r) => Promise.resolve({ publicKey: r.publicKey, name: r.name, platform: r.platform, createdAt: 0, lastSeenAt: 0, revokedAt: 0, current: true }),
	};
	const hub = new LinkHub({
		directory: directory as MachinesDirectory,
		keys,
		identity: { name: "Test", platform: "web" },
		socket,
		localName: "Local",
	});
	return { hub, listed: () => listed, seenReads: () => seenReads, seenKey: () => seenKey, sockets };
}

describe("LinkHub.reload", () => {
	it("asks the directory again and reads the machine's key again through a restarted link", async () => {
		const { hub, listed, seenReads } = await makeHub(null);
		await hub.refresh();
		const link = hub.link("5");
		link.start();
		await until(() => seenReads() > 0, "first read");
		const readsBefore = seenReads();
		expect(listed()).toBe(1);

		await hub.reload("5");
		await until(() => seenReads() > readsBefore, "second read");
		expect(listed()).toBe(2);
		link.stop();
	});

	it("does not make a link for a machine nobody opened", async () => {
		const { hub, listed } = await makeHub(null);
		await hub.reload("5");
		expect(listed()).toBe(1);
	});

	it("a machine whose listed key differs from the one seen before stays stopped until the user refreshes it", async () => {
		const { hub, seenKey, sockets } = await makeHub(new Uint8Array(32).fill(9));
		await hub.refresh();
		const link = hub.link("5");
		link.start();
		await until(() => link.snapshot().status.kind === "failed", "the key check");
		expect(link.snapshot().status).toEqual({ kind: "failed", reason: "key-changed" });
		expect(sockets).toEqual([]);

		// Refreshing is the user's consent: the seen key is dropped and the link tries the listed one.
		await hub.reload("5");
		expect(seenKey()).toBeNull();
		await until(() => sockets.length > 0, "a socket to the machine");
		link.stop();
	});
});

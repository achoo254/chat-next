// "Refresh the machine's status": the hub asks the directory again and
// restarts the machine's link, so a stale state is read anew.
import { describe, expect, it } from "vitest";
import type { DeviceKeyStore } from "../../src/machines/link/device-keys.ts";
import { LinkHub } from "../../src/machines/link/link-hub.ts";
import type { MachineEntry } from "../../src/machines/machines-client.ts";
import type { SocketFactory } from "../../src/machines/link/socket.ts";

const entry: MachineEntry = {
	ref: "5",
	id: 5,
	name: "Server",
	os: "linux",
	arch: "x64",
	agentVersion: "2.3.0",
	claudeVersion: "",
	tunnelUrl: "wss://m-5.tunnel.example/",
	createdAt: 0,
	lastSeenAt: 0,
	claimed: true,
};

function makeHub() {
	let listed = 0;
	let pinnedReads = 0;
	const keys: DeviceKeyStore = {
		device: () => Promise.reject(new Error("no device key needed")),
		pinned: () => {
			pinnedReads += 1;
			return Promise.resolve(null);
		},
		pin: () => Promise.resolve(),
		forget: () => Promise.resolve(),
	};
	const socket: SocketFactory = () => {
		throw new Error("no socket in this test");
	};
	const hub = new LinkHub({
		directory: {
			list: () => {
				listed += 1;
				return Promise.resolve([entry]);
			},
		} as unknown as LinkHub["deps"]["directory"],
		keys,
		deviceName: "Test",
		socket,
		localName: "Local",
	});
	return { hub, listed: () => listed, pinnedReads: () => pinnedReads };
}

describe("LinkHub.reload", () => {
	it("asks the directory again and reads the pinned key again through a restarted link", async () => {
		const { hub, listed, pinnedReads } = makeHub();
		await hub.refresh();
		const link = hub.link("5");
		link.start();
		await new Promise((r) => setTimeout(r, 0));
		const readsBefore = pinnedReads();
		expect(listed()).toBe(1);

		await hub.reload("5");
		await new Promise((r) => setTimeout(r, 0));

		expect(listed()).toBe(2);
		expect(pinnedReads()).toBeGreaterThan(readsBefore);
	});

	it("does not make a link for a machine nobody opened", async () => {
		const { hub, listed } = makeHub();
		await hub.reload("5");
		expect(listed()).toBe(1);
	});
});

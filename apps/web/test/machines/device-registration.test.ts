// Registering this device's key with the account: once per page, with a
// proof the server can check (the fake service checks it as the server does),
// a new key when the account refused the old one, and a clear refusal when
// only signing in again helps. Also how a device names itself.
import { createRouterTransport } from "@connectrpc/connect";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceKeyStore } from "../../src/machines/link/device-keys.ts";
import { browserName, deviceIdentity, DeviceRegistrationRefused, registeredDevice } from "../../src/machines/link/device-registration.ts";
import { createMachinesDirectory, type MachinesDirectory } from "../../src/machines/machines-client.ts";
import { FakeMachines } from "../support/fake-machines.ts";

const identity = { name: "Chrome · macOS", platform: "web" };

let service: FakeMachines;
let directory: MachinesDirectory;
let keys: DeviceKeyStore & { renewed: number };

function keyStore(first: KeyPair): DeviceKeyStore & { renewed: number } {
	let current = first;
	const store = {
		renewed: 0,
		device: () => Promise.resolve(current),
		renew: async () => {
			store.renewed += 1;
			current = await generateKeyPair();
			return current;
		},
		seenMachineKey: () => Promise.resolve(null),
		rememberMachineKey: () => Promise.resolve(),
		forgetMachineKey: () => Promise.resolve(),
	};
	return store;
}

beforeEach(async () => {
	service = new FakeMachines();
	directory = createMachinesDirectory(
		createRouterTransport((router) => service.routes(router)),
		() => undefined,
	);
	keys = keyStore(await generateKeyPair());
});

describe("registering this device with the account", () => {
	it("registers the key once with a proof the server accepts, and shares that for the page", async () => {
		const challenge = vi.spyOn(directory, "keyChallenge");
		const device = registeredDevice(keys, directory, identity);
		const [a, b] = await Promise.all([device(), device()]);
		expect(a).toBe(b);
		expect(await device()).toBe(a);
		expect(challenge).toHaveBeenCalledTimes(1);
		expect(service.registrations).toEqual([a.publicKey]);
		const listed = await directory.devices();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ name: "Chrome · macOS", platform: "web", current: true, revokedAt: 0 });
	});

	it("a proof made with another key is refused by the server", async () => {
		const other = await generateKeyPair();
		const challenge = await directory.keyChallenge();
		const { proveKeyPossession } = await import("@achoo254/chat-remote-protocol");
		const mac = await proveKeyPossession(other.privateKey, { serverKey: challenge.serverKey, nonce: challenge.nonce });
		const mine = await keys.device();
		await expect(directory.registerDevice({ publicKey: mine.publicKey, ...identity, challenge, mac })).rejects.toThrow(/bad_key_proof/);
	});

	it("makes a new key and registers it once when the account revoked the old one", async () => {
		const old = await keys.device();
		service.refuse.push("device_revoked");
		const device = await registeredDevice(keys, directory, identity)();
		expect(keys.renewed).toBe(1);
		expect(device.publicKey).not.toEqual(old.publicKey);
		expect(service.registrations).toEqual([device.publicKey]);
	});

	it("also renews a key another session holds", async () => {
		service.refuse.push("device_key_in_use");
		await registeredDevice(keys, directory, identity)();
		expect(keys.renewed).toBe(1);
	});

	it("tells the user to sign in again when the session lost a device, before or after renewing", async () => {
		service.refuse.push("session_devices_revoked");
		await expect(registeredDevice(keys, directory, identity)()).rejects.toEqual(new DeviceRegistrationRefused("session-revoked"));
		expect(keys.renewed).toBe(0);

		service.refuse.push("device_revoked", "session_devices_revoked");
		const err = await registeredDevice(keys, directory, identity)().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DeviceRegistrationRefused);
		expect((err as DeviceRegistrationRefused).reason).toBe("session-revoked");
		expect(keys.renewed).toBe(1);
	});

	it("says when the account holds too many devices", async () => {
		service.refuse.push("too_many_devices");
		const err = await registeredDevice(keys, directory, identity)().catch((e: unknown) => e);
		expect((err as DeviceRegistrationRefused).reason).toBe("too-many-devices");
	});

	it("keeps no failure: the next call tries again", async () => {
		const challenge = vi.spyOn(directory, "keyChallenge").mockRejectedValueOnce(new Error("offline"));
		const device = registeredDevice(keys, directory, identity);
		await expect(device()).rejects.toThrow("offline");
		await expect(device()).resolves.toBe(await keys.device());
		expect(challenge).toHaveBeenCalledTimes(2);
	});
});

describe("how a device names itself", () => {
	it("a browser by its name and system, installed as a web app or not", () => {
		const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
		const edgeWin = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
		expect(browserName(chromeMac)).toBe("Chrome · macOS");
		expect(browserName(edgeWin)).toBe("Edge · Windows");
		expect(browserName("curl/8")).toBe("Browser");
		expect(deviceIdentity({ userAgent: chromeMac, native: false, standalone: false, appName: "Chat" })).toEqual({ name: "Chrome · macOS", platform: "web" });
		expect(deviceIdentity({ userAgent: chromeMac, native: false, standalone: true, appName: "Chat" })).toEqual({ name: "Chrome · macOS", platform: "pwa" });
	});

	it("the native app as the app on iOS or Android", () => {
		const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
		const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
		expect(deviceIdentity({ userAgent: iphone, native: true, standalone: false, appName: "Chat" })).toEqual({ name: "App Chat · iOS", platform: "ios" });
		expect(deviceIdentity({ userAgent: android, native: true, standalone: false, appName: "Chat" })).toEqual({ name: "App Chat · Android", platform: "android" });
	});
});

// Pairing this device (6-digit code through CPace, the install secret), the
// tunnel address check, the install command and the "My machines" routes.
import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import {
	PairingWindow,
	PakeFailure,
	acceptHello,
	decodePlain,
	encodeHandshakeError,
	encodePlain,
	generateKeyPair,
	pakeReply,
	random,
	type KeyPair,
} from "@achoo254/chat-remote-protocol";
import { describe, expect, it } from "vitest";
import { installCommand, migrateCommand } from "../../src/machines/add-machine.tsx";
import { confirmTrust, pairWithCode } from "../../src/machines/link/pairing.ts";
import { allowedTunnel, type SocketLike } from "../../src/machines/link/socket.ts";
import { matchRoute, paths, returnPathFor } from "../../src/router.tsx";

const URL = "wss://abc.tunnel.hoandat.com";

/** A machine with `tunelo pair` open, answering one connection the way the agent does. */
function pairingMachine(machine: KeyPair, window: PairingWindow, install?: { deviceKey: Uint8Array; secret: Uint8Array<ArrayBuffer> }) {
	const paired: Uint8Array[] = [];
	const factory = (): SocketLike => {
		let pake: Extract<Awaited<ReturnType<typeof pakeReply>>, { ok: true }> | null = null;
		const socket: SocketLike = {
			binaryType: "blob",
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			send(data) {
				void (async () => {
					const reply = (bytes: Uint8Array) => socket.onmessage?.({ data: bytes.slice().buffer });
					const close = () => setTimeout(() => socket.onclose?.({ code: 1000, reason: "" }), 0);
					const plain = decodePlain(data);
					if (plain.body.case === "pakeStart") {
						const r = await pakeReply({ window, machineKey: machine.publicKey, start: plain.body.value });
						if (!r.ok) {
							reply(encodeHandshakeError(r.code));
							return close();
						}
						pake = r;
						reply(encodePlain({ case: "pakeReply", value: r.reply }));
						return;
					}
					if (plain.body.case === "pakeFinish" && pake !== null) {
						const done = await pake.confirm(plain.body.value);
						if (done !== null) paired.push(done.deviceKey);
						return close();
					}
					const accepted = await acceptHello(data, { machine, deviceStatus: () => "unknown", install });
					reply(accepted.reply);
				})();
			},
			close() {},
		};
		setTimeout(() => socket.onopen?.(), 0);
		return socket;
	};
	return { factory, paired };
}

describe("pairing", () => {
	it("pairs with the 6-digit code and returns the machine key to pin", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const window = PairingWindow.open();
		const m = pairingMachine(machine, window);
		const key = await pairWithCode({ url: URL, device, deviceName: "phone", socket: m.factory }, window.code);
		expect(key).toEqual(machine.publicKey);
		expect(m.paired).toEqual([device.publicKey]);
	});

	it("fails on a wrong code and reports an expired window", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const window = PairingWindow.open();
		const m = pairingMachine(machine, window);
		const wrong = window.code === "000000" ? "000001" : "000000";
		await expect(pairWithCode({ url: URL, device, deviceName: "x", socket: m.factory }, wrong)).rejects.toBeInstanceOf(PakeFailure);
		const expired = pairingMachine(machine, PairingWindow.open(0));
		await expect(pairWithCode({ url: URL, device, deviceName: "x", socket: expired.factory }, "123456")).rejects.toMatchObject({
			code: HandshakeErrorCode.PAIRING_EXPIRED,
		});
	});

	it("pins the installed machine only when it proves the install secret", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const secret = random(32);
		const good = pairingMachine(machine, PairingWindow.open(), { deviceKey: device.publicKey, secret });
		const key = await confirmTrust({ url: URL, device, deviceName: "laptop", socket: good.factory }, { kind: "install", secret });
		expect(key).toEqual(machine.publicKey);
		const bad = pairingMachine(machine, PairingWindow.open(), { deviceKey: device.publicKey, secret: random(32) });
		await expect(confirmTrust({ url: URL, device, deviceName: "laptop", socket: bad.factory }, { kind: "install", secret })).rejects.toMatchObject({
			code: HandshakeErrorCode.BAD_PROOF,
		});
	});

	it("never connects outside the tunnel domain", async () => {
		const device = await generateKeyPair();
		const opened: string[] = [];
		const factory = (url: string): SocketLike => {
			opened.push(url);
			throw new Error("must not open");
		};
		await expect(pairWithCode({ url: "wss://abc.tunnel.evil.com", device, deviceName: "x", socket: factory }, "123456")).rejects.toThrow();
		expect(opened).toEqual([]);
	});
});

describe("tunnel addresses", () => {
	it("accepts only <name>.tunnel.<brand domain>, and 127.0.0.1 in development", () => {
		expect(allowedTunnel("wss://abc-1.tunnel.hoandat.com", false)).toBe(true);
		expect(allowedTunnel("wss://abc.tunnel.hoandat.com/", false)).toBe(true);
		expect(allowedTunnel("ws://abc.tunnel.hoandat.com", false)).toBe(false);
		expect(allowedTunnel("wss://a.b.tunnel.hoandat.com", false)).toBe(false);
		expect(allowedTunnel("wss://abc.tunnel.hoandat.com.evil.com", false)).toBe(false);
		expect(allowedTunnel("wss://abc.tunnel.hoandat.com/path", false)).toBe(false);
		expect(allowedTunnel("ws://127.0.0.1:47821", false)).toBe(false);
		expect(allowedTunnel("ws://127.0.0.1:47821", true)).toBe(true);
		expect(allowedTunnel("ws://127.0.0.1:99999", true)).toBe(false);
		expect(allowedTunnel("ws://localhost:47821", true)).toBe(false);
	});
});

describe("install command", () => {
	it("passes the device key and language, never the pairing secret or an install code", () => {
		const key = "A".repeat(43);
		// No install code: tunelo joins My machines with the account it signs in with.
		expect(installCommand("mac", "https://chat.example.test", key, "vi")).toBe(`curl -fsSL https://chat.example.test/agent/install.sh | sh -s -- ${key} vi`);
		expect(installCommand("windows", "https://chat.example.test", key, "en")).toBe(
			`& ([scriptblock]::Create((irm https://chat.example.test/agent/install.ps1))) ${key} en`,
		);
	});

	it("moves a computer still on hda with the same scripts and no install code", () => {
		expect(migrateCommand("mac", "https://chat.example.test", "zh-CN")).toBe("curl -fsSL https://chat.example.test/agent/install.sh | sh -s -- zh-CN");
		expect(migrateCommand("windows", "https://chat.example.test", "vi")).toBe("& ([scriptblock]::Create((irm https://chat.example.test/agent/install.ps1))) vi");
	});
});

describe("routes", () => {
	it("maps the machines pages", () => {
		expect(matchRoute("/machines")).toEqual({ name: "machines", view: { page: "list" } });
		expect(matchRoute("/machines/add")).toEqual({ name: "machines", view: { page: "add" } });
		expect(matchRoute("/machines/42")).toEqual({ name: "machines", view: { page: "machine", machine: "42" } });
		expect(matchRoute("/machines/42/info")).toEqual({ name: "machines", view: { page: "info", machine: "42" } });
		expect(matchRoute("/machines/42/pair")).toEqual({ name: "machines", view: { page: "pair", machine: "42" } });
		const thread = "1f0c2a9e-0d4b-4a59-9c1e-5b7b2f6c8d10";
		expect(matchRoute(paths.machineSession("42", thread))).toEqual({ name: "machines", view: { page: "session", machine: "42", threadId: thread } });
		expect(matchRoute("/machines/0")).toBeNull();
		expect(matchRoute("/machines/42/s/bad%20id")).toBeNull();
		expect(matchRoute("/machines/42/other")).toBeNull();
		// The development machine exists in development builds (the test run is one).
		expect(matchRoute("/machines/local")).toEqual({ name: "machines", view: { page: "machine", machine: "local" } });
		expect(matchRoute(paths.machinesLocal())).toEqual({ name: "machines", view: { page: "local" } });
	});

	it("comes back to a machine push's session after sign-in", () => {
		expect(returnPathFor("/machines/42", "?session=t_1")).toBe("/machines/42?session=t_1");
	});
});

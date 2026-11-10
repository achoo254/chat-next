// Pairing this device (the 6-digit Authenticator code through CPace, the
// install secret), how the pairing page explains each failure, the tunnel
// address check, the install command and the "My machines" routes.
import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import {
	HandshakeFailure,
	PAIRING_MAX_ATTEMPTS,
	PakeFailure,
	TotpPairing,
	acceptHello,
	decodePlain,
	encodeHandshakeError,
	encodePlain,
	generateKeyPair,
	generateTotpSecret,
	pakeReply,
	random,
	totpCandidates,
	totpCode,
	type KeyPair,
} from "@achoo254/chat-remote-protocol";
import { describe, expect, it } from "vitest";
import { installCommand } from "../../src/machines/add-machine.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { confirmTrust, pairWithCode } from "../../src/machines/link/pairing.ts";
import { allowedTunnel, type SocketLike } from "../../src/machines/link/socket.ts";
import { pairProblem, pairProblemText } from "../../src/machines/pair-device.tsx";
import { matchRoute, paths, returnPathFor } from "../../src/router.tsx";

const URL = "wss://abc.tunnel.hoandat.com";

/** A machine answering one connection the way the agent does: PakeStart with its Authenticator secret, Hello otherwise. */
function pairingMachine(machine: KeyPair, pairing: TotpPairing, install?: { deviceKey: Uint8Array; secret: Uint8Array<ArrayBuffer> }) {
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
						const r = await pakeReply({ pairing, machineKey: machine.publicKey, start: plain.body.value });
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

/** A 6-digit code the machine accepts at no step around now. */
function wrongCode(secret: Uint8Array): string {
	const near = totpCandidates(secret);
	for (let n = 0; ; n++) {
		const code = String(n).padStart(6, "0");
		if (!near.includes(code)) return code;
	}
}

describe("pairing with the Authenticator code", () => {
	it("pairs with the current code and returns the machine key to pin", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const secret = generateTotpSecret();
		const m = pairingMachine(machine, new TotpPairing(secret));
		const key = await pairWithCode({ url: URL, device, deviceName: "phone", socket: m.factory }, totpCode(secret));
		expect(key).toEqual(machine.publicKey);
		expect(m.paired).toEqual([device.publicKey]);
	});

	it("refuses a wrong code without pairing, and the page says the code changes every 30 seconds", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const secret = generateTotpSecret();
		const m = pairingMachine(machine, new TotpPairing(secret));
		const err = await pairWithCode({ url: URL, device, deviceName: "x", socket: m.factory }, wrongCode(secret)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PakeFailure);
		expect(m.paired).toEqual([]);
		expect(pairProblem(err)).toBe("wrong");
		expect(pairProblemText(viMachines, "wrong", "Mac mini")).toMatch(/30 giây/);
	});

	it("after 5 wrong codes the machine locks: even the right code is refused, and the page says for 15 minutes", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const secret = generateTotpSecret();
		const m = pairingMachine(machine, new TotpPairing(secret));
		const target = { url: URL, device, deviceName: "x", socket: m.factory };
		for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) await expect(pairWithCode(target, wrongCode(secret))).rejects.toBeInstanceOf(PakeFailure);
		const err = await pairWithCode(target, totpCode(secret)).catch((e: unknown) => e);
		expect(err).toMatchObject({ code: HandshakeErrorCode.TOO_MANY_ATTEMPTS });
		expect(m.paired).toEqual([]);
		expect(pairProblem(err)).toBe("tooMany");
		expect(pairProblemText(viMachines, "tooMany", "Mac mini")).toBe("Sai quá nhiều lần nên Mac mini đang khoá ghép thiết bị trong 15 phút. Chờ hết thời gian đó rồi nhập mã mới.");
	});

	it("a machine without Authenticator pairing says so, and the page tells how to turn it on", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const m = pairingMachine(machine, new TotpPairing());
		const err = await pairWithCode({ url: URL, device, deviceName: "x", socket: m.factory }, "123456").catch((e: unknown) => e);
		expect(err).toMatchObject({ code: HandshakeErrorCode.TOTP_NOT_SET });
		expect(pairProblem(err)).toBe("notSet");
		expect(pairProblemText(viMachines, "notSet", "Mac mini")).toMatch(/^Mac mini chưa bật ghép bằng Authenticator\. Trên một thiết bị đã ghép/);
	});

	it("tells an old machine and an unreachable one apart", () => {
		expect(pairProblem(new HandshakeFailure(HandshakeErrorCode.VERSION_UNSUPPORTED))).toBe("version");
		expect(pairProblem(new HandshakeFailure(HandshakeErrorCode.MALFORMED))).toBe("generic");
		expect(pairProblem(new Error("socket closed"))).toBe("unreachable");
	});

	it("pins the installed machine only when it proves the install secret", async () => {
		const machine = await generateKeyPair();
		const device = await generateKeyPair();
		const secret = random(32);
		const good = pairingMachine(machine, new TotpPairing(), { deviceKey: device.publicKey, secret });
		const key = await confirmTrust({ url: URL, device, deviceName: "laptop", socket: good.factory }, { kind: "install", secret });
		expect(key).toEqual(machine.publicKey);
		const bad = pairingMachine(machine, new TotpPairing(), { deviceKey: device.publicKey, secret: random(32) });
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
	it("passes the device key, the one-time pairing secret and the language, no install code", () => {
		const key = "A".repeat(43);
		const secret = "B".repeat(43);
		// No install code: tunelo joins My machines with the account it signs in with.
		expect(installCommand("mac", "https://chat.example.test", key, secret, "vi")).toBe(
			`curl -fsSL https://chat.example.test/agent/install.sh | sh -s -- ${key} ${secret} vi`,
		);
		expect(installCommand("windows", "https://chat.example.test", key, secret, "en")).toBe(
			`& ([scriptblock]::Create((irm https://chat.example.test/agent/install.ps1))) ${key} ${secret} en`,
		);
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

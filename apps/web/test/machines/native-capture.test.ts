// A screenshot taken by tunelo-capture on the user's own computer (ADR 0031):
// which machine is "this computer" (remembered, else the only one of the
// browser's system that is online and can capture, else offered), and the
// picture coming back in pieces over the machine's link into a file, or
// nothing when the user closed the overlay.
import { CaptureOutcome } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkHub } from "../../src/machines/link/link-hub.ts";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { captureOn, osOfBrowser, rememberCaptureMachine, resolveCaptureTarget } from "../../src/machines/native-capture.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/158.0 Safari/537.36";
const URL_A = "wss://abc.tunnel.hoandat.com";

const timers: Timers = {
	setTimeout: (fn) => setTimeout(fn, 0),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	setInterval: () => 0,
	clearInterval: () => undefined,
	now: () => Date.now(),
};

afterEach(() => localStorage.clear());

describe("this computer", () => {
	it("is read from the browser", () => {
		expect(osOfBrowser(MAC)).toBe("darwin");
		expect(osOfBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/158.0")).toBe("win32");
		expect(osOfBrowser("Mozilla/5.0 (X11; Linux x86_64) Chrome/158.0")).toBe("linux");
		expect(osOfBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBeNull();
		expect(osOfBrowser("Mozilla/5.0 (Linux; Android 15) Chrome/158.0")).toBeNull();
	});

	/** A hub whose machines answer at once: `able` can capture. */
	function hubOf(machines: { ref: string; name: string; os: string; online: boolean; able: boolean }[]): LinkHub {
		const entries = machines.map((m) => ({ ref: m.ref, id: Number(m.ref), name: m.name, os: m.os, arch: "arm64", agentVersion: "3.31.0", tunnelUrl: m.online ? URL_A : "", createdAt: 0, lastSeenAt: 0 }));
		const links = new Map(
			machines.map((m) => [
				m.ref,
				{
					start: () => undefined,
					subscribe: () => () => undefined,
					snapshot: () => ({ status: { kind: "open" }, info: { capture: { available: m.able, hotkey: "Ctrl+Alt+A" } } }),
				},
			]),
		);
		return {
			refresh: () => Promise.resolve(entries),
			directory: () => ({ status: "ready", machines: entries }),
			link: (ref: string) => links.get(ref),
		} as unknown as LinkHub;
	}

	it("is the only online machine of the browser's system that can capture", async () => {
		const hub = hubOf([
			{ ref: "1", name: "Mac mini", os: "darwin", online: true, able: true },
			{ ref: "2", name: "PC", os: "win32", online: true, able: true },
			{ ref: "3", name: "Old Mac", os: "darwin", online: false, able: true },
		]);
		expect(await resolveCaptureTarget(hub, MAC)).toEqual({ kind: "native", machine: { ref: "1", name: "Mac mini" } });
	});

	it("is offered when several can, then remembered", async () => {
		const hub = hubOf([
			{ ref: "1", name: "Mac mini", os: "darwin", online: true, able: true },
			{ ref: "4", name: "MacBook", os: "darwin", online: true, able: true },
		]);
		expect(await resolveCaptureTarget(hub, MAC)).toEqual({
			kind: "choose",
			machines: [
				{ ref: "1", name: "Mac mini" },
				{ ref: "4", name: "MacBook" },
			],
		});
		rememberCaptureMachine("4");
		expect(await resolveCaptureTarget(hub, MAC)).toEqual({ kind: "native", machine: { ref: "4", name: "MacBook" } });
		rememberCaptureMachine("web");
		expect(await resolveCaptureTarget(hub, MAC)).toEqual({ kind: "web" });
	});

	it("is the browser when no machine of its system can capture, or on a phone", async () => {
		const hub = hubOf([{ ref: "1", name: "Mac mini", os: "darwin", online: true, able: false }]);
		expect(await resolveCaptureTarget(hub, MAC)).toEqual({ kind: "web" });
		expect(await resolveCaptureTarget(hub, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toEqual({ kind: "web" });
	});
});

describe("a screenshot from the machine", () => {
	let machine: FakeMachine;
	let device: KeyPair;

	beforeEach(async () => {
		machine = await FakeMachine.create();
		device = await generateKeyPair();
		machine.trusted = [device.publicKey];
	});

	async function linkedHub(): Promise<{ hub: LinkHub; link: MachineLink }> {
		const link = new MachineLink({
			device: () => Promise.resolve(device),
			expectedKey: () => machine.keys.publicKey,
			tunnelUrl: () => URL_A,
			refreshTunnel: () => Promise.resolve(URL_A),
			socket: machine.factory,
			timers,
			random: () => 0,
		});
		link.start();
		await until(() => link.snapshot().status.kind === "open" && link.snapshot().info !== null, "open");
		const hub = { link: () => link, hold: () => () => undefined } as unknown as LinkHub;
		return { hub, link };
	}

	it("comes back in pieces as one file for the tray", async () => {
		const png = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
		machine.handler = (frame, socket) => {
			if (frame.body.case !== "captureRequest") return defaultAnswer(frame);
			const requestId = frame.body.value.requestId;
			setTimeout(() => {
				const piece = (offset: number, end: number, last: boolean) => ({
					case: "captureResult" as const,
					value: { requestId, outcome: CaptureOutcome.CAPTURED, name: "capture-1.png", mimeType: "image/png", size: BigInt(png.length), offset: BigInt(offset), data: png.slice(offset, end), last, message: "" },
				});
				machine.send(socket, piece(0, 200, false));
				machine.send(socket, piece(200, 300, true));
			}, 5);
			return [{ case: "ack", value: {} }];
		};
		const { hub } = await linkedHub();
		const file = await captureOn(hub, "1");
		expect(file?.name).toBe("capture-1.png");
		expect(file?.type).toBe("image/png");
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(png);
		expect(machine.received.some((f) => f.body.case === "captureRequest" && /^cap-/.test(f.body.value.requestId))).toBe(true);
	});

	it("is nothing when the user closed the overlay, and an error when the machine refuses", async () => {
		let refuse = false;
		machine.handler = (frame, socket) => {
			if (frame.body.case !== "captureRequest") return defaultAnswer(frame);
			if (refuse) return [{ case: "error", value: { message: "screenshots are not available on this machine" } }];
			const requestId = frame.body.value.requestId;
			setTimeout(() => machine.send(socket, { case: "captureResult", value: { requestId, outcome: CaptureOutcome.CANCELLED, last: true } }), 5);
			return [{ case: "ack", value: {} }];
		};
		const { hub } = await linkedHub();
		expect(await captureOn(hub, "1")).toBeNull();
		refuse = true;
		await expect(captureOn(hub, "1")).rejects.toThrow(/not available/);
	});
});

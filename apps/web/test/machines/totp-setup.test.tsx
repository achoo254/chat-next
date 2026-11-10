// Turning on (or replacing) pairing with an Authenticator code from a paired
// device: the browser makes the secret and shows it once as a QR code and
// text; a first code that does not match it sends nothing; a matching one
// sends the secret to the machine inside the encrypted session, and the QR
// code and the key are gone for good. The secret never shows up in the bytes
// on the wire, in a plain network call, in storage or in the console.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { base32Decode, generateKeyPair, totpCandidates, totpCode, type KeyPair } from "@achoo254/chat-remote-protocol";
import { ErrorCode, ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import type { SocketLike } from "../../src/machines/link/socket.ts";
import { TotpSetting } from "../../src/machines/totp-setup.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { defaultAnswer, FakeMachine, until, type Body } from "./fake-machine.ts";

const services = { toasts: { show: () => undefined } } as unknown as Services;
const URL_A = "wss://abc.tunnel.hoandat.com";
const timers: Timers = {
	setTimeout: (fn) => setTimeout(fn, 0),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	setInterval: () => 0,
	clearInterval: () => undefined,
	now: () => Date.now(),
};

let machine: FakeMachine;
let device: KeyPair;
/** Every byte this device put on the wire to the machine (the relay sees exactly these). */
let wire: Uint8Array[];

beforeEach(async () => {
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	wire = [];
	machine.handler = (frame) => {
		switch (frame.body.case) {
			case "totpSet":
				return [{ case: "totpStatus", value: { enabled: true } }];
			default:
				return defaultAnswer(frame);
		}
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function openLink(): Promise<MachineLink> {
	const socket = (url: string): SocketLike => {
		const s = machine.factory(url);
		const send = s.send.bind(s);
		s.send = (data) => {
			wire.push(new Uint8Array(data));
			send(data);
		};
		return s;
	};
	const l = new MachineLink({
		device: () => Promise.resolve(device),
		deviceName: "test",
		pinned: () => Promise.resolve(machine.keys.publicKey),
		tunnelUrl: () => URL_A,
		refreshTunnel: () => Promise.resolve(URL_A),
		socket,
		timers,
		random: () => 0,
	});
	l.start();
	await until(() => l.snapshot().status.kind === "open", "open");
	return l;
}

function show(link: MachineLink, enabled: boolean) {
	return render(
		<I18nProvider>
			<ServicesContext value={services}>
				<TotpSetting link={link} machine="Mac mini" enabled={enabled} online />
			</ServicesContext>
		</I18nProvider>,
	);
}

/** The key as the dialog shows it, decoded. */
function shownSecret(): Uint8Array {
	const code = document.querySelector("[data-id=totp-setup-secret] code");
	if (code === null) throw new Error("no secret shown");
	return base32Decode(code.textContent ?? "");
}

async function typeCode(code: string): Promise<void> {
	const first = screen.getByRole("group", { name: "Mã 6 số trong app Authenticator" }).querySelector("input");
	if (first === null) throw new Error("no code boxes");
	await userEvent.click(first);
	await userEvent.paste(code);
}

function wrongCode(secret: Uint8Array): string {
	const near = totpCandidates(secret);
	for (let n = 0; ; n++) {
		const code = String(n).padStart(6, "0");
		if (!near.includes(code)) return code;
	}
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

describe("turning on pairing with Authenticator", () => {
	it("checks the first code here, sends the secret only when it matches, then forgets it", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "send");
		const storageSpy = vi.spyOn(Storage.prototype, "setItem");
		const logged: unknown[] = [];
		for (const level of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(...args);
			});
		}
		const link = await openLink();
		const view = show(link, false);
		expect(screen.getByText("Chưa bật: thiết bị mới chưa ghép được với máy này.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Bật ghép bằng Authenticator" }));

		// Shown once: a QR code drawn in the page (no image, no data URI) and the key as text.
		const qr = screen.getByRole("img", { name: "Mã QR để thêm Mac mini vào app Authenticator" });
		expect(qr.tagName.toLowerCase()).toBe("svg");
		expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
		expect(view.container.querySelector("img")).toBeNull();
		const secret = shownSecret();
		expect(secret).toHaveLength(20);
		const key = (document.querySelector("[data-id=totp-setup-secret] code")?.textContent ?? "").replace(/ /g, "");

		// A first code the new entry would not show: nothing goes to the machine.
		await typeCode(wrongCode(secret));
		expect(await screen.findByText("Mã không khớp. Kiểm tra mục vừa thêm trong app rồi nhập mã đang hiện.")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 20));
		expect(machine.sent("totpSet")).toHaveLength(0);

		// The right one: the secret goes to the machine, and the dialog with it is gone.
		await typeCode(totpCode(secret));
		await until(() => machine.sent("totpSet").length === 1, "totpSet");
		expect(machine.sent("totpSet")[0]?.secret).toEqual(secret);
		await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
		expect(document.querySelector("[data-id=totp-setup]")).toBeNull();
		expect(document.body.textContent).not.toContain(key.slice(0, 8));
		expect(screen.getByText("Đã bật. Thiết bị mới ghép bằng mã trong app Authenticator.")).toBeTruthy();
		// The machine's info is asked again, so every page sees the new state.
		await until(() => machine.sent("machineInfoRequest").length >= 2, "machineInfoRequest");

		// Only inside the encrypted session: never in the clear on the wire, nor anywhere else.
		expect(wire.length).toBeGreaterThan(0);
		for (const bytes of wire) {
			expect(contains(bytes, secret)).toBe(false);
			expect(contains(bytes, new TextEncoder().encode(key))).toBe(false);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(xhrSpy).not.toHaveBeenCalled();
		expect(storageSpy).not.toHaveBeenCalled();
		expect(logged.map(String).some((text) => text.includes(key))).toBe(false);
		act(() => link.stop());
	});

	it("replacing it warns about the old entry, makes a new secret, and leaving sends nothing", async () => {
		const link = await openLink();
		show(link, true);
		expect(screen.getByText("Đang bật: thiết bị mới ghép bằng mã 6 số trong app Authenticator.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Tạo lại mã Authenticator" }));
		expect(screen.getByText(/Mục cũ của máy này trong app Authenticator sẽ không dùng được nữa/)).toBeTruthy();
		const first = shownSecret();
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		expect(document.querySelector("[data-id=totp-setup]")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Tạo lại mã Authenticator" }));
		expect(shownSecret()).not.toEqual(first);
		await userEvent.click(screen.getByRole("button", { name: "Huỷ" }));
		expect(machine.sent("totpSet")).toHaveLength(0);
		act(() => link.stop());
	});

	it("says so when the machine does not take it, and keeps the dialog to try again", async () => {
		machine.handler = (frame): Body[] | undefined =>
			frame.body.case === "totpSet" ? [{ case: "error", value: { code: ErrorCode.INVALID, reason: ErrorReason.TOTP_SECRET_INVALID, message: "bad secret" } }] : defaultAnswer(frame);
		const link = await openLink();
		show(link, false);
		await userEvent.click(screen.getByRole("button", { name: "Bật ghép bằng Authenticator" }));
		await typeCode(totpCode(shownSecret()));
		expect(await screen.findByText("Máy không nhận khoá Authenticator này. Làm lại từ đầu để tạo khoá mới.")).toBeTruthy();
		expect(screen.getByRole("img", { name: "Mã QR để thêm Mac mini vào app Authenticator" })).toBeTruthy();
		act(() => link.stop());
	});

	it("a machine that answers but stays off is not reported as turned on", async () => {
		machine.handler = (frame): Body[] | undefined => (frame.body.case === "totpSet" ? [{ case: "totpStatus", value: { enabled: false } }] : defaultAnswer(frame));
		const link = await openLink();
		show(link, false);
		await userEvent.click(screen.getByRole("button", { name: "Bật ghép bằng Authenticator" }));
		await typeCode(totpCode(shownSecret()));
		expect(await screen.findByText("Máy chưa lưu được. Thử lại.")).toBeTruthy();
		expect(screen.queryByText("Đã bật. Thiết bị mới ghép bằng mã trong app Authenticator.")).toBeNull();
		act(() => link.stop());
	});
});

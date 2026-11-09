// The machine's whole screen on the device: the channel noVNC uses keeps the
// service's first bytes until noVNC attaches and sends in order; the view
// opens a session only when Screen Sharing is on, shows the two steps when it
// is off, warns (and waits for a tap) when it is open to the network, and the
// Mac password leaves the page's state once sent. Also: deleting the browser's
// profile asks first; an account with no machine is shown how to start; the
// pairing page offers the quick install for the machine's system.
import { create } from "@bufbuild/protobuf";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { MachineInfoSchema } from "@achoo254/chat-proto/remote/remote";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineBrowser } from "../../src/machines/browser/machine-browser.tsx";
import ScreenView from "../../src/machines/screen/screen-view.tsx";
import { keysymOfChar, keysymOfKey, VncChannel } from "../../src/machines/screen/vnc-channel.ts";
import { QuickInstall } from "../../src/machines/pair-device.tsx";
import { quickInstallCommand } from "../../src/machines/add-machine.tsx";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";

/** CopyButton reports through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;

/** noVNC needs a real canvas: a stand-in that records what the view asks of it. */
const made: { credentials?: unknown; sent: unknown[] }[] = [];
vi.mock("@novnc/novnc", () => ({
	default: class extends EventTarget {
		scaleViewport = false;
		qualityLevel = 0;
		compressionLevel = 0;
		record: { credentials?: unknown; sent: unknown[] };
		constructor(_target: HTMLElement, channel: { onmessage: unknown }, options: { credentials?: unknown }) {
			super();
			this.record = { ...(options.credentials ? { credentials: options.credentials } : {}), sent: [] };
			made.push(this.record);
			channel.onmessage = () => undefined;
			queueMicrotask(() => this.dispatchEvent(new CustomEvent("credentialsrequired", { detail: { types: ["username", "password"] } })));
		}
		sendCredentials(c: unknown) {
			this.record.sent.push(c);
		}
		sendKey() {}
		disconnect() {}
	},
}));

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
let status = { supported: true, enabled: true, exposed: false, firewallOn: false };

beforeEach(async () => {
	made.length = 0;
	status = { supported: true, enabled: true, exposed: false, firewallOn: false };
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	machine.handler = (frame, socket) => {
		switch (frame.body.case) {
			case "screenShareStatusRequest":
				return [{ case: "screenShareStatus", value: status }];
			case "screenShareOpen":
				// The service greets at once, right behind the answer.
				setTimeout(() => machine.send(socket, { case: "screenShareData", value: { streamId: "s1", data: new TextEncoder().encode("RFB 003.889\n") } }), 0);
				return [{ case: "screenShareOpened", value: { streamId: "s1", idleMs: 600_000 } }];
			case "screenShareData":
			case "screenShareClose":
				return [{ case: "ack", value: {} }];
			case "browserClear":
				return [{ case: "machineInfo", value: create(MachineInfoSchema, { name: "Mac mini" }) }];
			default:
				return defaultAnswer(frame);
		}
	};
});

async function openLink(): Promise<MachineLink> {
	const l = new MachineLink({
		device: () => Promise.resolve(device),
		deviceName: "test",
		pinned: () => Promise.resolve(machine.keys.publicKey),
		tunnelUrl: () => URL_A,
		refreshTunnel: () => Promise.resolve(URL_A),
		socket: machine.factory,
		timers,
		random: () => 0,
	});
	l.start();
	await until(() => l.snapshot().status.kind === "open", "open");
	return l;
}

const sent = (kind: string) => machine.received.filter((f) => f.body.case === kind);

describe("the channel noVNC speaks through", () => {
	it("keeps the greeting until noVNC listens, sends in order, and closes the session", async () => {
		const l = await openLink();
		const channel = await VncChannel.open(l);
		await new Promise((r) => setTimeout(r, 30));
		const got: string[] = [];
		channel.onmessage = (e) => got.push(new TextDecoder().decode((e as { data: ArrayBuffer }).data));
		await until(() => got.length === 1, "greeting");
		expect(got).toEqual(["RFB 003.889\n"]);
		expect(channel.readyState).toBe("open");
		channel.send(new TextEncoder().encode("one"));
		channel.send(new TextEncoder().encode("two").buffer);
		await until(() => sent("screenShareData").length === 2, "data");
		expect(sent("screenShareData").map((f) => (f.body.case === "screenShareData" ? new TextDecoder().decode(f.body.value.data) : ""))).toEqual(["one", "two"]);
		let ended: boolean | null = null;
		channel.onEnd = (byMachine) => (ended = byMachine);
		channel.close();
		await until(() => sent("screenShareClose").length === 1, "close");
		expect(ended).toBe(false);
		expect(channel.readyState).toBe("closed");
		l.stop();
	});

	it("types characters and the phone keyboard's keys as keysyms", () => {
		expect(keysymOfChar("a")).toBe(0x61);
		expect(keysymOfChar("é")).toBe(0xe9);
		expect(keysymOfChar("ư")).toBe(0x010001b0);
		expect(keysymOfKey("Enter")).toBe(0xff0d);
		expect(keysymOfKey("x")).toBeNull();
	});
});

describe("the screen view", () => {
	const view = (l: MachineLink) =>
		render(
			<I18nProvider>
				<ScreenView link={l} ai="Claude Code" online inSession={false} onClose={() => undefined} />
			</I18nProvider>,
		);

	it("Screen Sharing off: the two steps, and no session is opened", async () => {
		status = { ...status, enabled: false };
		const l = await openLink();
		view(l);
		expect(await screen.findByText("Chia sẻ màn hình đang tắt trên máy")).toBeTruthy();
		expect(screen.getByText(/Cài đặt hệ thống → Cài đặt chung → Chia sẻ/)).toBeTruthy();
		expect(screen.getByText("tunelo không tự bật hay đổi cài đặt này.")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 30));
		expect(sent("screenShareOpen")).toHaveLength(0);
		l.stop();
	});

	it("open to the network: a warning first, the session only on a tap", async () => {
		status = { ...status, exposed: true };
		const l = await openLink();
		view(l);
		expect(await screen.findByText("Chia sẻ màn hình đang mở ra mạng")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 30));
		expect(sent("screenShareOpen")).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "Kết nối" }));
		await until(() => sent("screenShareOpen").length === 1, "open");
		l.stop();
	});

	it("on: opens at once; Apple's sign-in goes to noVNC and leaves the page", async () => {
		const l = await openLink();
		const { container } = view(l);
		await until(() => sent("screenShareOpen").length === 1, "open");
		const password = await screen.findByLabelText<HTMLInputElement>("Mật khẩu Mac");
		expect(password.type).toBe("password");
		expect(password.autocomplete).toBe("off");
		await userEvent.type(screen.getByLabelText("Tên tài khoản Mac"), "dat");
		await userEvent.type(password, "mac-secret!{Enter}");
		await waitFor(() => expect(made[0]?.sent).toEqual([{ username: "dat", password: "mac-secret!" }]));
		expect(container.innerHTML).not.toContain("mac-secret!");
		l.stop();
	});
});

describe("deleting the browser's profile", () => {
	it("asks first, then has the machine delete it", async () => {
		const l = await openLink();
		const state = { ...l.snapshot(), info: create(MachineInfoSchema, { browser: { available: true, running: true, clearable: true } }) };
		render(
			<I18nProvider>
				<MachineBrowser link={l} state={state} ai="Claude Code" />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Xoá hồ sơ trình duyệt" }));
		expect(screen.getByText(/mọi trang đã đăng nhập trong hồ sơ này bị đăng xuất/)).toBeTruthy();
		expect(sent("browserClear")).toHaveLength(0);
		const buttons = screen.getAllByRole("button", { name: "Xoá hồ sơ trình duyệt" });
		await userEvent.click(buttons.at(-1) as HTMLElement);
		await until(() => sent("browserClear").length === 1, "clear");
		expect(await screen.findByText("Đã xoá hồ sơ trình duyệt.")).toBeTruthy();
		l.stop();
	});

	it("a machine before 2.0.13 has no such button", async () => {
		const l = await openLink();
		const state = { ...l.snapshot(), info: create(MachineInfoSchema, { browser: { available: true, running: true } }) };
		render(
			<I18nProvider>
				<MachineBrowser link={l} state={state} ai="Claude Code" />
			</I18nProvider>,
		);
		expect(screen.queryByRole("button", { name: "Xoá hồ sơ trình duyệt" })).toBeNull();
		l.stop();
	});
});

describe("getting tunelo onto a machine", () => {
	it("the quick install follows the machine's system, or lets the user pick", async () => {
		expect(quickInstallCommand("windows", "https://chat.hoandat.com", "vi")).toBe("& ([scriptblock]::Create((irm https://chat.hoandat.com/agent/install.ps1))) vi");
		expect(quickInstallCommand("mac", "https://chat.hoandat.com", "vi")).toBe("curl -fsSL https://chat.hoandat.com/agent/install.sh | sh -s -- vi");
		const { unmount } = render(
			<I18nProvider>
<ServicesContext value={services}><QuickInstall machineOs="win32" /></ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByText(/Mở PowerShell trên máy đó/)).toBeTruthy();
		expect(screen.getByText(/install\.ps1/)).toBeTruthy();
		expect(screen.getByText(/mở cửa sổ PowerShell mới/)).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Hệ điều hành của máy" })).toBeNull();
		unmount();
		render(
			<I18nProvider>
<ServicesContext value={services}><QuickInstall machineOs="" /></ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByText(/install\.sh/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Windows" }));
		expect(screen.getByText(/install\.ps1/)).toBeTruthy();
	});

	it("an account with no machine is told what AI Agent does and how to start; on a phone, where to run it", async () => {
		const { FirstMachine } = await import("../../src/machines/first-machine.tsx");
		const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
		render(
			<I18nProvider>
				<FirstMachine />
			</I18nProvider>,
		);
		expect(screen.getByRole("heading", { name: "Điều khiển Claude Code trên máy của bạn" })).toBeTruthy();
		expect(screen.getByText(/đã cài và đăng nhập Claude Code/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Hướng dẫn cài Claude Code" })).toBeTruthy();
		expect(screen.getByText(/mở trang này trên máy tính bạn muốn điều khiển/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Kết nối máy đầu tiên" }).getAttribute("href")).toMatch(/add/);
		ua.mockRestore();
		act(() => undefined);
	});
});

// The machine's browser on the device: takeovers and passkey notices live in
// the link's state (outside every journal), pictures go only to the open
// view; the view asks the machine to stream only while it shows and stops
// when it closes or the page hides; the phone's keyboard text goes out and
// leaves the field, as a password field when the page's field is one;
// "Trả lại" ends the takeover; a passkey card offers to take over.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { BrowserTakeoverSchema, PasskeyNoticeSchema } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { BrowserDock } from "../../src/machines/browser/takeover-card.tsx";
import TakeoverView from "../../src/machines/browser/takeover-view.tsx";
import { keyPress, NO_ZOOM, pagePoint, phoneKey, pinch, wheelPixels } from "../../src/machines/browser/input-map.ts";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const takeover = create(BrowserTakeoverSchema, { takeoverId: "k1", threadId: "t1", reason: "Đăng nhập giúp mình", url: "https://accounts.example.com/login", expiresAt: BigInt(Date.now() + 600_000) });

const timers: Timers = {
	setTimeout: (fn) => setTimeout(fn, 0),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	setInterval: () => 0,
	clearInterval: () => undefined,
	now: () => Date.now(),
};

let machine: FakeMachine;
let device: KeyPair;

beforeEach(async () => {
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	machine.handler = (frame) => {
		switch (frame.body.case) {
			case "browserView":
			case "browserInput":
			case "browserTakeoverEnd":
				return [{ case: "ack", value: {} }];
			case "browserControl":
				return [{ case: "browserTakeover", value: { ...takeover, takeoverId: "mine", threadId: "" } }];
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

describe("the link", () => {
	it("keeps takeovers and passkey notices in its state, pictures only for the view", async () => {
		const l = await openLink();
		const before = l.snapshot();
		const got: string[] = [];
		const stop = l.onBrowser((m) => got.push(m.kind));
		machine.send(machine.socket, { case: "browserFrame", value: { takeoverId: "k1", targetId: "T1", jpeg: new Uint8Array([1, 2, 3]), pageWidth: 800, pageHeight: 600 } });
		machine.send(machine.socket, { case: "browserState", value: { takeoverId: "k1", tabs: [], targetId: "T1", passwordFocused: false } });
		await until(() => got.length === 2, "browser messages");
		expect(got).toEqual(["frame", "state"]);
		// A picture never changes the state React renders from.
		expect(l.snapshot()).toBe(before);
		stop();

		machine.send(machine.socket, { case: "browserTakeover", value: takeover });
		await until(() => l.snapshot().takeovers.size === 1, "takeover");
		machine.send(machine.socket, { case: "passkeyNotice", value: { origin: "https://accounts.example.com", create: false, threadId: "t1", at: 1n } });
		await until(() => l.snapshot().passkeyNotices.length === 1, "passkey");
		machine.send(machine.socket, { case: "browserTakeoverEnded", value: { takeoverId: "k1" } });
		await until(() => l.snapshot().takeovers.size === 0, "ended");

		// After a reconnect the machine sends what is still open again; nothing stale stays.
		machine.send(machine.socket, { case: "browserTakeover", value: takeover });
		await until(() => l.snapshot().takeovers.size === 1, "again");
		machine.socket.drop();
		await until(() => machine.sockets.length === 2 && l.snapshot().status.kind === "open", "reconnected");
		await until(() => l.snapshot().takeovers.size === 0, "cleared on reconnect");
		l.stop();
	});
});

describe("the live view", () => {
	it("streams only while it shows; the phone's text goes out and leaves the field; giving back ends it", async () => {
		const l = await openLink();
		const closed: string[] = [];
		const view = render(
			<I18nProvider>
				<TakeoverView link={l} takeover={takeover} ai="Claude Code" online inSession onMinimize={() => closed.push("min")} />
			</I18nProvider>,
		);
		await until(() => sent("browserView").length === 1, "view on");
		const on = sent("browserView")[0];
		expect(on?.body.case === "browserView" && on.body.value).toMatchObject({ takeoverId: "k1", on: true });
		expect(screen.getByText("Đang chờ hình từ máy…")).toBeTruthy();

		act(() => {
			machine.send(machine.socket, { case: "browserState", value: { takeoverId: "k1", tabs: [{ targetId: "T1", url: "https://accounts.example.com/login", title: "Đăng nhập" }], targetId: "T1", passwordFocused: true } });
			machine.send(machine.socket, { case: "browserFrame", value: { takeoverId: "k1", targetId: "T1", jpeg: new Uint8Array([255, 216, 255]), pageWidth: 1200, pageHeight: 800 } });
		});
		await waitFor(() => expect(view.container.querySelector(".mx-browser-surface img")).toBeTruthy());
		expect(screen.getByLabelText<HTMLInputElement>("Địa chỉ trang (chỉ đọc)").value).toBe("https://accounts.example.com/login");
		expect(screen.getByLabelText<HTMLInputElement>("Địa chỉ trang (chỉ đọc)").readOnly).toBe(true);
		await waitFor(() => expect(screen.getByText(/Ô mật khẩu: phím bạn gõ không được ghi lại/)).toBeTruthy());

		// The phone's keyboard: a password field, so it learns nothing; the text leaves the field once sent.
		const typing = screen.getByLabelText<HTMLInputElement>("Gõ vào trang");
		expect(typing.type).toBe("password");
		expect(typing.autocomplete).toBe("off");
		await userEvent.click(screen.getByRole("button", { name: "Bàn phím" }));
		await userEvent.type(typing, "x");
		await userEvent.type(typing, "{Enter}");
		await until(() => sent("browserInput").length === 2, "input");
		const [text, enter] = sent("browserInput");
		expect(text?.body.case === "browserInput" && text.body.value.action).toEqual({ case: "text", value: "x" });
		expect(enter?.body.case === "browserInput" && enter.body.value.action.case === "key" && enter.body.value.action.value.key).toBe("Enter");
		expect(typing.value).toBe("");

		// The page hides: the machine stops streaming; it shows again: streaming again.
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		act(() => void document.dispatchEvent(new Event("visibilitychange")));
		await until(() => sent("browserView").some((f) => f.body.case === "browserView" && !f.body.value.on), "view off when hidden");
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		act(() => void document.dispatchEvent(new Event("visibilitychange")));
		await until(() => sent("browserView").filter((f) => f.body.case === "browserView" && f.body.value.on).length === 2, "view on again");

		await userEvent.click(screen.getByRole("button", { name: "Trả lại cho Claude Code" }));
		await until(() => sent("browserTakeoverEnd").length === 1, "given back");
		await waitFor(() => expect(closed).toEqual(["min"]));
		view.unmount();
		await until(() => sent("browserView").filter((f) => f.body.case === "browserView" && !f.body.value.on).length === 2, "view off on close");
		l.stop();
	});
});

describe("cards", () => {
	it("a takeover card opens the view or gives the browser back; a passkey card offers to take over", async () => {
		const l = await openLink();
		const viewed: string[] = [];
		const { rerender } = render(
			<I18nProvider>
				<BrowserDock link={l} takeovers={[takeover]} notices={[]} ai="Claude Code" onView={(id) => viewed.push(id)} />
			</I18nProvider>,
		);
		expect(screen.getByRole("heading", { name: "Cần bạn thao tác trên trình duyệt của máy" })).toBeTruthy();
		expect(screen.getByText("Đăng nhập giúp mình")).toBeTruthy();
		expect(screen.getByText("accounts.example.com").tagName).toBe("STRONG");
		await userEvent.click(screen.getByRole("button", { name: "Mở trình duyệt" }));
		expect(viewed).toEqual(["k1"]);
		await userEvent.click(screen.getByRole("button", { name: "Trả lại cho Claude Code" }));
		await until(() => sent("browserTakeoverEnd").length === 1, "given back");

		const notice = create(PasskeyNoticeSchema, { origin: "https://accounts.example.com", create: false, threadId: "t1", at: 1n });
		rerender(
			<I18nProvider>
				<BrowserDock link={l} takeovers={[]} notices={[notice]} ai="Claude Code" onView={(id) => viewed.push(id)} />
			</I18nProvider>,
		);
		expect(screen.getByRole("heading", { name: "Trang cần passkey" })).toBeTruthy();
		expect(screen.getByText(/hộp thoại passkey hiện trên màn hình của máy/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Mở điều khiển từ xa" }));
		await until(() => sent("browserControl").length === 1, "control");
		await waitFor(() => expect(viewed).toEqual(["k1", "mine"]));
		l.stop();
	});
});

describe("input mapping", () => {
	it("maps a point on the shown picture to the page, zoomed or not", () => {
		expect(pagePoint(150, 100, { left: 100, top: 50, width: 600, height: 400 }, { width: 1200, height: 800 })).toEqual({ x: 100, y: 100 });
		expect(pagePoint(50, 100, { left: 100, top: 50, width: 600, height: 400 }, { width: 1200, height: 800 })).toBeNull();
	});

	it("keys: printable keys type, shortcuts do not, paste is left to the paste event", () => {
		const k = (key: string, more: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) =>
			keyPress({ key, code: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...more });
		expect(k("a")).toMatchObject({ key: "a", text: "a", modifiers: 0 });
		expect(k("a", { metaKey: true })).toMatchObject({ text: "", modifiers: 4 });
		expect(k("v", { ctrlKey: true })).toBeNull();
		expect(k("Shift")).toBeNull();
		expect(k("a", { isComposing: true })).toBeNull();
		expect(phoneKey("Backspace")).toMatchObject({ key: "Backspace", text: "" });
		expect(phoneKey("a")).toBeNull();
		expect(wheelPixels(3, 1)).toBe(120);
	});

	it("two fingers zoom between 1 and 4 times around their middle", () => {
		const z = pinch(NO_ZOOM, [{ x: 100, y: 100 }, { x: 200, y: 100 }], [{ x: 50, y: 100 }, { x: 250, y: 100 }]);
		expect(z.scale).toBe(2);
		expect(z.x).toBe(-150);
		expect(pinch(NO_ZOOM, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 1000, y: 0 }]).scale).toBe(4);
		expect(pinch(NO_ZOOM, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual(NO_ZOOM);
	});
});

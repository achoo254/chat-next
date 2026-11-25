// The machine's browser as a tab of the dock: it asks the machine to open it, shows its live view with
// an editable address (what is typed becomes an address or a search) and tab buttons, stops streaming while
// its tab is not the one shown, and offers to open again when the browser closed.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserNavigateAction } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { BrowserPane } from "../../src/machines/browser/browser-pane.tsx";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const OPEN = { takeoverId: "tab1", threadId: "", reason: "", url: "https://example.com/", expiresAt: 0n, osDialog: false };

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
	machine.trusted = [device.publicKey];
	machine.handler = (frame) => {
		switch (frame.body.case) {
			case "browserOpen":
				return [{ case: "browserTakeover", value: OPEN }];
			case "browserView":
			case "browserNavigate":
			case "browserInput":
				return [{ case: "ack", value: {} }];
			default:
				return defaultAnswer(frame);
		}
	};
});

async function openLink(): Promise<MachineLink> {
	const l = new MachineLink({
		device: () => Promise.resolve(device),
		expectedKey: () => machine.keys.publicKey,
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
const views = (on: boolean) => sent("browserView").filter((f) => f.body.case === "browserView" && f.body.value.on === on);

function pane(l: MachineLink, active: boolean) {
	return (
		<I18nProvider>
			<BrowserPane link={l} online active={active} />
		</I18nProvider>
	);
}

describe("the browser pane", () => {
	it("asks the machine to open the browser, then views it and goes where the address bar says", async () => {
		const l = await openLink();
		const view = render(pane(l, true));
		await until(() => sent("browserOpen").length === 1, "open request");
		await waitFor(() => expect(view.container.querySelector("[data-id=browser-view]")).toBeTruthy());
		expect(view.container.querySelector(".mx-browser.embedded")).toBeTruthy();
		// No title bar and nothing to give back: it is a tab, not a takeover of Claude's.
		expect(screen.queryByRole("button", { name: /Trả lại|Kết thúc điều khiển/ })).toBeNull();
		await until(() => views(true).length === 1, "view on");

		act(() => {
			machine.send(machine.socket, { case: "browserState", value: { takeoverId: "tab1", tabs: [{ targetId: "T1", url: "https://example.com/", title: "Example" }], targetId: "T1", passwordFocused: false } });
		});
		const bar = await screen.findByLabelText<HTMLInputElement>("Địa chỉ hoặc từ khoá tìm kiếm");
		expect(bar.readOnly).toBe(false);
		await waitFor(() => expect(bar.value).toBe("https://example.com/"));

		await userEvent.clear(bar);
		await userEvent.type(bar, "example.org/docs{Enter}");
		await until(() => sent("browserNavigate").length === 1, "goto");
		const goto = sent("browserNavigate")[0];
		expect(goto?.body.case === "browserNavigate" && goto.body.value).toMatchObject({ takeoverId: "tab1", targetId: "T1", action: BrowserNavigateAction.GOTO, url: "https://example.org/docs" });

		await userEvent.type(bar, "giá vàng{Enter}");
		await until(() => sent("browserNavigate").length === 2, "search");
		const search = sent("browserNavigate")[1];
		expect(search?.body.case === "browserNavigate" && search.body.value.url).toBe("https://www.google.com/search?q=gi%C3%A1%20v%C3%A0ng");

		await userEvent.click(screen.getByRole("button", { name: "Quay lại" }));
		await userEvent.click(screen.getByRole("button", { name: "Đi tiếp" }));
		await userEvent.click(screen.getByRole("button", { name: "Tải lại" }));
		await userEvent.click(screen.getByRole("button", { name: "Tab mới" }));
		await userEvent.click(screen.getByRole("button", { name: "Đóng tab" }));
		await until(() => sent("browserNavigate").length === 7, "buttons");
		const actions = sent("browserNavigate").slice(2).map((f) => (f.body.case === "browserNavigate" ? f.body.value.action : -1));
		expect(actions).toEqual([BrowserNavigateAction.BACK, BrowserNavigateAction.FORWARD, BrowserNavigateAction.RELOAD, BrowserNavigateAction.NEW_TAB, BrowserNavigateAction.CLOSE_TAB]);
		view.unmount();
		l.stop();
	});

	it("does not stream while its tab is not the one shown, and starts again when it is", async () => {
		const l = await openLink();
		const view = render(pane(l, false));
		await waitFor(() => expect(view.container.querySelector("[data-id=browser-view]")).toBeTruthy());
		await new Promise((r) => setTimeout(r, 100));
		expect(views(true)).toHaveLength(0);
		view.rerender(pane(l, true));
		await until(() => views(true).length === 1, "view on when shown");
		view.rerender(pane(l, false));
		await until(() => views(false).length >= 1, "view off when hidden");
		view.unmount();
		l.stop();
	});

	it("says so when the machine closed the browser, and opens it again on request", async () => {
		const l = await openLink();
		const view = render(pane(l, true));
		await waitFor(() => expect(view.container.querySelector("[data-id=browser-view]")).toBeTruthy());
		act(() => {
			machine.send(machine.socket, { case: "browserTakeoverEnded", value: { takeoverId: "tab1" } });
		});
		expect(await screen.findByText("Trình duyệt của máy đã đóng.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Mở lại" }));
		await until(() => sent("browserOpen").length === 2, "asked again");
		await waitFor(() => expect(view.container.querySelector("[data-id=browser-view]")).toBeTruthy());
		view.unmount();
		l.stop();
	});
});

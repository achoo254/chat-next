// The machine's terminal in AI Agent: shown only on a machine whose terminal
// is available (a hint to update or install again otherwise), the dock's
// tabs, splits and the path pill against a fake machine, refusal and
// revocation, the layout kept across visits even when the browser refuses
// storage, the keyboard shortcuts, the phone's key bar and the input that
// turns what an input method typed into keystrokes. xterm itself is replaced
// by a stand-in that records what reached the screen (jsdom has no canvas).
import { createConnectTransport } from "@connectrpc/connect-web";
import { TerminalAvailability, type Frame } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { terminalGate } from "../../src/machines/agent-version.ts";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import { MachineLink } from "../../src/machines/link/machine-link.ts";
import MachinesScreen from "../../src/machines/machines-screen.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { ImeInput, inputDelta, keyOf } from "../../src/terminal/ime-input.tsx";
import { endOnPurpose } from "../../src/terminal/ended-sessions.ts";
import { NO_AUTOFILL, noAutofill } from "../../src/terminal/no-autofill.ts";
import { keySequence, withModifiers } from "../../src/terminal/mobile-key-bar.tsx";
import { TerminalDock } from "../../src/terminal/terminal-dock.tsx";
import {
	addTab,
	aiPane,
	closePane,
	isSplitPane,
	cycleFocus,
	EMPTY_LAYOUT,
	layoutStore,
	panesOf,
	parseLayout,
	prune,
	sessionsOf,
	splitPane,
	type DockLayout,
	type LayoutStore,
} from "../../src/terminal/terminal-layout.ts";
import { TerminalLink, type TerminalSink } from "../../src/terminal/terminal-link.ts";
import { shortcutOf } from "../../src/terminal/terminal-tabs.tsx";
import { matchRoute, paths, type MachinesView } from "../../src/router.tsx";
import { aiPaths } from "../../src/machines/ai-paths.ts";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";
import { FakeTerminalHost, serverFrames } from "./fake-terminal.ts";

/** What each stand-in screen received, by session. */
const screens = new Map<number, string>();

vi.mock("../../src/terminal/terminal-view.tsx", () => ({
	TerminalView: ({
		link,
		session,
		label,
		onExit,
		register,
	}: {
		link: TerminalLink;
		session: number;
		label: string;
		onExit: (code: number) => void;
		register?: (handle: { text(): string } | null) => void;
	}) => {
		useEffect(() => {
			// The dock reads a pane's text when its program exits; the stand-in's is what it received.
			register?.({ text: () => screens.get(session) ?? "" });
			return () => register?.(null);
		}, [register, session]);
		useEffect(() => {
			const sink: TerminalSink = {
				snapshot: (s) => screens.set(session, new TextDecoder().decode(s.vt).replace("\x1bc", "")),
				output: (data, done) => {
					screens.set(session, (screens.get(session) ?? "") + new TextDecoder().decode(data));
					done();
				},
				exit: (code) => onExit(code),
				gone: () => undefined,
			};
			return link.attach(session, sink);
		}, [link, session, onExit]);
		return <div data-testid={`screen-${session}`} aria-label={label} />;
	},
}));

let machine: FakeMachine;
let device: KeyPair;
let host: FakeTerminalHost;
let terminal = TerminalAvailability.AVAILABLE;

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
	}),
}));

const services = { toasts: { show: () => undefined } } as unknown as Services;
const NativeWebSocket = window.WebSocket;

beforeEach(async () => {
	screens.clear();
	terminal = TerminalAvailability.AVAILABLE;
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	host = new FakeTerminalHost(machine);
	machine.handler = (frame: Frame, socket) => {
		if (frame.body.case === "machineInfoRequest") return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", maxSessions: 3, terminal } }];
		return host.handle(frame, socket) ?? defaultAnswer(frame);
	};
	// The app's links open `new WebSocket(tunnel)`: the fake machine answers.
	window.WebSocket = function (url: string) {
		return machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

const sent = (kind: string) => machine.received.filter((f) => f.body.case === kind);

describe("where the terminal shows", () => {
	function screenAt(view: MachinesView) {
		const machines = new FakeMachines();
		machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: machine.keys.publicKey });
		const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
		return render(
			<I18nProvider>
				<ServicesContext value={{ ...services, transport } as unknown as Services}>
					<MachineLinksProvider>
						<MachinesScreen view={view} />
					</MachineLinksProvider>
				</ServicesContext>
			</I18nProvider>,
		);
	}

	it("has routes for the machine's shells and for a session in its terminal", () => {
		expect(paths.machineTerminal("4")).toBe("/ai/4/terminal");
		expect(aiPaths.newShell("4", "/w/x y")).toBe("/ai/4/terminal?new=%2Fw%2Fx%20y");
		expect(aiPaths.sessionTerminal("4", "t_1")).toBe("/ai/4/s/t_1/terminal");
		expect(matchRoute("/ai/4/terminal")).toEqual({ name: "machines", view: { page: "terminal", machine: "4" } });
		expect(matchRoute("/ai/4/s/t_1/terminal")).toEqual({ name: "machines", view: { page: "session-terminal", machine: "4", threadId: "t_1" } });
		expect(matchRoute("/ai/4/s/t_1")).toEqual({ name: "machines", view: { page: "session", machine: "4", threadId: "t_1" } });
		expect(matchRoute("/ai/4/terminal/x")).toBeNull();
		expect(matchRoute("/ai/4/s/t_1/other")).toBeNull();
	});

	it("reads the machine's terminal availability", () => {
		expect(terminalGate(null)).toBe("unknown");
		expect(terminalGate({ terminal: TerminalAvailability.UNSPECIFIED })).toBe("update");
		expect(terminalGate({ terminal: TerminalAvailability.AVAILABLE })).toBe("available");
		expect(terminalGate({ terminal: TerminalAvailability.MISSING })).toBe("missing");
		expect(terminalGate({ terminal: TerminalAvailability.INCOMPATIBLE })).toBe("incompatible");
	});

	it("no Terminal entry in the column; a plain shell is a machine action on its card under Quản lý máy", async () => {
		screenAt({ page: "machines" });
		const card = (await screen.findAllByRole("listitem")).find((li) => li.getAttribute("data-id") === "machine-card");
		if (card === undefined) throw new Error("no machine card");
		// The machine as a card: its name, its state as a pill, its system, and its three actions.
		expect(within(card).getByRole("link", { name: "Mac mini" }).getAttribute("href")).toBe("/ai/1/info");
		await waitFor(() => expect(within(card).getByRole("status").textContent).toMatch(/Trực tuyến|Đã kết nối/));
		const acts = within(card).getByRole("group", { name: "Việc với máy Mac mini" });
		expect(within(acts).getByRole("link", { name: "Tổng quan máy" }).getAttribute("href")).toBe("/ai/1");
		expect(within(acts).getByRole("link", { name: "Cài đặt máy" }).getAttribute("href")).toBe("/ai/1/info");
		const shell = await within(acts).findByRole("button", { name: "Terminal mới" });
		await waitFor(() => expect((shell as HTMLButtonElement).disabled).toBe(false));
		await userEvent.click(shell);
		expect(window.location.pathname + window.location.search).toBe("/ai/1/terminal?new=");
		const column = document.querySelector<HTMLElement>(".mx-list") ?? document.body;
		expect(within(column).queryByRole("link", { name: "Terminal" })).toBeNull();
		expect(sent("termOpen")).toEqual([]);
	});

	it("the machine's overview (opened from Quản lý máy) goes back to that list, not to AI Agent", async () => {
		screenAt({ page: "machine", machine: "1" });
		const head = await screen.findByRole("region", { name: /Mac mini/ });
		expect(within(head).getByRole("link", { name: "Quản lý máy" }).getAttribute("href")).toBe("/ai/machines");
	});

	it("the machine's terminal page opens a shell, on the relay, on its own connection", async () => {
		screenAt({ page: "terminal", machine: "1" });
		await until(() => sent("termOpen").length === 1, "a first terminal");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		await waitFor(() => expect(document.querySelector("[data-id=terminal-path]")?.textContent).toMatch(/^Qua relay/));
		expect(sent("termOpen")[0]?.body.value).toMatchObject({ cwd: "" });
		expect(machine.sockets.filter((s) => !s.closed).length).toBe(2);
	});

	it.each([
		[TerminalAvailability.MISSING, "Máy chưa có phần terminal. Chạy tunelo update trên máy để dùng."],
		[TerminalAvailability.INCOMPATIBLE, "Phần terminal trên máy khác phiên bản. Chạy lại tunelo login trên máy."],
		[TerminalAvailability.UNSPECIFIED, "Cập nhật tunelo trên máy (2.4.0 trở lên) để dùng terminal."],
	])("terminal %i: no dock and no shell action, a hint instead", async (availability, hint) => {
		terminal = availability;
		const view = screenAt({ page: "terminal", machine: "1" });
		expect(await screen.findByText(hint, { selector: "p" })).toBeTruthy();
		expect(document.querySelector("[data-id=terminal-dock]")).toBeNull();
		view.unmount();
		screenAt({ page: "machines" });
		await screen.findByRole("link", { name: "Tổng quan máy" });
		// Still there, but it says why it cannot open (its tooltip and its name).
		const shell = await screen.findByRole("button", { name: /^Terminal mới: Máy chưa có phần terminal/ });
		expect((shell as HTMLButtonElement).disabled).toBe(true);
		expect(shell.parentElement?.getAttribute("title")).toBe("Máy chưa có phần terminal (xem Cài đặt máy).");
		expect(sent("termOpen")).toEqual([]);
	});
});

describe("a session in chat or in its terminal", () => {
	const THREAD = { id: "t1", title: "Fix login", dir: "/w/app", provider: "claude", state: 1, updatedAt: 1n };
	let held = 0;
	/** The held session runs a turn there (busy elsewhere), not just waits at its prompt. */
	let heldBusy = false;
	let terminalCli = true;

	beforeEach(() => {
		held = 0;
		heldBusy = false;
		terminalCli = true;
		window.localStorage.clear();
		const terminalHandler = machine.handler;
		machine.handler = (frame, socket) => {
			if (frame.body.case === "machineInfoRequest") {
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", maxSessions: 3, terminal, providers: [{ id: "claude", name: "Claude Code", capabilities: { terminal: terminalCli } }] } }];
			}
			if (frame.body.case === "threadList") return [{ case: "threadListResult", value: { threads: [{ ...THREAD, terminalSession: held, busyElsewhere: heldBusy }], openSessions: 0, maxSessions: 3 } }];
			return terminalHandler(frame, socket);
		};
	});

	function sessionAt(view: MachinesView) {
		const machines = new FakeMachines();
		machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: machine.keys.publicKey });
		const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
		return render(
			<I18nProvider>
				<ServicesContext value={{ ...services, transport } as unknown as Services}>
					<MachineLinksProvider>
						<MachinesScreen view={view} />
					</MachineLinksProvider>
				</ServicesContext>
			</I18nProvider>,
		);
	}

	it("terminal mode opens the session's AI: the page names only the thread, never a command", async () => {
		sessionAt({ page: "session-terminal", machine: "1", threadId: "t1" });
		await until(() => sent("termOpen").length === 1, "the AI's terminal");
		const open = sent("termOpen")[0]?.body;
		expect(open?.case === "termOpen" ? open.value.aiSession : undefined).toMatchObject({ threadId: "t1" });
		expect(open?.case === "termOpen" ? open.value.cwd : "x").toBe("");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		const group = screen.getByRole("group", { name: "Mở phiên bằng" });
		expect(within(group).getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
		// The path pill sits in the session header.
		await waitFor(() => expect(document.querySelector(".pg-head [data-id=terminal-path], header [data-id=terminal-path]")).toBeTruthy());
		await userEvent.click(within(group).getByRole("button", { name: "Trò chuyện" }));
		expect(window.location.pathname).toBe("/ai/1/s/t1");
		expect(window.localStorage.getItem("ai:mode:1")).toBe("chat");
	});

	it("a turn running in the terminal: the bar above the composer says it runs there, and no header chip repeats it", async () => {
		held = 5;
		heldBusy = true;
		sessionAt({ page: "session", machine: "1", threadId: "t1" });
		expect(await screen.findByText("Claude Code đang chạy phiên này trong terminal. Ở đây chỉ xem.")).toBeTruthy();
		expect(screen.queryByRole("status", { name: "Đang chạy trong terminal" })).toBeNull();
		expect(screen.queryByRole("status", { name: "Mở trong terminal" })).toBeNull();
	});

	it("in terminal mode the header has no 'running in the terminal' chip (the pill and Kết thúc say it); the switch shows which side is on", async () => {
		held = 1;
		sessionAt({ page: "session-terminal", machine: "1", threadId: "t1" });
		const group = await screen.findByRole("group", { name: "Mở phiên bằng" });
		expect(group.className).toBe("mx-view-switch");
		expect(within(group).getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
		expect(within(group).getByRole("button", { name: "Trò chuyện" }).getAttribute("aria-pressed")).toBe("false");
		await screen.findByRole("button", { name: "Kết thúc" });
		expect(screen.queryByRole("status", { name: "Đang chạy trong terminal" })).toBeNull();
		expect(screen.queryByRole("status", { name: "Đang mở ngoài app" })).toBeNull();
	});

	it("an AI without a terminal CLI: no switch, and the terminal address says so without opening anything", async () => {
		terminalCli = false;
		sessionAt({ page: "session-terminal", machine: "1", threadId: "t1" });
		expect(await screen.findByText("Máy này chưa mở được phiên bằng terminal.")).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Mở phiên bằng" })).toBeNull();
		expect(sent("termOpen")).toEqual([]);
	});

	it("while the terminal holds it, chat is read-only, points to the terminal, and can end it there", async () => {
		held = 7;
		sessionAt({ page: "session", machine: "1", threadId: "t1" });
		// Held by the machine's own terminal, its AI waiting at the prompt: open there, not running, not "elsewhere".
		const bar = await screen.findByText("Claude Code đang mở phiên này trong terminal, chờ lệnh. Ở đây chỉ xem.");
		// The bar says it is held; no header chip repeats it.
		expect(screen.queryByRole("status", { name: "Mở trong terminal" })).toBeNull();
		expect(screen.queryByRole("status", { name: "Đang chạy trong terminal" })).toBeNull();
		expect(screen.queryByRole("status", { name: "Đang mở ngoài app" })).toBeNull();
		const section = bar.closest("section");
		expect(section).toBeTruthy();
		expect(document.querySelector(".mx-composer.disabled")).toBeTruthy();
		await userEvent.click(within(section as HTMLElement).getByRole("button", { name: "Kết thúc" }));
		await until(() => sent("termClose").length === 1, "end");
		expect(sent("termClose")[0]?.body.value).toMatchObject({ session: 7 });
		await userEvent.click(within(section as HTMLElement).getByRole("button", { name: "Mở terminal" }));
		expect(window.location.pathname).toBe("/ai/1/s/t1/terminal");
		expect(window.localStorage.getItem("ai:mode:1")).toBe("terminal");
	});
});

describe("the dock", () => {
	const URL_A = "wss://abc.tunnel.hoandat.com";

	function links(): { link: MachineLink; terminal: TerminalLink } {
		const deps = {
			device: () => Promise.resolve(device),
			expectedKey: () => machine.keys.publicKey,
			tunnelUrl: () => URL_A,
			refreshTunnel: () => Promise.resolve(URL_A),
			socket: machine.factory,
			random: () => 0,
		};
		const link = new MachineLink(deps);
		link.start();
		const carrier = new MachineLink({ ...deps, purpose: "terminal" });
		return { link, terminal: new TerminalLink({ carrier, peers: null, iceServers: [] }) };
	}

	/** The dock once its machine's link is open (the screen shows it only then). */
	async function dock(store: LayoutStore, parts = links()) {
		await until(() => parts.link.snapshot().status.kind === "open", "link open");
		const view = render(
			<I18nProvider>
				<TerminalDock machine="1" link={parts.link} online terminal={parts.terminal} back="/ai/1" store={store} touch={false} />
			</I18nProvider>,
		);
		return { ...parts, view };
	}

	/** A store whose IndexedDB refuses everything. */
	const refusing = (): LayoutStore =>
		layoutStore({
			open: () => {
				throw new DOMException("denied", "SecurityError");
			},
		} as unknown as IDBFactory);

	it("opens a terminal, splits it, and closing a pane hangs up its shell", async () => {
		const { view, link, terminal } = await dock(refusing());
		await until(() => sent("termOpen").length === 1, "first terminal");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		host.print(1, "hello");
		await waitFor(() => expect(screens.get(1)).toBe("hello"));
		await userEvent.click(screen.getByRole("button", { name: "Chia sang phải" }));
		await waitFor(() => expect(screen.getByTestId("screen-2")).toBeTruthy());
		expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(2);
		expect(screen.getByRole("slider", { name: "Kéo để đổi cỡ ô" }).getAttribute("aria-valuenow")).toBe("50");
		// Alt+Shift+W closes the focused pane (the new one) and its shell.
		await userEvent.keyboard("{Alt>}{Shift>}W{/Shift}{/Alt}");
		await until(() => sent("termClose").length === 1, "close");
		expect(sent("termClose")[0]?.body.value).toMatchObject({ session: 2 });
		expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(1);
		expect(screen.getAllByRole("tab")).toHaveLength(1);
		terminal.stop();
		link.stop();
	});

	it("keeps the layout for the next visit, without sessions the machine no longer has, even when storage is refused", async () => {
		const store = refusing();
		const first = await dock(store);
		await until(() => sent("termOpen").length === 1, "first terminal");
		await userEvent.click(await screen.findByRole("button", { name: "Terminal mới" }));
		await until(() => sent("termOpen").length === 2, "second terminal");
		await userEvent.click(screen.getByRole("button", { name: "Chia xuống dưới" }));
		await until(() => sent("termOpen").length === 3, "third terminal");
		await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
		await act(() => new Promise((r) => setTimeout(r, 400)));
		first.view.unmount();
		first.terminal.stop();
		first.link.stop();
		// Session 1 ended on the machine meanwhile.
		host.sessions.delete(1);
		await dock(store);
		await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
		await waitFor(() => expect(screen.getByTestId("screen-2")).toBeTruthy());
		expect(screen.getByTestId("screen-3")).toBeTruthy();
		// No new terminal was opened: the old ones came back.
		expect(sent("termOpen")).toHaveLength(3);
	});

	it("says when the account revoked this device, with nothing to retry", async () => {
		await dock(refusing());
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		await until(() => host.frames.some((f) => f.frame.type === "attach"), "attached");
		host.broadcast(serverFrames.error(0, 6, "revoked"));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Thiết bị này đã bị thu hồi khỏi tài khoản nên máy đóng terminal.");
		expect(within(alert).queryByRole("button")).toBeNull();
		expect(within(alert).queryByRole("link")).toBeNull();
		expect(document.querySelector("[data-id=terminal-path]")?.textContent).toBe("Không mở được");
	});

	it("says when the machine refuses this device a terminal", async () => {
		host.refuse = true;
		await dock(refusing());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/thu hồi khỏi tài khoản|chưa nhận thiết bị này/);
	});

	it("every pane of a split has its own close button; the last one closes with its tab and hangs up the shell", async () => {
		const { view } = await dock(refusing());
		await until(() => sent("termOpen").length === 1, "first terminal");
		await userEvent.click(await screen.findByRole("button", { name: "Chia xuống dưới" }));
		await waitFor(() => expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(2));
		const closes = screen.getAllByRole("button", { name: "Đóng ô" });
		expect(closes).toHaveLength(2);
		await userEvent.click(closes[0] as HTMLElement);
		await until(() => sent("termClose").length === 1, "first shell hung up");
		expect(sent("termClose")[0]?.body.value).toMatchObject({ session: 1 });
		expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(1);
		// A lone pane closes with its tab.
		expect(screen.queryByRole("button", { name: "Đóng ô" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /^Đóng / }));
		await until(() => sent("termClose").length === 2, "second shell hung up");
		expect(screen.queryAllByRole("tab")).toHaveLength(0);
	});

	it("a session's dock: its AI first; shells in its folder; closing the AI's pane only detaches it", async () => {
		const parts = links();
		await until(() => parts.link.snapshot().status.kind === "open", "link open");
		const view = render(
			<I18nProvider>
				<TerminalDock machine="1" link={parts.link} online terminal={parts.terminal} thread={{ id: "t1", dir: "/w/app", chat: "/ai/1/s/t1" }} store={refusing()} touch={false} />
			</I18nProvider>,
		);
		await until(() => sent("termOpen").length === 1, "the AI");
		expect(sent("termOpen")[0]?.body.value).toMatchObject({ aiSession: { threadId: "t1" } });
		// No back button on a wide screen: the session header has it.
		expect(screen.queryByRole("link", { name: "Quay lại" })).toBeNull();
		await userEvent.click(await screen.findByRole("button", { name: "Chia sang phải" }));
		await until(() => sent("termOpen").length === 2, "a shell");
		expect(sent("termOpen")[1]?.body.value).toMatchObject({ cwd: "/w/app" });
		expect(sent("termOpen")[1]?.body.value).not.toHaveProperty("aiSession.threadId", "t1");
		await userEvent.click(screen.getByRole("button", { name: "Đóng ô (phiên vẫn chạy)" }));
		await waitFor(() => expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(1));
		await act(() => new Promise((r) => setTimeout(r, 50)));
		expect(sent("termClose")).toEqual([]);
		// Its AI is listed for coming back to (it still runs), and comes back as the same session.
		await userEvent.click(screen.getByRole("button", { name: "Phiên đang chạy trên máy" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /Phiên AI|Terminal/ }));
		// A tab of its own again (every tab keeps its panes mounted).
		await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
		expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(2);
		// Still the AI's: closing its tab detaches again, nothing is hung up.
		const tabCloses = screen.getAllByRole("button", { name: /^Đóng / }).filter((b) => b.classList.contains("tx-tab-x"));
		await userEvent.click(tabCloses.at(-1) as HTMLElement);
		await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
		await act(() => new Promise((r) => setTimeout(r, 50)));
		expect(sent("termClose")).toEqual([]);
		expect(sent("termOpen")).toHaveLength(2);
		parts.terminal.stop();
		parts.link.stop();
	});

	it("Terminal mới in a folder: one more shell there, then the request is done", async () => {
		const parts = links();
		await until(() => parts.link.snapshot().status.kind === "open", "link open");
		let done = 0;
		render(
			<I18nProvider>
				<TerminalDock machine="1" link={parts.link} online terminal={parts.terminal} back="/ai/1" openShellIn="/w/proj" onShellOpened={() => (done += 1)} store={refusing()} touch={false} />
			</I18nProvider>,
		);
		await until(() => done === 1, "shell opened");
		expect(sent("termOpen").map((f) => f.body.value)).toEqual([expect.objectContaining({ cwd: "/w/proj" })]);
		parts.terminal.stop();
		parts.link.stop();
	});

	it("a program that ended: the bar above the screen opens a new shell or closes the pane", async () => {
		const { view } = await dock(refusing());
		await until(() => sent("termOpen").length === 1, "first terminal");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		await until(() => host.frames.some((f) => f.frame.type === "attach"), "attached");
		host.exit(1, 1);
		expect(await screen.findByText("Tiến trình đã thoát (mã 1).")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Mở shell mới" }));
		await until(() => sent("termOpen").length === 2, "a new shell");
		await until(() => sent("termClose").length === 1, "the ended one closed");
		expect(sent("termClose")[0]?.body.value).toMatchObject({ session: 1 });
		await waitFor(() => expect(screen.getByTestId("screen-2")).toBeTruthy());
		await until(() => host.frames.filter((f) => f.frame.type === "attach").length >= 2, "attached again");
		host.exit(2, 1);
		await screen.findByText("Tiến trình đã thoát (mã 1).");
		// The keyboard reaches the bar's buttons too.
		const close = screen.getByRole("button", { name: "Đóng ô" });
		close.focus();
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(view.container.querySelectorAll(".tx-pane")).toHaveLength(0));
	});

	it("a session the user ended on purpose says so (not the hangup's exit code), and opens its AI again", async () => {
		const parts = links();
		await until(() => parts.link.snapshot().status.kind === "open", "link open");
		render(
			<I18nProvider>
				<TerminalDock machine="1" link={parts.link} online terminal={parts.terminal} thread={{ id: "t1", dir: "/w/app", chat: "/ai/1/s/t1" }} store={refusing()} touch={false} />
			</I18nProvider>,
		);
		await until(() => sent("termOpen").length === 1, "the AI");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		await until(() => host.frames.some((f) => f.frame.type === "attach"), "attached");
		endOnPurpose("1", 1);
		host.exit(1, 129);
		expect(await screen.findByText("Phiên đã kết thúc.")).toBeTruthy();
		expect(screen.queryByText(/mã 129/)).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Mở lại trong terminal" }));
		await until(() => sent("termOpen").length === 2, "the AI again");
		expect(sent("termOpen")[1]?.body.value).toMatchObject({ aiSession: { threadId: "t1" } });
		parts.terminal.stop();
		parts.link.stop();
	});

	it("a session the machine's AI has no history of offers Chat instead of opening it again", async () => {
		const parts = links();
		await until(() => parts.link.snapshot().status.kind === "open", "link open");
		render(
			<I18nProvider>
				<TerminalDock machine="1" link={parts.link} online terminal={parts.terminal} thread={{ id: "t1", dir: "/w/app", chat: "/ai/1/s/t1" }} store={refusing()} touch={false} />
			</I18nProvider>,
		);
		await until(() => sent("termOpen").length === 1, "the AI");
		await waitFor(() => expect(screen.getByTestId("screen-1")).toBeTruthy());
		await until(() => host.frames.some((f) => f.frame.type === "attach"), "attached");
		host.print(1, "No conversation found with session ID: f8981ec1-ab88-44b9-a7ea-2f23be1956e7\r\n");
		await waitFor(() => expect(screens.get(1) ?? "").toContain("No conversation found"));
		host.exit(1, 1);
		expect(await screen.findByText(/Máy không tìm thấy lịch sử của phiên này/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Mở lại trong terminal" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Về Trò chuyện" }));
		expect(window.location.pathname).toBe("/ai/1/s/t1");
		parts.terminal.stop();
		parts.link.stop();
	});

	it("says when the machine has no room for another terminal", async () => {
		host.maxSessions = 0;
		await dock(refusing());
		expect(await screen.findByText("Máy đã chạy đủ 20 phiên terminal. Đóng bớt rồi mở lại.")).toBeTruthy();
	});
});

describe("the layout", () => {
	it("splits, focuses, closes and prunes", () => {
		let l: DockLayout = addTab(EMPTY_LAYOUT, 1);
		const first = panesOf(l.tabs[0]?.root ?? { kind: "pane", id: "x", session: 0 })[0];
		l = splitPane(l, first?.id ?? "", "row", 2);
		l = splitPane(l, l.tabs[0]?.focus ?? "", "column", 3);
		expect([...sessionsOf(l)]).toEqual([1, 2, 3]);
		const tab = l.tabs[0];
		expect(tab?.root.kind).toBe("split");
		expect(panesOf(tab?.root ?? first ?? { kind: "pane", id: "", session: 0 }).map((p) => p.session)).toEqual([1, 2, 3]);
		l = cycleFocus(l, 1);
		expect(panesOf(l.tabs[0]?.root ?? { kind: "pane", id: "", session: 0 }).find((p) => p.id === l.tabs[0]?.focus)?.session).toBe(1);
		l = prune(l, new Set([1, 3]));
		expect([...sessionsOf(l)]).toEqual([1, 3]);
		for (const pane of panesOf(l.tabs[0]?.root ?? { kind: "pane", id: "", session: 0 })) l = closePane(l, pane.id);
		expect(l).toEqual({ tabs: [], active: "" });
	});

	it("marks the AI's pane, keeps the mark when stored, and gives only panes of a split tab a close button of their own", () => {
		let l: DockLayout = addTab(EMPTY_LAYOUT, 1, true);
		const ai = aiPane(l);
		expect(ai).toMatchObject({ session: 1, ai: true });
		expect(isSplitPane(l, ai?.id ?? "")).toBe(false);
		l = splitPane(l, ai?.id ?? "", "row", 2);
		expect(panesOf(l.tabs[0]?.root ?? { kind: "pane", id: "", session: 0 }).map((p) => isSplitPane(l, p.id))).toEqual([true, true]);
		l = addTab(l, 3);
		expect(isSplitPane(l, l.tabs[1]?.focus ?? "")).toBe(false);
		expect(aiPane(parseLayout(JSON.parse(JSON.stringify(l))) ?? EMPTY_LAYOUT)?.session).toBe(1);
		// A shell pane is never taken for the AI's.
		expect(aiPane(addTab(EMPTY_LAYOUT, 9))).toBeNull();
	});

	it("reads back only well-formed layouts", () => {
		const good = addTab(addTab(EMPTY_LAYOUT, 4), 5);
		expect(parseLayout(JSON.parse(JSON.stringify(good)))).toEqual(good);
		expect(parseLayout(null)).toBeNull();
		expect(parseLayout({ tabs: "x", active: "" })).toBeNull();
		expect(parseLayout({ tabs: [{ id: "t", root: { kind: "pane", id: "p", session: 0 }, focus: "p" }], active: "t" })).toBeNull();
		expect(parseLayout({ tabs: [{ id: "t", root: { kind: "split", id: "s", dir: "diagonal", ratio: 0.5 }, focus: "p" }], active: "t" })).toBeNull();
		// Duplicate ids are damage, not a layout.
		expect(parseLayout({ tabs: [{ id: "t", root: { kind: "split", id: "s", dir: "row", ratio: 3, a: { kind: "pane", id: "p", session: 1 }, b: { kind: "pane", id: "p", session: 2 } }, focus: "p" }], active: "t" })).toBeNull();
		const clamped = parseLayout({ tabs: [{ id: "t", root: { kind: "split", id: "s", dir: "row", ratio: 3, a: { kind: "pane", id: "p", session: 1 }, b: { kind: "pane", id: "q", session: 2 } }, focus: "zz" }], active: "nope" });
		expect(clamped?.active).toBe("t");
		expect(clamped?.tabs[0]?.focus).toBe("p");
		expect(clamped?.tabs[0]?.root).toMatchObject({ ratio: 0.9 });
	});

	it("keeps working in memory when IndexedDB is missing, refused, or fails a request", async () => {
		const layout = addTab(EMPTY_LAYOUT, 7);
		const failingRequest = () => {
			const request = { onsuccess: null, onerror: null as null | (() => void), onupgradeneeded: null, error: new DOMException("quota", "QuotaExceededError") };
			queueMicrotask(() => request.onerror?.());
			return request;
		};
		for (const factory of [undefined, { open: () => { throw new Error("blocked"); } }, { open: failingRequest }] as (IDBFactory | undefined)[]) {
			const store = layoutStore(factory);
			expect(await store.load("1")).toBeNull();
			await expect(store.save("1", layout)).resolves.toBeUndefined();
			expect(await store.load("1")).toEqual(layout);
		}
	});
});

describe("hidden inputs are not credential fields", () => {
	const OPT_OUTS = { autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false", name: "terminal-keys", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" };

	it("xterm's helper textarea gets every opt-out", () => {
		const textarea = document.createElement("textarea");
		noAutofill(textarea);
		for (const [name, value] of Object.entries(OPT_OUTS)) expect(textarea.getAttribute(name), name).toBe(value);
		expect(NO_AUTOFILL).toEqual(OPT_OUTS);
	});

	it("the phone's input method field has the same, and is never a password or e-mail field", () => {
		render(<ImeInput label="Gõ vào terminal" inputRef={{ current: null }} at={null} onSend={() => undefined} appCursor={() => false} />);
		const field = screen.getByRole("textbox", { name: "Gõ vào terminal" });
		expect(field.tagName).toBe("TEXTAREA");
		for (const [name, value] of Object.entries(OPT_OUTS)) expect(field.getAttribute(name), name).toBe(value);
		expect(field.getAttribute("type")).toBeNull();
	});
});

describe("keys", () => {
	it("dock shortcuts are Alt+Shift with a physical key, and nothing else", () => {
		const key = (code: string, mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>> = { altKey: true, shiftKey: true }) => shortcutOf({ altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods, code });
		expect(key("KeyT")).toEqual({ kind: "new-tab" });
		expect(key("KeyD")).toEqual({ kind: "split", dir: "row" });
		expect(key("KeyS")).toEqual({ kind: "split", dir: "column" });
		expect(key("KeyW")).toEqual({ kind: "close-pane" });
		expect(key("Digit3")).toEqual({ kind: "tab-index", index: 2 });
		expect(key("BracketRight")).toEqual({ kind: "tab", delta: 1 });
		expect(key("ArrowLeft")).toEqual({ kind: "pane", delta: -1 });
		// Alt alone is Meta for the shell (Alt+D deletes a word); Ctrl and ⌘ belong to the shell and the browser.
		expect(key("KeyD", { altKey: true })).toBeNull();
		expect(key("KeyT", { altKey: true, shiftKey: true, ctrlKey: true })).toBeNull();
		expect(key("KeyT", { altKey: true, shiftKey: true, metaKey: true })).toBeNull();
		expect(key("KeyQ")).toBeNull();
	});

	it("the key bar sends Esc, Tab and arrows in the terminal's cursor mode, Ctrl and Alt on the next key", () => {
		expect(keySequence("esc", false)).toBe("\x1b");
		expect(keySequence("tab", false)).toBe("\t");
		expect(keySequence("up", false)).toBe("\x1b[A");
		expect(keySequence("up", true)).toBe("\x1bOA");
		expect(keySequence("left", true)).toBe("\x1bOD");
		expect(keySequence("pipe", false)).toBe("|");
		expect(keySequence("tilde", false)).toBe("~");
		expect(withModifiers("c", { ctrl: true, alt: false })).toBe("\x03");
		expect(withModifiers("C", { ctrl: true, alt: false })).toBe("\x03");
		expect(withModifiers("[", { ctrl: true, alt: false })).toBe("\x1b");
		expect(withModifiers(" ", { ctrl: true, alt: false })).toBe("\x00");
		expect(withModifiers("b", { ctrl: false, alt: true })).toBe("\x1bb");
		expect(withModifiers("xy", { ctrl: true, alt: true })).toBe("\x1b\x18y");
		expect(withModifiers("đ", { ctrl: true, alt: false })).toBe("đ");
	});

	it("the phone input turns Telex and VNI rewrites into DELs and the new letters", () => {
		// Telex: "tieng" then "s" makes the keyboard rewrite the word in place.
		expect(inputDelta(" tieng", " tiếng")).toBe("\x7f\x7f\x7fếng");
		// VNI: "duong" then "9" then "2".
		expect(inputDelta(" duong", " đuong")).toBe("\x7f\x7f\x7f\x7f\x7fđuong");
		expect(inputDelta(" đuong", " đường")).toBe("\x7f\x7f\x7f\x7fường");
		// A composition that ends with the whole word.
		expect(inputDelta(" ", " tiếng Việt")).toBe("tiếng Việt");
		// Backspace on the field's leading space: one DEL.
		expect(inputDelta(" ", "")).toBe("\x7f");
		// Characters outside the BMP count as one.
		expect(inputDelta(" a😀", " a")).toBe("\x7f");
		expect(keyOf("Enter")).toBe("\r");
		expect(keyOf("ArrowDown")).toBe("\x1b[B");
		expect(keyOf("Backspace")).toBeNull();
		expect(keyOf("a")).toBeNull();
	});
});

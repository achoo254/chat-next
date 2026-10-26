// Mini Apps on the web (mockups/bots.html#mini-app, #mini-app-permission,
// console.html#mini-app-settings) through the real client core, the
// in-memory server and the fake bot services: the Console's Mini App URL,
// opening from an inline button and from "Mở app", the container and its
// bridge (origin and source checks, close, main button, write access, links,
// data back to the bot, theme), its "⋯" menu (reload, minimize, the bot's
// profile, report), minimizing to the chip and back, docking in the info
// column's place, and the history line of the data sent.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appDomainOf, miniAppUrlProblem } from "../src/messaging/bots/mini-app-settings.tsx";
import { BRIDGE_MAX_BYTES, miniAppFrameSrc, miniAppTarget, parseBridgeMessage } from "../src/messaging/bots/mini-app-bridge.ts";
import { en } from "../src/messaging/copy/en.ts";
import { vi as viCopy } from "../src/messaging/copy/vi.ts";
import { actionText } from "../src/messaging/data/format.ts";
import { matchRoute, navigate, paths } from "../src/router.tsx";
import { seedDemo, type Demo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const APP_URL = "https://release.deploytools.vn/app?env=prod";
const ORIGIN = "https://release.deploytools.vn";

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

afterEach(() => {
	delete document.documentElement.dataset.theme;
	vi.restoreAllMocks();
});

/** The app's domain in these tests (chat.hoandat.com). */
const APP = "hoandat.com";

describe("Mini App helpers", () => {
	it("take only well-formed bridge messages of known types, up to 4 KB", () => {
		expect(parseBridgeMessage({ type: "ready" })).toEqual({ type: "ready" });
		expect(parseBridgeMessage({ type: "close", data: { extra: 1 } })).toEqual({ type: "close" });
		expect(parseBridgeMessage({ type: "main_button", data: { text: " Phát hành ", visible: true, enabled: false } })).toEqual({
			type: "main_button",
			text: "Phát hành",
			visible: true,
			enabled: false,
		});
		expect(parseBridgeMessage({ type: "main_button", data: { text: "x", visible: "yes", enabled: true } })).toBeNull();
		expect(parseBridgeMessage({ type: "main_button", data: { text: "x".repeat(65), visible: true, enabled: true } })).toBeNull();
		expect(parseBridgeMessage({ type: "open_link", data: { url: "https://example.com/r" } })).toEqual({ type: "open_link", url: "https://example.com/r" });
		expect(parseBridgeMessage({ type: "open_link", data: {} })).toBeNull();
		expect(parseBridgeMessage({ type: "data_send", data: { data: "{\"v\":1}" } })).toEqual({ type: "data_send", data: "{\"v\":1}" });
		expect(parseBridgeMessage({ type: "data_send", data: { data: "" } })).toBeNull();
		expect(parseBridgeMessage({ type: "data_send", data: { data: "é".repeat(BRIDGE_MAX_BYTES / 2) } })).toBeNull();
		expect(parseBridgeMessage({ type: "navigate", data: { url: "https://evil.example" } })).toBeNull();
		expect(parseBridgeMessage("ready")).toBeNull();
		expect(parseBridgeMessage([{ type: "ready" }])).toBeNull();
		const cyclic: Record<string, unknown> = { type: "ready" };
		cyclic.data = cyclic;
		expect(parseBridgeMessage(cyclic)).toBeNull();
	});

	it("build the frame URL with the init data in its fragment and accept only https", () => {
		expect(miniAppFrameSrc("https://a.example/app?x=1#old", "user=%7B%7D&signature=s+1", "dark")).toBe(
			`https://a.example/app?x=1#chatAppData=${encodeURIComponent("user=%7B%7D&signature=s+1")}&chatAppTheme=dark`,
		);
		expect(miniAppTarget("https://a.example:8443/app")).toEqual({ origin: "https://a.example:8443", host: "a.example:8443" });
		expect(miniAppTarget("http://a.example/app")).toBeNull();
		expect(miniAppTarget("javascript:alert(1)")).toBeNull();
	});

	it("name the button in the line of data sent to the bot, and route the Console tab", () => {
		const nameOf = () => "";
		expect(actionText({ kind: "mini_app_data", buttonText: "Mở bảng" }, "Tôi", nameOf, viCopy, false)).toBe("Đã gửi dữ liệu từ “Mở bảng” tới bot");
		expect(actionText({ kind: "mini_app_data", buttonText: "" }, "Tôi", nameOf, viCopy, false)).toBe("Đã gửi dữ liệu tới bot");
		expect(actionText({ kind: "mini_app_data", buttonText: "Open" }, "Me", nameOf, en, false)).toBe("Data from “Open” sent to the bot");
		expect(actionText({ kind: "mini_app_data", buttonText: "" }, "Me", nameOf, en, false)).toBe("Data sent to the bot");
		expect(matchRoute("/console/42/mini-app")).toEqual({ name: "console", view: { page: "bot", botId: 42, tab: "mini-app" } });
	});

	it("check a Mini App URL before saving", () => {
		expect(miniAppUrlProblem("", APP)).toBeNull();
		expect(miniAppUrlProblem("https://release.deploytools.vn/app", APP)).toBeNull();
		expect(miniAppUrlProblem("http://release.deploytools.vn/app", APP)).toBe("invalid");
		expect(miniAppUrlProblem("https://localhost/app", APP)).toBe("invalid");
		expect(miniAppUrlProblem("release.deploytools.vn", APP)).toBe("invalid");
		expect(miniAppUrlProblem("https://u:p@release.deploytools.vn/", APP)).toBe("credentials");
		expect(miniAppUrlProblem("https://10.0.0.7/app", APP)).toBe("ip");
		expect(miniAppUrlProblem("https://release.deploytools.vn/app#start", APP)).toBe("fragment");
		expect(miniAppUrlProblem("https://[::1]/app", APP)).toBe("ip");
		// The app's script pasted as the URL, and URLs on the app's own domain.
		expect(miniAppUrlProblem("https://chat.hoandat.com/miniapp/sdk.js", APP)).toBe("script");
		expect(miniAppUrlProblem("https://chat.hoandat.com/app", APP)).toBe("appDomain");
		expect(miniAppUrlProblem("https://shop.hoandat.com/app", APP)).toBe("appDomain");
		expect(miniAppUrlProblem("https://hoandat.com/app", APP)).toBe("appDomain");
		expect(miniAppUrlProblem("https://nothoandat.com/app", APP)).toBeNull();
		expect(appDomainOf("chat.hoandat.com")).toBe(APP);
		expect(appDomainOf("localhost")).toBe("localhost");
		expect(miniAppUrlProblem(`https://a.example/${"x".repeat(520)}`, APP)).toBe("long");
	});
});

describe("Developer Console, Mini App", () => {
	it("checks the URL, previews the header with the real host and saves it; shows the server's refusal", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Deploy2 Bot", "deploy2_bot");
		renderMessaging(demo.fixture, `/console/${botId}/mini-app`);
		const form = await screen.findByRole("form", { name: "Mini App" }, LONG);
		const field = within(form).getByRole("textbox", { name: "URL Mini App" });
		const save = within(form).getByRole("button", { name: "Lưu" });
		expect(save.hasAttribute("disabled")).toBe(true);

		await userEvent.type(field, "http://release.deploytools.vn/app");
		expect(within(form).getByText("URL phải bắt đầu bằng https:// và có tên miền")).toBeTruthy();
		expect(save.hasAttribute("disabled")).toBe(true);

		await userEvent.clear(field);
		await userEvent.type(field, "https://release.deploytools.vn/app");
		const preview = within(form).getByTestId("mini-app-preview");
		expect(within(preview).getByText("release.deploytools.vn")).toBeTruthy();
		expect(within(preview).getByText("Deploy2 Bot")).toBeTruthy();
		await userEvent.click(save);
		await waitFor(() => expect(fake.bots.get(botId)?.miniAppUrl).toBe("https://release.deploytools.vn/app"));
		await waitFor(() => expect(toastText()).toBe("Đã lưu Mini App"));
		expect(screen.getByText(/getMiniAppKey/)).toBeTruthy();
		expect(screen.getByText(`${window.location.origin}/miniapp/sdk.js`)).toBeTruthy();

		// The fake server treats *.example.test as the app's own domain.
		await userEvent.clear(field);
		await userEvent.type(field, "https://apps.example.test/x");
		await userEvent.click(save);
		expect(await within(form).findByText(/Server không nhận URL này/, {}, LONG)).toBeTruthy();
		expect(fake.bots.get(botId)?.miniAppUrl).toBe("https://release.deploytools.vn/app");
	});
});

/** A bot message with a Mini App button (in the demo's bot chat unless said); returns its seq. */
function postAppButton(demo: Demo, chatId = demo.ids.bot): number {
	const f = demo.fixture;
	return f.send(demo.ids.users.deployBot, chatId, "Có 3 bản chờ phát hành. Mở bảng để chọn bản và môi trường.", {
		replyMarkup: {
			kind: {
				case: "inlineKeyboard",
				value: { rows: [{ buttons: [{ text: "Mở bảng phát hành", action: { case: "miniAppUrl", value: APP_URL } }] }] },
			},
		},
	});
}

/** Posts `data` to the app as if from `source` (the Mini App's frame by default) at `origin`. */
async function fromApp(frame: HTMLIFrameElement, data: unknown, origin = ORIGIN, source: Window | null = frame.contentWindow): Promise<void> {
	await act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
		await Promise.resolve();
	});
}

async function openFromButton(demo: Demo, chatId = demo.ids.bot) {
	const f = demo.fixture;
	f.bots.adopt(demo.ids.users.deployBot, "Deploy Bot", "deploy_bot", { owned: false });
	const seq = postAppButton(demo, chatId);
	renderMessaging(f, `/c/${chatId}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await userEvent.click(await within(log).findByRole("button", { name: "Mở bảng phát hành" }, LONG));
	const panel = await screen.findByRole("region", { name: "Mini App của Deploy Bot" }, LONG);
	const frame = within(panel).getByTitle<HTMLIFrameElement>("Mini App của Deploy Bot");
	const contentWindow = frame.contentWindow;
	if (contentWindow === null) throw new Error("the Mini App frame has no window");
	const posted = vi.spyOn(contentWindow, "postMessage");
	return { seq, panel, frame, posted, log };
}

describe("Mini App container", () => {
	it("opens from an inline button: OpenMiniApp for that message, a sandboxed frame with the init data, the real host", async () => {
		const demo = seedDemo();
		const { seq, panel, frame } = await openFromButton(demo);
		expect(demo.fixture.bots.miniAppOpens).toEqual([{ botId: demo.ids.users.deployBot, chatId: demo.ids.bot, seq, url: APP_URL }]);
		const src = frame.getAttribute("src") ?? "";
		const [base, fragment = ""] = src.split("#");
		expect(base).toBe(APP_URL);
		const params = new URLSearchParams(fragment);
		expect(params.get("chatAppData")).toContain(`bot_id=${demo.ids.users.deployBot}`);
		expect(params.get("chatAppData")).toContain("signature=fake-signature");
		expect(params.get("chatAppTheme")).toBe("light");
		expect(fragment.startsWith(`chatAppData=${encodeURIComponent(params.get("chatAppData") ?? "")}&`)).toBe(true);
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin allow-popups");
		expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
		expect(within(panel).getByText("release.deploytools.vn")).toBeTruthy();
		// The real host in the header says whose content it is; no provider line under it.
		expect(within(panel).queryByText(/Nội dung bên dưới do/)).toBeNull();
	});

	it("hears only its own frame at the Mini App's origin; draws the main button and closes when asked", async () => {
		const demo = seedDemo();
		const { panel, frame, posted } = await openFromButton(demo);
		const show = { type: "main_button", data: { text: "Phát hành 2.4.1", visible: true, enabled: true } };

		await fromApp(frame, show, "https://evil.example");
		await fromApp(frame, show, ORIGIN, window);
		await fromApp(frame, { ...show, type: "main_button_v2" });
		expect(within(panel).queryByRole("button", { name: "Phát hành 2.4.1" })).toBeNull();

		await fromApp(frame, show);
		const main = within(panel).getByRole("button", { name: "Phát hành 2.4.1" });
		await userEvent.click(main);
		expect(posted).toHaveBeenCalledWith({ type: "main_button_pressed" }, ORIGIN);
		// Every message down the bridge names the Mini App's origin, never "*".
		expect(posted.mock.calls.map((call: unknown[]) => call[1])).toEqual(posted.mock.calls.map(() => ORIGIN));

		await fromApp(frame, { type: "main_button", data: { text: "Phát hành 2.4.1", visible: true, enabled: false } });
		expect(within(panel).getByRole("button", { name: "Phát hành 2.4.1" }).hasAttribute("disabled")).toBe(true);
		await fromApp(frame, { type: "main_button", data: { text: "Phát hành 2.4.1", visible: false, enabled: true } });
		expect(within(panel).queryByRole("button", { name: "Phát hành 2.4.1" })).toBeNull();

		await fromApp(frame, { type: "close" }, "https://evil.example");
		expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeTruthy();
		await fromApp(frame, { type: "close" });
		await waitFor(() => expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeNull());
	});

	it("asks for write access in its own popup, then records it and tells the Mini App", async () => {
		const demo = seedDemo();
		const { panel, frame, posted } = await openFromButton(demo);
		await fromApp(frame, { type: "request_write_access" });
		const popup = await within(panel).findByRole("alertdialog", { name: "Cho phép Mini App gửi tin nhắn cho bạn?" });
		expect(within(popup).getByText("Deploy Bot sẽ nhắn được cho bạn trong chat riêng. Bạn có thể chặn bot bất cứ lúc nào.")).toBeTruthy();
		// The popup covers the header and the frame.
		expect(panel.querySelector(".ma-head")?.hasAttribute("inert")).toBe(true);
		expect(panel.querySelector(".ma-frame")?.hasAttribute("inert")).toBe(true);
		await userEvent.click(within(popup).getByRole("button", { name: "Cho phép" }));
		await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: "write_access", data: { granted: true } }, ORIGIN));
		expect(demo.fixture.bots.miniAppWrites).toEqual([demo.ids.users.deployBot]);
		expect(within(panel).queryByRole("alertdialog")).toBeNull();

		await fromApp(frame, { type: "request_write_access" });
		await userEvent.click(await within(panel).findByRole("button", { name: "Không cho phép" }));
		expect(posted).toHaveBeenCalledWith({ type: "write_access", data: { granted: false } }, ORIGIN);
		expect(demo.fixture.bots.miniAppWrites).toHaveLength(1);
	});

	it("opens an allowed link after asking, with noopener, and refuses a link outside the allowlist", async () => {
		const demo = seedDemo();
		const { panel, frame } = await openFromButton(demo);
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		await fromApp(frame, { type: "open_link", data: { url: "javascript:alert(1)" } });
		await waitFor(() => expect(toastText()).toBe("Mini App muốn mở một link không được phép"));
		expect(within(panel).queryByRole("alertdialog")).toBeNull();

		await fromApp(frame, { type: "open_link", data: { url: "https://example.com/reports/release-241" } });
		const popup = await within(panel).findByRole("alertdialog", { name: /Mở link ngoài/ });
		expect(within(popup).getByText("example.com")).toBeTruthy();
		expect(within(popup).getByText("https://example.com/reports/release-241")).toBeTruthy();
		expect(open).not.toHaveBeenCalled();
		await userEvent.click(within(popup).getByRole("button", { name: "Mở link" }));
		expect(open).toHaveBeenCalledWith("https://example.com/reports/release-241", "_blank", "noopener,noreferrer");
	});

	it("sends the Mini App's data to the bot, closes, and the chat shows that the data was sent", async () => {
		const demo = seedDemo();
		const { frame, log } = await openFromButton(demo);
		await fromApp(frame, { type: "data_send", data: { data: "{\"release\":\"2.4.1\"}" } });
		await waitFor(() => expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeNull());
		expect(demo.fixture.bots.miniAppData).toEqual([{ botId: demo.ids.users.deployBot, data: "{\"release\":\"2.4.1\"}", buttonText: "Mở bảng phát hành" }]);
		expect(await within(log).findByText("Đã gửi dữ liệu từ “Mở bảng phát hành” tới bot", {}, LONG)).toBeTruthy();
	});

	it("sends no data for a Mini App opened from a group: only the private chat with the bot may", async () => {
		const demo = seedDemo();
		const { frame } = await openFromButton(demo, demo.ids.ops);
		await fromApp(frame, { type: "data_send", data: { data: "x" } });
		await fromApp(frame, { type: "ready" });
		expect(demo.fixture.bots.miniAppData).toEqual([]);
		expect(screen.getByRole("region", { name: "Mini App của Deploy Bot" })).toBeTruthy();
	});

	it("tells the Mini App when the app's theme changes", async () => {
		const demo = seedDemo();
		const { posted } = await openFromButton(demo);
		await act(async () => {
			document.documentElement.dataset.theme = "dark";
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => expect(posted).toHaveBeenCalledWith({ type: "theme", data: { scheme: "dark" } }, ORIGIN));
	});

	it("opens the bot's main Mini App from Mở app, and says when it cannot open", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = demo.ids.users.deployBot;
		f.bots.adopt(botId, "Deploy Bot", "deploy_bot", { owned: false, miniAppUrl: "https://release.deploytools.vn/app" });
		f.bots.failOpenMiniApp = 1;
		renderMessaging(f, `/c/${demo.ids.bot}`);
		const openApp = await screen.findByRole("button", { name: "Mở app" }, LONG);
		await userEvent.click(openApp);
		await waitFor(() => expect(toastText()).toBe("Không mở được Mini App"));
		expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeNull();

		await userEvent.click(openApp);
		const panel = await screen.findByRole("region", { name: "Mini App của Deploy Bot" }, LONG);
		expect(f.bots.miniAppOpens.at(-1)).toEqual({ botId, chatId: demo.ids.bot, seq: 0, url: "" });
		const src = within(panel).getByTitle("Mini App của Deploy Bot").getAttribute("src") ?? "";
		expect(src.startsWith("https://release.deploytools.vn/app#chatAppData=")).toBe(true);
		await userEvent.click(within(panel).getByRole("button", { name: "Đóng Mini App" }));
		await waitFor(() => expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeNull());
	});

	it("shows no Mở app for a bot without a Mini App", async () => {
		const demo = seedDemo();
		demo.fixture.bots.adopt(demo.ids.users.deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		renderMessaging(demo.fixture, `/c/${demo.ids.bot}`);
		await screen.findByRole("textbox", { name: /^Tin nhắn tới/ }, LONG);
		await waitFor(() => expect(demo.fixture.bots.calls).toContain(`GetBotInfo ${demo.ids.users.deployBot}`));
		expect(screen.queryByRole("button", { name: "Mở app" })).toBeNull();
	});
});

/** The open chat screen's grid and info column, for the Mini App's place in it. */
function appGrid(): HTMLElement {
	const app = document.querySelector<HTMLElement>(".app");
	if (app === null) throw new Error("no chat screen");
	return app;
}

async function openMenu(panel: HTMLElement): Promise<HTMLElement> {
	await userEvent.click(within(panel).getByRole("button", { name: "Thêm thao tác" }));
	return within(panel).getByRole("menu", { name: "Thao tác với Mini App" });
}

describe("Mini App menu, minimize and place", () => {
	it("draws the header's menu: reload, minimize, the bot's profile and report", async () => {
		const demo = seedDemo();
		const { panel } = await openFromButton(demo);
		const more = within(panel).getByRole("button", { name: "Thêm thao tác" });
		expect(more.getAttribute("aria-haspopup")).toBe("menu");
		expect(more.getAttribute("aria-expanded")).toBe("false");
		const menu = await openMenu(panel);
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Tải lại", "Thu nhỏ", "Hồ sơ bot", "Báo cáo bot"]);
		expect(document.activeElement?.textContent).toBe("Tải lại");

		await userEvent.keyboard("{Escape}");
		expect(within(panel).queryByRole("menu")).toBeNull();
		// Esc closed the menu only, not the Mini App.
		expect(screen.getByRole("region", { name: "Mini App của Deploy Bot" })).toBe(panel);
		expect(document.activeElement).toBe(more);

		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Hồ sơ bot" }));
		const profile = await screen.findByRole("dialog", { name: "Thông tin · Deploy Bot" }, LONG);
		await userEvent.click(within(profile).getByRole("button", { name: /Đóng/ }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thông tin · Deploy Bot" })).toBeNull());

		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Báo cáo bot" }));
		expect(await screen.findByRole("dialog", { name: "Báo cáo Deploy Bot" }, LONG)).toBeTruthy();
		expect(screen.getByRole("region", { name: "Mini App của Deploy Bot" })).toBe(panel);
	});

	it("reloads: opens the same Mini App again with fresh init data, in a new frame", async () => {
		const demo = seedDemo();
		const { seq, panel, frame } = await openFromButton(demo);
		const botId = demo.ids.users.deployBot;
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Tải lại" }));
		await waitFor(() => expect(demo.fixture.bots.miniAppOpens).toHaveLength(2));
		expect(demo.fixture.bots.miniAppOpens[1]).toEqual({ botId, chatId: demo.ids.bot, seq, url: APP_URL });
		const again = await screen.findByRole("region", { name: "Mini App của Deploy Bot" }, LONG);
		const frameAgain = await waitFor(() => {
			const next = within(again).getByTitle<HTMLIFrameElement>("Mini App của Deploy Bot");
			expect(next).not.toBe(frame);
			return next;
		});
		expect(frameAgain.isConnected).toBe(true);
		expect(frame.isConnected).toBe(false);
		expect(frameAgain.getAttribute("src")?.startsWith(`${APP_URL}#chatAppData=`)).toBe(true);
	});

	it("says when it cannot reload, and keeps the Mini App open", async () => {
		const demo = seedDemo();
		const { panel, frame } = await openFromButton(demo);
		await fromApp(frame, { type: "ready" });
		demo.fixture.bots.failOpenMiniApp = 1;
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Tải lại" }));
		await waitFor(() => expect(toastText()).toBe("Không tải lại được Mini App"));
		expect(frame.isConnected).toBe(true);
		expect(within(panel).queryByRole("status")).toBeNull();
	});

	it("minimizes to a chip with the frame still mounted, tells the Mini App, and restores it", async () => {
		const demo = seedDemo();
		const { panel, frame, posted } = await openFromButton(demo);
		await fromApp(frame, { type: "ready" });
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Thu nhỏ" }));

		expect(panel.hidden).toBe(true);
		expect(frame.isConnected).toBe(true);
		expect(screen.queryByRole("region", { name: "Mini App của Deploy Bot" })).toBeNull();
		expect(posted).toHaveBeenCalledWith({ type: "deactivated" }, ORIGIN);
		const restore = await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);
		expect(restore.textContent).toBe("Deploy Bot · Mini App");
		await waitFor(() => expect(document.activeElement).toBe(restore));

		// A minimized Mini App keeps talking to the app.
		await fromApp(frame, { type: "main_button", data: { text: "Phát hành", visible: true, enabled: true } });

		await userEvent.click(restore);
		expect(screen.getByRole("region", { name: "Mini App của Deploy Bot" })).toBe(panel);
		expect(within(panel).getByTitle("Mini App của Deploy Bot")).toBe(frame);
		expect(within(panel).getByRole("button", { name: "Phát hành" })).toBeTruthy();
		expect(posted).toHaveBeenCalledWith({ type: "activated" }, ORIGIN);
		expect(posted.mock.calls.filter((call: unknown[]) => isActivation(call[0])).map((call: unknown[]) => call[0])).toEqual([
			{ type: "deactivated" },
			{ type: "activated" },
		]);
		expect(screen.queryByRole("button", { name: "Mở lại Deploy Bot · Mini App" })).toBeNull();
		expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Đóng Mini App" }));
	});

	it("keeps the chip in every chat until it is closed with its x", async () => {
		const demo = seedDemo();
		const { panel } = await openFromButton(demo);
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Thu nhỏ" }));
		await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);

		act(() => navigate(paths.chat(demo.ids.ops)));
		await waitFor(() => expect(document.querySelector(".convo")?.getAttribute("aria-label")).not.toBe("Deploy Bot"));
		const chip = (await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG)).parentElement;
		if (chip === null) throw new Error("no chip");
		await userEvent.click(within(chip).getByRole("button", { name: "Đóng Mini App" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Mở lại Deploy Bot · Mini App" })).toBeNull());
		expect(panel.isConnected).toBe(false);
	});

	it("minimizes when the user goes to another chat and comes back with its chat", async () => {
		const demo = seedDemo();
		const { panel, frame, posted } = await openFromButton(demo);
		await fromApp(frame, { type: "ready" });

		// Another chat: the Mini App and its main button leave the column, still running behind the chip.
		act(() => navigate(paths.chat(demo.ids.ops)));
		await waitFor(() => expect(panel.hidden).toBe(true));
		expect(frame.isConnected).toBe(true);
		expect(posted).toHaveBeenCalledWith({ type: "deactivated" }, ORIGIN);
		await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);

		// Back to the chat it was opened from: it shows again, same frame.
		act(() => navigate(paths.chat(demo.ids.bot)));
		await waitFor(() => expect(panel.hidden).toBe(false));
		expect(within(panel).getByTitle("Mini App của Deploy Bot")).toBe(frame);
		expect(posted).toHaveBeenCalledWith({ type: "activated" }, ORIGIN);
		expect(screen.queryByRole("button", { name: "Mở lại Deploy Bot · Mini App" })).toBeNull();
	});

	it("stays minimized back in its chat when the user minimized it by hand", async () => {
		const demo = seedDemo();
		const { panel } = await openFromButton(demo);
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Thu nhỏ" }));
		await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);

		act(() => navigate(paths.chat(demo.ids.ops)));
		await waitFor(() => expect(document.querySelector(".convo")?.getAttribute("aria-label")).not.toBe("Deploy Bot"));
		act(() => navigate(paths.chat(demo.ids.bot)));
		await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);
		expect(panel.hidden).toBe(true);
	});

	it("docks in the info column's place and gives it back as it was", async () => {
		const demo = seedDemo();
		const { panel } = await openFromButton(demo);
		// Wide screen, info column open before: the Mini App takes its place.
		expect(document.querySelector("aside.info")).toBeNull();
		expect(appGrid().classList.contains("no-info")).toBe(false);
		expect(panel.parentElement).toBe(appGrid());

		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Thu nhỏ" }));
		await waitFor(() => expect(document.querySelector("aside.info")).not.toBeNull());
		expect(appGrid().classList.contains("no-info")).toBe(false);

		// The chat's info button while the Mini App shows: the info column comes back, the Mini App minimizes.
		await userEvent.click(await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG));
		expect(document.querySelector("aside.info")).toBeNull();
		const infoButton = screen.getByRole("button", { name: "Thông tin chat" });
		expect(infoButton.getAttribute("aria-pressed")).toBe("false");
		await userEvent.click(infoButton);
		await waitFor(() => expect(document.querySelector("aside.info")).not.toBeNull());
		expect(panel.hidden).toBe(true);
		expect(screen.getByRole("button", { name: "Thông tin chat" }).getAttribute("aria-pressed")).toBe("true");

		// Info column closed before: it opens for the Mini App and closes again with it.
		await userEvent.click(screen.getByRole("button", { name: "Thông tin chat" }));
		await waitFor(() => expect(appGrid().classList.contains("no-info")).toBe(true));
		await userEvent.click(await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG));
		expect(appGrid().classList.contains("no-info")).toBe(false);
		expect(document.querySelector("aside.info")).toBeNull();
		await userEvent.click(within(panel).getByRole("button", { name: "Đóng Mini App" }));
		await waitFor(() => expect(panel.isConnected).toBe(false));
		expect(appGrid().classList.contains("no-info")).toBe(true);
		expect(document.querySelector("aside.info")).toBeNull();
	});

	it("opening another Mini App replaces the open one, minimized or not", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.bots.adopt(demo.ids.users.deployBot, "Deploy Bot", "deploy_bot", { owned: false, miniAppUrl: "https://release.deploytools.vn/main" });
		const { panel, log } = await openFromButton(demo);
		await userEvent.click(within(await openMenu(panel)).getByRole("menuitem", { name: "Thu nhỏ" }));
		await screen.findByRole("button", { name: "Mở lại Deploy Bot · Mini App" }, LONG);
		await userEvent.click(within(log).getByRole("button", { name: "Mở bảng phát hành" }));
		await waitFor(() => expect(panel.isConnected).toBe(false));
		expect(screen.getAllByRole("region", { name: "Mini App của Deploy Bot" })).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Mở lại Deploy Bot · Mini App" })).toBeNull();
	});
});

function isActivation(event: unknown): boolean {
	return typeof event === "object" && event !== null && "type" in event && (event.type === "activated" || event.type === "deactivated");
}

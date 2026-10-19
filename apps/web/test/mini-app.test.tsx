// Mini Apps on the web (mockups/bots.html#mini-app, #mini-app-permission,
// console.html#mini-app-settings) through the real client core, the
// in-memory server and the fake bot services: the Console's Mini App URL,
// opening from an inline button and from "Mở app", the container and its
// bridge (origin and source checks, close, main button, write access, links,
// data back to the bot, theme), and the history line of the data sent.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { miniAppUrlProblem } from "../src/messaging/bots/mini-app-settings.tsx";
import { BRIDGE_MAX_BYTES, miniAppFrameSrc, miniAppTarget, parseBridgeMessage } from "../src/messaging/bots/mini-app-bridge.ts";
import { en } from "../src/messaging/copy/en.ts";
import { vi as viCopy } from "../src/messaging/copy/vi.ts";
import { actionText } from "../src/messaging/data/format.ts";
import { matchRoute } from "../src/router.tsx";
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
		expect(miniAppUrlProblem("")).toBeNull();
		expect(miniAppUrlProblem("https://release.deploytools.vn/app")).toBeNull();
		expect(miniAppUrlProblem("http://release.deploytools.vn/app")).toBe("invalid");
		expect(miniAppUrlProblem("https://localhost/app")).toBe("invalid");
		expect(miniAppUrlProblem("release.deploytools.vn")).toBe("invalid");
		expect(miniAppUrlProblem("https://u:p@release.deploytools.vn/")).toBe("credentials");
		expect(miniAppUrlProblem("https://10.0.0.7/app")).toBe("ip");
		expect(miniAppUrlProblem("https://release.deploytools.vn/app#start")).toBe("fragment");
		expect(miniAppUrlProblem("https://[::1]/app")).toBe("ip");
		expect(miniAppUrlProblem(`https://a.example/${"x".repeat(520)}`)).toBe("long");
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
		expect(within(panel).getByText("Nội dung bên dưới do Deploy Bot cung cấp")).toBeTruthy();
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

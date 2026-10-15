// Bots in the web app (mockups/console.html, bots.html) through the real
// client core, the in-memory server and the fake bot services: the Developer
// Console (create, one-time token with the reauth round trip, profile,
// commands, delete), the deep link, starting a bot, callback buttons, the
// reply keyboard and the command menu.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BotCommandScope } from "@app/proto-ts/bot_admin";
import { ChatType } from "@app/proto-ts/chats";
import { matchCommands } from "../src/messaging/bots/bot-chat.tsx";
import { startCommand } from "../src/messaging/bots/bot-link-dialog.tsx";
import { normalizeUsername, reauthUrl, usernameFromName, usernameSuggestions } from "../src/messaging/bots/console.tsx";
import { usernameProblem, validStartParam } from "../src/messaging/bots/api.ts";
import { inAppBotLink } from "../src/messaging/ui/rich-text.tsx";
import { matchRoute, navigate, returnPathFor } from "../src/router.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function toastText(): string {
	return document.querySelector(".toast")?.textContent ?? "";
}

const utf8 = new TextEncoder();

describe("bot routes and helpers", () => {
	it("match the console pages and bot links, and keep a bot link's start parameter for sign-in", () => {
		expect(matchRoute("/console")).toEqual({ name: "console", view: { page: "list" } });
		expect(matchRoute("/console/new")).toEqual({ name: "console", view: { page: "new" } });
		expect(matchRoute("/console/42")).toEqual({ name: "console", view: { page: "bot", botId: 42, tab: "profile" } });
		expect(matchRoute("/console/42/token")).toEqual({ name: "console", view: { page: "bot", botId: 42, tab: "token" } });
		expect(matchRoute("/console/42/commands")).toEqual({ name: "console", view: { page: "bot", botId: 42, tab: "commands" } });
		expect(matchRoute("/console/42/webhook")).toBeNull();
		expect(matchRoute("/b/deploy_bot")).toEqual({ name: "bot", username: "deploy_bot" });
		expect(matchRoute("/b/ab")).toBeNull();
		expect(matchRoute("/b/x-y-z-bot")).toBeNull();
		expect(returnPathFor("/b/deploy_bot", "?start=release-241")).toBe("/b/deploy_bot?start=release-241");
		expect(returnPathFor("/c/12", "?x=1")).toBe("/c/12");
		expect(reauthUrl("vi", 42, "token", "token")).toBe("/auth/login?reauth=1&locale=vi&return_to=%2Fconsole%2F42%2Ftoken%3Fafter%3Dtoken");
	});

	it("normalizes usernames as they are typed and offers one from the display name", () => {
		expect(normalizeUsername("Báo-Cáo Đêm")).toBe("bao_cao_dem");
		expect(normalizeUsername("deploy ")).toBe("deploy_");
		expect(normalizeUsername("Hello@World!_bot")).toBe("helloworld_bot");
		expect(normalizeUsername("Ứng dụng  của tôi")).toBe("ung_dung_cua_toi");
		expect(normalizeUsername("x".repeat(40))).toHaveLength(32);
		expect(usernameFromName("Deploy Thử")).toBe("deploy_thu_bot");
		expect(usernameFromName("Báo cáo Bot")).toBe("bao_cao_bot");
		expect(usernameFromName("  Trực ca -- Đêm  ")).toBe("truc_ca_dem_bot");
		expect(usernameFromName("!!!")).toBe("");
		expect(usernameFromName("báo cáo doanh thu hằng ngày cho nhóm kinh doanh")).toBe("bao_cao_doanh_thu_hang_ngay_bot");
		expect(usernameProblem(usernameFromName("báo cáo doanh thu hằng ngày cho nhóm kinh doanh"))).toBeNull();
	});

	it("validate usernames, start parameters and in-app bot links", () => {
		expect(usernameProblem("report_bot")).toBeNull();
		expect(usernameProblem("Report_bot")).toBe("chars");
		expect(usernameProblem("report")).toBe("suffix");
		expect(usernameProblem("bot")).toBe("length");
		expect(usernameSuggestions("report_bot")).toEqual(["report_team_bot", "report2_bot"]);
		for (const candidate of usernameSuggestions("a_very_long_username_for_a_bot")) expect(usernameProblem(candidate)).toBeNull();
		expect(validStartParam("release-241")).toBe(true);
		expect(validStartParam("hello world")).toBe(false);
		expect(startCommand("")).toBe("/start");
		expect(startCommand("release-241")).toBe("/start release-241");
		expect(inAppBotLink("https://chat.example.test/b/deploy_bot?start=x", "https://chat.example.test")).toBe("/b/deploy_bot?start=x");
		expect(inAppBotLink("https://evil.example/b/deploy_bot", "https://chat.example.test")).toBeNull();
		expect(inAppBotLink("https://chat.example.test/c/1", "https://chat.example.test")).toBeNull();
	});

	it("filter commands by what is typed", () => {
		const commands = [
			{ command: "status", description: "Trạng thái" },
			{ command: "deploy", description: "Đẩy bản" },
		];
		expect(matchCommands(commands, "/", false).map((c) => c.command)).toEqual(["status", "deploy"]);
		expect(matchCommands(commands, "/de", false).map((c) => c.command)).toEqual(["deploy"]);
		expect(matchCommands(commands, "/deploy@deploy_bot", false).map((c) => c.command)).toEqual(["deploy"]);
		expect(matchCommands(commands, "/deploy now", false)).toEqual([]);
		expect(matchCommands(commands, "hi", false)).toEqual([]);
		expect(matchCommands(commands, "", true)).toHaveLength(2);
	});
});

describe("Developer Console", () => {
	it("creates a bot, checks the username as it is typed, and issues the token once after signing in again", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		fake.recentSignIn = false;
		renderMessaging(demo.fixture, "/settings/profile");
		await userEvent.click(await screen.findByRole("link", { name: "Developer Console" }, LONG));
		expect(window.location.pathname).toBe("/console");
		expect(await screen.findByText("Bạn chưa có bot nào", {}, LONG)).toBeTruthy();
		await userEvent.click(screen.getByRole("link", { name: "Tạo bot đầu tiên" }));

		const form = await screen.findByRole("form", { name: "Bot mới" }, LONG);
		const submit = within(form).getByRole("button", { name: "Tạo bot" });
		expect(submit.hasAttribute("disabled")).toBe(true);
		await userEvent.type(within(form).getByRole("textbox", { name: "Tên hiển thị" }), "Báo cáo Bot");
		const username = within(form).getByRole<HTMLInputElement>("textbox", { name: "Username" });
		// Offered from the display name until the username is typed in.
		expect(username.value).toBe("bao_cao_bot");
		await userEvent.clear(username);
		await userEvent.type(username, "Ré port");
		expect(username.value).toBe("re_port");
		await userEvent.type(within(form).getByRole("textbox", { name: "Tên hiển thị" }), " Mới");
		expect(username.value).toBe("re_port");
		expect(within(form).getByText("Username phải kết thúc bằng bot")).toBeTruthy();
		await userEvent.clear(username);
		// Taken by the demo's Deploy Bot: told while typing, with other names to try.
		await userEvent.type(username, "deploy_bot");
		expect(await within(form).findByText("username đã có người dùng", {}, LONG)).toBeTruthy();
		await userEvent.click(within(form).getByRole("button", { name: "deploy_team_bot" }));
		expect(await within(form).findByText("Dùng được", {}, LONG)).toBeTruthy();
		await userEvent.type(within(form).getByRole("textbox", { name: "Mô tả" }), "Báo cáo doanh thu mỗi sáng.");
		await userEvent.click(within(form).getByRole("switch", { name: "Chế độ riêng tư trong nhóm" }));
		await userEvent.click(submit);

		await waitFor(() => expect(window.location.pathname).toMatch(/^\/console\/\d+\/token$/), LONG);
		const botId = Number(window.location.pathname.split("/")[2]);
		const bot = fake.bots.get(botId);
		expect(bot).toMatchObject({ username: "deploy_team_bot", name: "Báo cáo Bot Mới", description: "Báo cáo doanh thu mỗi sáng.", privacy: false, tokenSecret: "" });

		// No recent sign-in: the console sends the browser to sign in again, back to this page.
		await userEvent.click(await screen.findByRole("button", { name: "Cấp token" }, LONG));
		const reauth = await screen.findByRole("dialog", { name: "Đăng nhập lại để tiếp tục" }, LONG);
		const link = within(reauth).getByRole("link", { name: "Đăng nhập lại" });
		expect(link.getAttribute("href")).toBe(`/auth/login?reauth=1&locale=vi&return_to=%2Fconsole%2F${botId}%2Ftoken%3Fafter%3Dtoken`);
		expect(fake.calls).toContain(`ResetBotToken ${botId}`);
		expect(bot?.tokenSecret).toBe("");
	});

	it("says when bots are created too fast", async () => {
		const demo = seedDemo();
		demo.fixture.bots.createLimited = true;
		renderMessaging(demo.fixture, "/console/new");
		const form = await screen.findByRole("form", { name: "Bot mới" }, LONG);
		await userEvent.type(within(form).getByRole("textbox", { name: "Tên hiển thị" }), "Báo cáo Bot");
		await userEvent.type(within(form).getByRole("textbox", { name: "Username" }), "report_daily_bot");
		await within(form).findByText("Dùng được", {}, LONG);
		await userEvent.click(within(form).getByRole("button", { name: "Tạo bot" }));
		expect((await within(form).findByRole("alert", {}, LONG)).textContent).toBe("Bạn vừa tạo nhiều bot liên tiếp. Đợi vài phút rồi tạo tiếp.");
		expect(window.location.pathname).toBe("/console/new");
	});

	it("asks once more on coming back from the sign-in, then shows the token once and masks it after", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Báo cáo Bot", "report_daily_bot");
		const resets = () => fake.calls.filter((call) => call === `ResetBotToken ${botId}`).length;
		renderMessaging(demo.fixture, `/console/${botId}/token?after=token`);
		// Nothing is issued until the confirmation's button is pressed.
		const ask = await screen.findByRole("dialog", { name: "Cấp token cho Báo cáo Bot?" }, LONG);
		expect(resets()).toBe(0);
		await waitFor(() => expect(window.location.search).toBe(""));
		await userEvent.click(within(ask).getByRole("button", { name: "Cấp token" }));
		const token = await screen.findByTestId("bot-token", {}, LONG);
		expect(token.textContent).toBe(`${botId}:${fake.bots.get(botId)?.tokenSecret ?? "?"}`);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByText(/Token chỉ hiện một lần/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sao chép" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Tôi đã lưu token" }));
		expect(screen.queryByTestId("bot-token")).toBeNull();
		expect(document.body.innerHTML).not.toContain(fake.bots.get(botId)?.tokenSecret ?? "missing");
		expect(screen.getByText(`${botId}:${"•".repeat(24)}`)).toBeTruthy();
		// Reissuing asks first: the old token stops at once.
		await userEvent.click(screen.getByRole("button", { name: "Cấp lại token" }));
		const confirm = await screen.findByRole("dialog", { name: "Cấp lại token?" }, LONG);
		await userEvent.click(within(confirm).getByRole("button", { name: "Cấp lại token" }));
		expect(await screen.findByTestId("bot-token", {}, LONG)).toBeTruthy();
		expect(resets()).toBe(2);
		// The poll line explains how updates arrive.
		expect(screen.getByText(/GET http:\/\/localhost(:\d+)?\/bot\/v1\/updates/)).toBeTruthy();
		// Another tab and back: the return from the sign-in is not acted on again.
		await userEvent.click(screen.getByRole("link", { name: "Hồ sơ" }));
		await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		await userEvent.click(screen.getByRole("link", { name: "Token" }));
		await screen.findByRole("button", { name: "Cấp lại token" }, LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(resets()).toBe(2);
	});

	it("a link carrying ?after=token only opens the confirmation, and a tab switch does not reopen it", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Trực ca Bot", "oncall_bot", { tokenSecret: "s", tokenIssuedAt: fake.now });
		renderMessaging(demo.fixture, `/console/${botId}/token?after=token`);
		const ask = await screen.findByRole("dialog", { name: "Cấp lại token?" }, LONG);
		await waitFor(() => expect(window.location.search).toBe(""));
		await userEvent.click(within(ask).getByRole("button", { name: "Huỷ" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		await userEvent.click(screen.getByRole("link", { name: "Lệnh" }));
		await screen.findByRole("form", { name: "Lệnh" }, LONG);
		await userEvent.click(screen.getByRole("link", { name: "Token" }));
		await screen.findByRole("button", { name: "Cấp lại token" }, LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fake.calls).not.toContain(`ResetBotToken ${botId}`);
		expect(fake.bots.get(botId)?.tokenSecret).toBe("s");
	});

	it("says on the token tab when the bot last asked for updates", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const idle = fake.seed("Trực ca Bot", "oncall_bot", { tokenSecret: "s", tokenIssuedAt: fake.now });
		renderMessaging(demo.fixture, `/console/${idle}/token`);
		expect(await screen.findByText("Bot chưa nhận update lần nào", {}, LONG)).toBeTruthy();
	});

	it("shows the last update fetch time of a running bot", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const at = new Date(2026, 9, 15, 16, 40).getTime() / 1000;
		const busy = fake.seed("Báo cáo Bot", "report_daily_bot", { tokenSecret: "s", tokenIssuedAt: fake.now, lastUpdateAt: at });
		renderMessaging(demo.fixture, `/console/${busy}/token`);
		expect(await screen.findByText("Lần cuối nhận update: 15/10 16:40", {}, LONG)).toBeTruthy();
	});

	it("ignores ?after= on a tab it does not belong to", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Trực ca Bot", "oncall_bot", { tokenSecret: "s", tokenIssuedAt: fake.now });
		renderMessaging(demo.fixture, `/console/${botId}?after=token`);
		await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		await waitFor(() => expect(window.location.search).toBe(""));
		await userEvent.click(screen.getByRole("link", { name: "Token" }));
		await screen.findByRole("button", { name: "Cấp lại token" }, LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fake.calls).not.toContain(`ResetBotToken ${botId}`);
	});

	it("lists bots, edits the profile and deletes a bot after signing in again", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Trực ca Bot", "oncall_bot", { tokenSecret: "s", tokenIssuedAt: fake.now });
		fake.recentSignIn = false;
		renderMessaging(demo.fixture, "/console");
		const table = await screen.findByRole("table", {}, LONG);
		expect(within(table).getByText("@oncall_bot")).toBeTruthy();
		expect(within(table).getByText("Long poll")).toBeTruthy();
		await userEvent.click(within(table).getByRole("link", { name: "Quản lý Trực ca Bot" }));

		const form = await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		await userEvent.type(within(form).getByRole("textbox", { name: "Giới thiệu" }), "Ai đang trực ca");
		await userEvent.click(within(form).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(fake.bots.get(botId)?.about).toBe("Ai đang trực ca"));
		expect(fake.calls).toContain(`UpdateBot ${botId}`);

		await userEvent.click(screen.getByRole("button", { name: "Xoá bot" }));
		const confirm = await screen.findByRole("dialog", { name: "Xoá Trực ca Bot?" }, LONG);
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoá bot" }));
		const reauth = await screen.findByRole("dialog", { name: "Đăng nhập lại để tiếp tục" }, LONG);
		expect(within(reauth).getByRole("link", { name: "Đăng nhập lại" }).getAttribute("href")).toContain(`return_to=%2Fconsole%2F${botId}%3Fafter%3Ddelete`);
		expect(fake.bots.get(botId)?.deleted).toBe(false);
	});

	it("asks about deleting once after the sign-in: cancelled, a tab switch does not ask again", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Trực ca Bot", "oncall_bot");
		renderMessaging(demo.fixture, `/console/${botId}?after=delete`);
		const confirm = await screen.findByRole("dialog", { name: "Xoá Trực ca Bot?" }, LONG);
		await waitFor(() => expect(window.location.search).toBe(""));
		await userEvent.click(within(confirm).getByRole("button", { name: "Huỷ" }));
		await userEvent.click(screen.getByRole("link", { name: "Token" }));
		await screen.findByRole("button", { name: "Cấp token" }, LONG);
		await userEvent.click(screen.getByRole("link", { name: "Hồ sơ" }));
		await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fake.calls).not.toContain(`DeleteBot ${botId}`);
	});

	it("asks again after the sign-in and deletes the bot", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Trực ca Bot", "oncall_bot");
		renderMessaging(demo.fixture, `/console/${botId}?after=delete`);
		const confirm = await screen.findByRole("dialog", { name: "Xoá Trực ca Bot?" }, LONG);
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoá bot" }));
		await waitFor(() => expect(window.location.pathname).toBe("/console"), LONG);
		expect(fake.bots.get(botId)?.deleted).toBe(true);
		expect(await screen.findByText("Bạn chưa có bot nào", {}, LONG)).toBeTruthy();
	});

	it("edits commands per scope, refuses bad ones and keeps the default list", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const botId = fake.seed("Deploy2 Bot", "deploy2_bot");
		fake.setCommands(botId, BotCommandScope.DEFAULT, [{ command: "help", description: "Trợ giúp" }]);
		fake.setCommands(botId, BotCommandScope.PRIVATE, [{ command: "start", description: "Bắt đầu" }]);
		renderMessaging(demo.fixture, `/console/${botId}/commands`);

		const form = await screen.findByRole("form", { name: "Lệnh" }, LONG);
		expect(within(form).getByDisplayValue("start")).toBeTruthy();
		await userEvent.click(within(form).getByRole("tab", { name: "Mọi nhóm" }));
		await userEvent.click(within(form).getByRole("button", { name: "Thêm lệnh" }));
		await userEvent.type(within(form).getAllByRole("textbox", { name: "Lệnh" })[0] as HTMLElement, "Deploy-Now");
		expect(within(form).getByText("Chỉ chữ thường a–z, số và dấu gạch dưới")).toBeTruthy();
		await userEvent.click(within(form).getByRole("button", { name: "Lưu" }));
		expect(within(form).getByText("Sửa các ô báo lỗi trước khi lưu")).toBeTruthy();
		expect(fake.calls).not.toContain(`UpdateBot ${botId}`);

		const command = within(form).getAllByRole("textbox", { name: "Lệnh" })[0] as HTMLElement;
		await userEvent.clear(command);
		await userEvent.type(command, "status");
		await userEvent.type(within(form).getAllByRole("textbox", { name: "Mô tả" })[0] as HTMLElement, "Trạng thái pipeline");
		// What group members will see.
		expect(screen.getByText("Trong nhóm, với thành viên thường")).toBeTruthy();
		expect(screen.getByText("/status")).toBeTruthy();
		await userEvent.click(within(form).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(fake.calls).toContain(`UpdateBot ${botId}`));
		const sets = fake.bots.get(botId)?.commands ?? [];
		const of = (scope: BotCommandScope) => sets.find((set) => set.scope === scope)?.commands.map((c) => `${c.command}:${c.description}`);
		expect(of(BotCommandScope.DEFAULT)).toEqual(["help:Trợ giúp"]);
		expect(of(BotCommandScope.PRIVATE)).toEqual(["start:Bắt đầu"]);
		expect(of(BotCommandScope.GROUP)).toEqual(["status:Trạng thái pipeline"]);
		expect(of(BotCommandScope.GROUP_ADMIN)).toBeUndefined();
	});
});

describe("bots in chats", () => {
	it("opens a bot link: asks first, then starts the bot with the parameter and opens its chat", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		const { deployBot } = demo.ids.users;
		fake.adopt(deployBot, "Deploy Bot", "deploy_bot", { description: "Theo dõi pipeline và đẩy bản phát hành.", owned: false });
		renderMessaging(demo.fixture, "/b/deploy_bot?start=release-241");
		const dialog = await screen.findByRole("dialog", { name: "Mở Deploy Bot" }, LONG);
		expect(within(dialog).getByText("Gửi /start release-241 cho Deploy Bot?")).toBeTruthy();
		expect(within(dialog).getByText("Theo dõi pipeline và đẩy bản phát hành.")).toBeTruthy();
		// The first answer is lost: pressing again repeats the same request, not a second /start.
		fake.loseNextStartAnswer = true;
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi /start release-241" }));
		await waitFor(() => expect(toastText()).toBe("Không thực hiện được, thử lại sau ít phút."));
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi /start release-241" }));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${demo.ids.bot}`), LONG);
		expect(fake.calls.filter((call) => call === `StartBot ${deployBot} release-241`)).toHaveLength(2);
		expect(new Set(fake.startRandomIds).size).toBe(1);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("/start release-241", {}, LONG)).toBeTruthy();
		expect(within(log).getAllByText("/start release-241")).toHaveLength(1);
	});

	it("a bot link opened again in place with another start parameter shows that one", async () => {
		const demo = seedDemo();
		demo.fixture.bots.adopt(demo.ids.users.deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		renderMessaging(demo.fixture, "/b/deploy_bot?start=release-241");
		expect(await screen.findByRole("button", { name: "Gửi /start release-241" }, LONG)).toBeTruthy();
		act(() => navigate("/b/deploy_bot?start=release-242"));
		expect(await screen.findByRole("button", { name: "Gửi /start release-242" }, LONG)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Gửi /start release-241" })).toBeNull();
	});

	it("cancelling a bot link sends nothing", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.bots;
		fake.adopt(demo.ids.users.deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		renderMessaging(demo.fixture, "/b/deploy_bot");
		const dialog = await screen.findByRole("dialog", { name: "Mở Deploy Bot" }, LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
		await waitFor(() => expect(window.location.pathname).toBe("/"));
		expect(toastText()).toBe("Đã huỷ, không gửi gì cho bot");
		expect(fake.calls.some((call) => call.startsWith("StartBot"))).toBe(false);
	});

	it("shows the bot's profile and Bắt đầu in a chat not started yet, then the composer", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = f.bots.seed("Trực ca Bot", "oncall_bot", { description: "Cho biết ai đang trực ca.", owned: false });
		f.bots.setCommands(botId, BotCommandScope.PRIVATE, [{ command: "ca", description: "Ai đang trực ca này" }]);
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, botId]);
		renderMessaging(f, `/c/${chat}`);
		const start = await screen.findByRole("button", { name: "Bắt đầu" }, LONG);
		expect(screen.getByText("Gửi /start cho Trực ca Bot")).toBeTruthy();
		expect(await screen.findByText("Cho biết ai đang trực ca.", {}, LONG)).toBeTruthy();
		expect(screen.getByText("/ca")).toBeTruthy();
		expect(screen.getByText(/Trực ca Bot chưa thể nhắn cho bạn/)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: /^Tin nhắn tới/ })).toBeNull();
		// The header names the bot by username.
		expect(screen.getByText("@oncall_bot · bot")).toBeTruthy();
		await userEvent.click(start);
		expect(await screen.findByRole("textbox", { name: /^Tin nhắn tới/ }, LONG)).toBeTruthy();
		expect(f.bots.calls).toContain(`StartBot ${botId} `);
	});

	it("tells the owner their bot is not running and links to Developer Console, and hides an empty group count", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = f.bots.seed("Báo cáo Bot", "report_daily_bot", { tokenSecret: "s", tokenIssuedAt: f.bots.now });
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, botId]);
		f.send(f.selfId, chat, "/start");
		renderMessaging(f, `/c/${chat}`);
		const banner = (await screen.findByText("Bot chưa chạy — chưa có chương trình nào nhận tin.", {}, LONG)).closest(".banner") as HTMLElement;
		expect(within(banner).getByRole("link", { name: "Xem hướng dẫn" }).getAttribute("href")).toBe(`/console/${botId}/token`);

		const info = await screen.findByRole("complementary", { name: "Thông tin bot" }, LONG);
		const manage = await within(info).findByRole("link", { name: /Quản lý bot/ }, LONG);
		expect(manage.getAttribute("href")).toBe(`/console/${botId}`);
		await waitFor(() => expect(f.bots.calls.filter((call) => call === `GetBotInfo ${botId}`).length).toBeGreaterThan(0));
		expect(within(info).queryByText(/Có trong 0 nhóm/)).toBeNull();
	});

	it("shows no banner for a running bot, and neither banner nor Quản lý bot to someone else", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const running = f.bots.seed("Trực ca Bot", "oncall_bot", { lastUpdateAt: Math.floor(Date.now() / 1000) - 20 });
		const runningChat = f.createChat(ChatType.PRIVATE, "", [f.selfId, running]);
		f.send(f.selfId, runningChat, "/start");
		const theirs = f.bots.seed("Thời tiết Bot", "weather_bot", { owned: false });
		const theirChat = f.createChat(ChatType.PRIVATE, "", [f.selfId, theirs]);
		f.send(f.selfId, theirChat, "/start");

		renderMessaging(f, `/c/${runningChat}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin bot" }, LONG);
		expect(await within(info).findByRole("link", { name: /Quản lý bot/ }, LONG)).toBeTruthy();
		expect(screen.queryByText(/Bot chưa chạy/)).toBeNull();

		act(() => navigate(`/c/${theirChat}`));
		await screen.findByText("@weather_bot · bot", {}, LONG);
		await waitFor(() => expect(f.bots.calls).toContain(`GetBotInfo ${theirs}`));
		await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
		expect(screen.queryByText(/Bot chưa chạy/)).toBeNull();
		expect(screen.queryByRole("link", { name: /Quản lý bot/ })).toBeNull();
	});

	it("presses callback buttons: waits for the bot, shows its answer, a dialog, or that it is not responding", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { deployBot } = demo.ids.users;
		f.bots.adopt(deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		const seq = f.send(deployBot, demo.ids.bot, "Bản 2.4.1 đã lên staging. Đẩy lên production không?", {
			replyMarkup: {
				kind: {
					case: "inlineKeyboard",
					value: {
						rows: [
							{
								buttons: [
									{ text: "Lên production", action: { case: "callbackData", value: utf8.encode("deploy:prod") } },
									{ text: "Hoãn", action: { case: "callbackData", value: utf8.encode("later") } },
								],
							},
							{ buttons: [{ text: "Xem changelog", action: { case: "url", value: "https://gitlab.example.com/r/2.4.1" } }] },
						],
					},
				},
			},
		});
		let release: () => void = () => undefined;
		f.bots.holdPress = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.bots.answers.push({ text: "Đã xếp hàng deploy 2.4.1" }, { text: "Bạn chắc chưa?", showAlert: true }, { timedOut: true });
		renderMessaging(f, `/c/${demo.ids.bot}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const deploy = await within(log).findByRole("button", { name: "Lên production" }, LONG);
		expect(within(log).getByRole("link", { name: /Xem changelog/ })).toBeTruthy();

		await userEvent.click(deploy);
		const waiting = await within(log).findByRole("button", { name: /Lên production/ });
		await waitFor(() => expect(waiting.getAttribute("aria-busy")).toBe("true"));
		expect(within(log).getByText("Đang chờ bot")).toBeTruthy();
		// The other buttons stay usable while one waits.
		expect(within(log).getByRole("button", { name: "Hoãn" }).getAttribute("aria-busy")).toBe("false");
		await act(async () => {
			release();
			await Promise.resolve();
		});
		await waitFor(() => expect(toastText()).toBe("Đã xếp hàng deploy 2.4.1"));
		await waitFor(() => expect(within(log).getByRole("button", { name: "Lên production" }).getAttribute("aria-busy")).toBe("false"));
		expect(f.bots.presses[0]).toEqual({ chatId: demo.ids.bot, seq, data: "deploy:prod" });

		f.bots.holdPress = null;
		await userEvent.click(within(log).getByRole("button", { name: "Hoãn" }));
		const alert = await screen.findByRole("dialog", { name: "Deploy Bot" }, LONG);
		expect(within(alert).getByText("Bạn chắc chưa?")).toBeTruthy();
		await userEvent.click(within(alert).getByRole("button", { name: "Đã hiểu" }));

		await userEvent.click(within(log).getByRole("button", { name: "Hoãn" }));
		await waitFor(() => expect(toastText()).toBe("Bot không phản hồi"));
	});

	it("shows the bot's reply keyboard, sends a key as the user's message, and hides a one-time keyboard", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { deployBot } = demo.ids.users;
		f.bots.adopt(deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		f.send(deployBot, demo.ids.bot, "Chọn môi trường cần xem trạng thái.", {
			replyMarkup: {
				kind: {
					case: "keyboard",
					value: { rows: [{ buttons: [{ text: "staging" }, { text: "production" }] }, { buttons: [{ text: "Huỷ" }] }], oneTime: true, placeholder: "Chọn môi trường" },
				},
			},
		});
		renderMessaging(f, `/c/${demo.ids.bot}`);
		const pad = await screen.findByRole("group", { name: "Bàn phím của Deploy Bot" }, LONG);
		expect(screen.getByPlaceholderText("Chọn môi trường")).toBeTruthy();
		const toggle = screen.getByRole("button", { name: "Ẩn bàn phím của bot" });
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(within(pad).getByRole("button", { name: "staging" }));
		await waitFor(() => expect(f.sent.map((s) => s.text)).toContain("staging"));
		// One-time: hidden after the tap, the toggle brings it back.
		await waitFor(() => expect(screen.queryByRole("group", { name: "Bàn phím của Deploy Bot" })).toBeNull());
		await userEvent.click(screen.getByRole("button", { name: "Hiện bàn phím của bot" }));
		expect(await screen.findByRole("group", { name: "Bàn phím của Deploy Bot" })).toBeTruthy();
		// The bot removes it.
		f.send(deployBot, demo.ids.bot, "Đã xong.", { replyMarkup: { kind: { case: "remove", value: {} } } });
		await waitFor(() => expect(screen.queryByRole("group", { name: "Bàn phím của Deploy Bot" })).toBeNull(), LONG);
		expect(screen.queryByRole("button", { name: /bàn phím của bot/ })).toBeNull();
	});

	it("opens the command menu with / and sends the picked command", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { deployBot } = demo.ids.users;
		f.bots.adopt(deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		f.bots.setCommands(deployBot, BotCommandScope.PRIVATE, [
			{ command: "status", description: "Trạng thái pipeline" },
			{ command: "deploy", description: "Đẩy một bản lên môi trường" },
		]);
		renderMessaging(f, `/c/${demo.ids.bot}`);
		const box = await screen.findByRole("textbox", { name: /^Tin nhắn tới/ }, LONG);
		await screen.findByRole("button", { name: "Lệnh của bot" }, LONG);
		await userEvent.type(box, "/");
		const list = await screen.findByRole("listbox", { name: "Lệnh của bot" });
		expect(within(list).getAllByRole("option")).toHaveLength(2);
		await userEvent.type(box, "de");
		expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["/deployĐẩy một bản lên môi trường"]);
		await userEvent.keyboard("{Enter}");
		await waitFor(() => expect(f.sent.map((s) => s.text)).toContain("/deploy"));
		expect((box as HTMLTextAreaElement).value).toBe("");
		// The menu button opens every command.
		await userEvent.click(screen.getByRole("button", { name: "Lệnh của bot" }));
		expect(within(await screen.findByRole("listbox", { name: "Lệnh của bot" })).getAllByRole("option")).toHaveLength(2);
		await userEvent.click(screen.getByRole("option", { name: /\/status/ }));
		expect((box as HTMLTextAreaElement).value).toBe("/status ");
	});

	it("gives up on a press the server leaves unanswered for 15 seconds, and opens this app's links from an answer in place", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { deployBot } = demo.ids.users;
		f.bots.adopt(deployBot, "Deploy Bot", "deploy_bot", { owned: false });
		f.send(deployBot, demo.ids.bot, "Xem nhóm vận hành?", {
			replyMarkup: {
				kind: {
					case: "inlineKeyboard",
					value: { rows: [{ buttons: [{ text: "Mở nhóm", action: { case: "callbackData", value: utf8.encode("open") } }] }] },
				},
			},
		});
		// A connection that stalls: the server never answers.
		f.bots.holdPress = new Promise<void>(() => undefined);
		renderMessaging(f, `/c/${demo.ids.bot}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const button = await within(log).findByRole("button", { name: "Mở nhóm" }, LONG);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
		try {
			await userEvent.click(button);
			await waitFor(() => expect(within(log).getByRole("button", { name: /Mở nhóm/ }).getAttribute("aria-busy")).toBe("true"));
			await act(async () => {
				vi.advanceTimersByTime(14_000);
				await Promise.resolve();
			});
			expect(within(log).getByText("Đang chờ bot")).toBeTruthy();
			await act(async () => {
				vi.advanceTimersByTime(1_000);
				await Promise.resolve();
			});
			await waitFor(() => expect(toastText()).toBe("Bot không phản hồi"));
			await waitFor(() => expect(within(log).getByRole("button", { name: "Mở nhóm" }).getAttribute("aria-busy")).toBe("false"));
		} finally {
			vi.useRealTimers();
		}

		// The bot answers with a page of this app: it opens in place (no new tab to block).
		f.bots.holdPress = null;
		f.bots.answers.push({ url: `${window.location.origin}/c/${demo.ids.ops}` });
		const opened = vi.spyOn(window, "open");
		try {
			await userEvent.click(within(log).getByRole("button", { name: "Mở nhóm" }));
			await waitFor(() => expect(window.location.pathname).toBe(`/c/${demo.ids.ops}`), LONG);
			expect(opened).not.toHaveBeenCalled();
		} finally {
			opened.mockRestore();
		}
	});

	it("keeps the bot's newest reply keyboard after a jump to an older message", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = f.bots.seed("Trực ca Bot", "oncall_bot", { owned: false });
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, botId]);
		const keyboard = (label: string) => ({ replyMarkup: { kind: { case: "keyboard" as const, value: { rows: [{ buttons: [{ text: label }] }] } } } });
		const old = f.send(botId, chat, "Chọn ca", keyboard("Ca cũ"));
		f.server.pin(chat, old, true);
		for (let i = 0; i < 200; i++) f.send(botId, chat, `Nhật ký ${i}`);
		const last = f.send(botId, chat, "Chọn ca mới", keyboard("Ca mới"));
		f.server.readHistory(f.selfId, chat, last);
		renderMessaging(f, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const pad = () => screen.findByRole("group", { name: "Bàn phím của Trực ca Bot" }, LONG);
		expect(within(await pad()).getByRole("button", { name: "Ca mới" })).toBeTruthy();
		// The pinned bar jumps to the old message: only that part of the chat is loaded now.
		await userEvent.click(await screen.findByRole("button", { name: "Nhảy tới tin ghim" }, LONG));
		expect(await within(log).findByText("Chọn ca", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(within(log).queryByText("Chọn ca mới")).toBeNull(), LONG);
		expect(within(await pad()).getByRole("button", { name: "Ca mới" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Ca cũ" })).toBeNull();
	});

	it("keeps the bot's reply keyboard when its message is far above what is loaded", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = f.bots.seed("Trực ca Bot", "oncall_bot", { owned: false });
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, botId]);
		f.send(botId, chat, "Chọn ca", { replyMarkup: { kind: { case: "keyboard", value: { rows: [{ buttons: [{ text: "Ca sáng" }] }] } } } });
		let last = 0;
		for (let i = 0; i < 200; i++) last = f.send(botId, chat, `Nhật ký ${i}`);
		f.server.readHistory(f.selfId, chat, last);
		renderMessaging(f, `/c/${chat}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Nhật ký 199", {}, LONG)).toBeTruthy();
		expect(within(log).queryByText("Chọn ca")).toBeNull();
		const pad = await screen.findByRole("group", { name: "Bàn phím của Trực ca Bot" }, LONG);
		expect(within(pad).getByRole("button", { name: "Ca sáng" })).toBeTruthy();
	});

	it("tags bots by name in group messages", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.send(demo.ids.users.deployBot, demo.ids.ops, "production: 2.4.0-hotfix.2, staging: 2.4.1.");
		renderMessaging(f, `/c/${demo.ids.ops}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const message = (await within(log).findByText(/production: 2\.4\.0-hotfix\.2/, {}, LONG)).closest(".msg") as HTMLElement;
		expect(within(message).getByText("bot").className).toBe("tag");
	});
});

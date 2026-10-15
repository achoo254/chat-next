// The official assistant bot: a brand-new account (Giang) finds the
// assistant's chat right under "Cloud của tôi", empty, with the bot's
// profile and "Bắt đầu". Only after Giang starts it does the bot greet, with
// its buttons; Giang asks to send feedback and writes it, and the bot
// thanks. The operator (Chi, in CHAT_OPERATOR_USER_IDS of the e2e stack)
// sees it under Kiểm duyệt > Góp ý, answers through the bot, and Giang gets
// the answer in the assistant chat.
import { readFileSync } from "node:fs";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { composer, launch, message, scenario, send, signIn, WEB_ORIGIN, type Person } from "./people.ts";

const brand = JSON.parse(readFileSync(new URL("../../../../brand.config.json", import.meta.url), "utf8")) as { shortName: string };
const ASSISTANT = `${brand.shortName} Trợ lý`;
const FEEDBACK = "Cho mình chế độ tối tự bật theo giờ nhé";
const ANSWER = "Đã có trong kế hoạch tháng sau, cảm ơn bạn!";

let browser: Browser;
let giang: Person;
let chi: Person;

before(async () => {
	browser = await launch();
	giang = await signIn(browser, "giang");
	chi = await signIn(browser, "chi");
});
after(async () => {
	await browser.close();
});

scenario("a new account starts the assistant, gets the greeting and sends feedback", () => [giang], async () => {
	const list = giang.page.getByRole("list", { name: "Danh sách chat" });
	const rows = list.getByRole("link");
	await rows.nth(1).filter({ hasText: ASSISTANT }).waitFor();
	await rows.nth(0).filter({ hasText: "Cloud của tôi" }).waitFor();
	// No message yet, and the team invite stays: the assistant does not count as a chat with people.
	await giang.page.getByText("Mời đồng đội vào cùng").waitFor();

	await rows.nth(1).click();
	await giang.page.getByRole("button", { name: "Bắt đầu", exact: true }).click();
	const welcome = message(giang, "Chào mừng bạn đến với");
	await welcome.waitFor();
	for (const name of ["Hướng dẫn nhanh", "Gửi góp ý", "Báo lỗi"]) await welcome.getByRole("button", { name }).waitFor();

	await welcome.getByRole("button", { name: "Gửi góp ý" }).click();
	await message(giang, "Bạn muốn góp ý điều gì?").waitFor();
	await composer(giang).waitFor();
	await send(giang, FEEDBACK);
	await message(giang, "Cảm ơn bạn! Đội ngũ đã nhận được góp ý.").waitFor();
});

scenario("the operator sees the feedback and answers through the assistant", () => [chi, giang], async () => {
	await chi.page.goto(WEB_ORIGIN + "/settings/profile");
	await chi.page.getByRole("link", { name: "Kiểm duyệt" }).click();
	await chi.page.getByRole("link", { name: "Góp ý" }).click();
	const item = chi.page.locator(".fb-item", { hasText: FEEDBACK });
	await item.getByText("Giang", { exact: true }).waitFor();
	await item.getByText("Góp ý", { exact: true }).waitFor();
	await item.getByRole("button", { name: "Trả lời" }).click();
	const dialog = chi.page.getByRole("dialog", { name: "Trả lời Giang" });
	await dialog.getByRole("textbox", { name: /Câu trả lời/ }).fill(ANSWER);
	await dialog.getByRole("button", { name: "Gửi trả lời" }).click();
	await chi.page.getByText("Đã gửi trả lời qua bot Trợ lý").waitFor();
	await chi.page.getByRole("tab", { name: "Đã xử lý" }).click();
	await chi.page.locator(".fb-item", { hasText: FEEDBACK }).getByText(ANSWER).waitFor();

	const answer = message(giang, ANSWER);
	await answer.waitFor();
	await answer.getByText(/Phản hồi từ đội ngũ/).waitFor();
});

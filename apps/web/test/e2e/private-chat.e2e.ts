// Two people in a private chat: delivery in real time, unread and read
// state, notification, reply, edit, reaction, pin and recall, each checked
// on the other person's screen.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { composer, launch, message, messageMenu, openChat, scenario, send, signIn, startPrivateChat, WEB_ORIGIN, type Person } from "./people.ts";

let browser: Browser;
let an: Person;
let binh: Person;

before(async () => {
	browser = await launch();
	binh = await signIn(browser, "binh");
	an = await signIn(browser, "an");
});
after(async () => {
	await browser.close();
});

scenario("a message reaches the other person at once, with a notification and read receipts", () => [an, binh], async () => {
	await startPrivateChat(an, "binh");
	await send(an, "Chào Bình, mình test chat riêng");

	const row = binh.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link", { name: /An/ });
	await row.filter({ hasText: "Chào Bình, mình test chat riêng" }).waitFor();
	await row.locator(".badge", { hasText: "1" }).waitFor();
	await binh.page.waitForFunction(() => (window as unknown as { __e2eNotifications: unknown[] }).__e2eNotifications.length > 0);
	const [shown] = await binh.notifications();
	assert.equal(shown?.title, "An");
	assert.match(shown?.body ?? "", /Chào Bình, mình test chat riêng/);

	await openChat(binh, "An");
	await message(binh, "Chào Bình, mình test chat riêng").waitFor();
	await message(an, "Chào Bình, mình test chat riêng").getByRole("img", { name: "Đã xem" }).waitFor();
});

scenario("reply, edit and reaction show on the other side", () => [an, binh], async () => {
	const reply = await messageMenu(binh, "Chào Bình, mình test chat riêng");
	await reply.getByRole("menuitem", { name: "Trả lời" }).click();
	await send(binh, "Chào An, nhận được rồi");
	await message(an, "Chào An, nhận được rồi").filter({ hasText: "Chào Bình, mình test chat riêng" }).waitFor();

	const edit = await messageMenu(an, "Chào Bình, mình test chat riêng");
	await edit.getByRole("menuitem", { name: "Sửa" }).click();
	const box = composer(an);
	await box.fill("Chào Bình, tin này đã được sửa");
	await box.press("Enter");
	await message(binh, "Chào Bình, tin này đã được sửa").filter({ hasText: "đã sửa" }).waitFor();

	await messageMenu(an, "Chào An, nhận được rồi");
	await an.page.getByRole("group", { name: "Thả cảm xúc" }).getByRole("button", { name: "Thích", exact: true }).click();
	await message(binh, "Chào An, nhận được rồi").getByRole("button", { name: /👍 1 người/ }).waitFor();
});

scenario("pin and recall reach the other side", () => [an, binh], async () => {
	const pin = await messageMenu(binh, "Chào An, nhận được rồi");
	await pin.getByRole("menuitem", { name: "Ghim" }).click();
	await an.page.locator(".pinned", { hasText: "Chào An, nhận được rồi" }).first().waitFor();

	await send(an, "Tin này sẽ bị thu hồi");
	await message(binh, "Tin này sẽ bị thu hồi").waitFor();
	const recall = await messageMenu(an, "Tin này sẽ bị thu hồi");
	await recall.getByRole("menuitem", { name: "Thu hồi" }).click();
	await an.page.getByRole("dialog", { name: "Thu hồi tin nhắn?" }).getByRole("button", { name: "Thu hồi" }).click();
	await binh.page.getByRole("log", { name: "Tin nhắn" }).getByText("Tin này sẽ bị thu hồi").waitFor({ state: "detached" });
	await binh.page.getByRole("log", { name: "Tin nhắn" }).getByText("Tin nhắn đã thu hồi").last().waitFor();
});

scenario("a link to a chat that does not exist says so without hammering the server", () => [an], async () => {
	let historyCalls = 0;
	const count = (request: { url(): string }) => {
		if (request.url().includes("/rpc/app.v1.MessagesService/GetHistory")) historyCalls++;
	};
	an.page.on("request", count);
	await an.page.goto(WEB_ORIGIN + "/c/987654321");
	await an.page.getByText("Không mở được chat này").waitFor();
	await an.page.waitForTimeout(3000);
	an.page.off("request", count);
	assert.ok(historyCalls <= 3, `GetHistory was called ${historyCalls} times in 3 s`);
});

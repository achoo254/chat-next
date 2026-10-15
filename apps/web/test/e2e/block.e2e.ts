// Blocking in a private chat: the blocked person's message is refused and
// never reaches the person who blocked; unblocking lets messages through.
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { launch, message, openChat, scenario, send, signIn, startPrivateChat, type Person } from "./people.ts";

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

/** Opens the private chat's info column when it is closed. */
async function chatInfo(person: Person, peerName: string) {
	const info = person.page.getByRole("complementary", { name: new RegExp(peerName) });
	if (!(await info.isVisible())) await person.page.getByRole("button", { name: "Thông tin chat" }).click();
	await info.waitFor();
	return info;
}

scenario("a blocked person's message is refused and never delivered", () => [an, binh], async () => {
	await startPrivateChat(an, "binh");
	await send(an, "Tin trước khi bị chặn");
	await openChat(binh, "An");
	await message(binh, "Tin trước khi bị chặn").waitFor();

	await (await chatInfo(binh, "")).getByRole("button", { name: "Chặn", exact: true }).click();
	await binh.page.getByText("Đã chặn An").waitFor();

	const box = an.page.getByRole("textbox", { name: /^Tin nhắn tới / });
	await box.fill("Tin sau khi bị chặn");
	await box.press("Enter");
	await message(an, "Tin sau khi bị chặn").getByRole("img", { name: "Chưa gửi được" }).waitFor();
	await binh.page.waitForTimeout(1500);
	if ((await binh.page.getByText("Tin sau khi bị chặn").count()) !== 0) throw new Error("the blocked message reached Bình");
});

scenario("after unblocking, messages go through again", () => [an, binh], async () => {
	await (await chatInfo(binh, "")).getByRole("button", { name: "Bỏ chặn" }).click();
	await send(an, "Tin sau khi được bỏ chặn");
	await message(binh, "Tin sau khi được bỏ chặn").waitFor();
});

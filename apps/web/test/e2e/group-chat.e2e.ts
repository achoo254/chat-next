// Three people in a group: create it, invite by link, real-time delivery to
// every member, a pinned announcement, and removing a member.
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { composer, launch, message, messageMenu, scenario, send, signIn, WEB_ORIGIN, type Person } from "./people.ts";

const GROUP = "Đội Vận hành E2E";
let browser: Browser;
let an: Person;
let binh: Person;
let chi: Person;

before(async () => {
	browser = await launch();
	binh = await signIn(browser, "binh");
	chi = await signIn(browser, "chi");
	an = await signIn(browser, "an");
});
after(async () => {
	await browser.close();
});

/** Opens the group's info column when it is closed. */
async function groupInfo(person: Person) {
	const info = person.page.getByRole("complementary", { name: "Thông tin nhóm" });
	if (!(await info.isVisible())) await person.page.getByRole("button", { name: "Thông tin chat" }).click();
	await info.waitFor();
	return info;
}

scenario("Bình's privacy keeps An from adding him directly", () => [an, binh], async () => {
	// Default "who can add me to groups" is My contacts, and Bình has not saved An.
	await an.page.getByRole("button", { name: "Tạo chat mới" }).first().click();
	await an.page.getByRole("dialog", { name: "Chat mới" }).getByRole("button", { name: "Tạo nhóm" }).click();
	const dialog = an.page.getByRole("dialog", { name: "Tạo nhóm" });
	await dialog.getByLabel(/Tên nhóm/).fill(GROUP);
	await dialog.getByPlaceholder("Nhập tên, username hoặc email").fill("binh");
	await dialog.getByRole("checkbox", { name: /Bình/ }).click();
	await dialog.getByRole("button", { name: /^Tạo nhóm · / }).click();
	const refused = an.page.getByRole("dialog", { name: "Chưa thêm được 1 người" });
	await refused.getByText("Cài đặt riêng tư của Bình không cho bạn thêm vào nhóm").waitFor();
	await an.page.keyboard.press("Escape");
	await refused.waitFor({ state: "detached" });
	await send(an, "Chào cả nhóm");
});

scenario("Bình and Chi join with the invite link and get messages in real time", () => [an, binh, chi], async () => {
	const info = await groupInfo(an);
	await info.getByRole("button", { name: "Tạo link mời" }).click();
	const shown = await info.locator(".mid-trunc[title]").first().getAttribute("title");
	const invitePath = new URL(shown?.startsWith("http") ? shown : `http://${shown}`).pathname;

	for (const person of [binh, chi]) {
		await person.page.goto(WEB_ORIGIN + invitePath);
		await person.page.getByRole("dialog", { name: GROUP }).getByRole("button", { name: "Tham gia nhóm" }).click();
		await composer(person).waitFor();
		await message(person, "Chào cả nhóm").waitFor();
	}

	await send(binh, "Chào An, chào Chi");
	await message(chi, "Chào An, chào Chi").waitFor();
	await message(an, "Chào An, chào Chi").waitFor();
});

scenario("a pinned announcement shows for every member", () => [an, binh, chi], async () => {
	await send(an, "Lịch trực tuần này: Bình trực chính");
	const menu = await messageMenu(an, "Lịch trực tuần này: Bình trực chính");
	await menu.getByRole("menuitem", { name: "Ghim" }).click();
	await an.page.getByRole("dialog", { name: "Ghim tin này?" }).getByRole("button", { name: "Ghim", exact: true }).click();
	for (const person of [binh, chi]) {
		await person.page.locator(".pinned", { hasText: "Lịch trực tuần này" }).first().waitFor();
	}
});

scenario("a removed member stops receiving the group's messages", () => [an, binh, chi], async () => {
	const info = await groupInfo(an);
	await info.getByRole("button", { name: /^Xem tất cả \d+ thành viên/ }).click();
	const members = an.page.getByRole("dialog", { name: /^Thành viên/ });
	await members.getByRole("button", { name: "Thao tác với Chi" }).click();
	await an.page.getByRole("menuitem", { name: "Xoá khỏi nhóm" }).click();
	await an.page.getByRole("dialog", { name: "Xoá Chi khỏi nhóm?" }).getByRole("button", { name: /^Chỉ xoá/ }).click();
	await members.getByText("Chi", { exact: true }).waitFor({ state: "detached" });
	await members.getByRole("button", { name: "Đóng" }).click();
	await members.waitFor({ state: "detached" });
	await chi.page.getByText(/^Bạn (không còn là thành viên|đã bị xoá khỏi nhóm)/).first().waitFor();

	await send(an, "Tin sau khi Chi rời nhóm");
	await message(binh, "Tin sau khi Chi rời nhóm").waitFor();
	await chi.page.waitForTimeout(1500);
	if ((await chi.page.getByText("Tin sau khi Chi rời nhóm").count()) !== 0) {
		throw new Error("Chi still received a message after being removed");
	}
});

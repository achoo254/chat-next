// A new account (#first-run): "Cloud của tôi" is there, pinned, on every
// device; the empty list invites the team with a group link; any message
// can be saved to the cloud.
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { composer, launch, message, messageMenu, openChat, scenario, send, signIn, WEB_ORIGIN, type Person } from "./people.ts";

const CLOUD = "Cloud của tôi";
const GROUP = "Đội Mới";
let browser: Browser;
let dung: Person;
let dungPhone: Person;
let binh: Person;

before(async () => {
	browser = await launch();
	dung = await signIn(browser, "dung");
	dungPhone = await signIn(browser, "dung");
	binh = await signIn(browser, "binh");
});
after(async () => {
	await browser.close();
});

function chatList(person: Person) {
	return person.page.getByRole("list", { name: "Danh sách chat" });
}

scenario("a new account has Cloud của tôi pinned and an invite to bring the team", () => [dung], async () => {
	const row = chatList(dung).getByRole("link", { name: new RegExp(CLOUD) });
	await row.waitFor();
	await row.getByRole("img", { name: "Đã ghim" }).waitFor();
	await dung.page.getByText("Mời đồng đội vào cùng").waitFor();
});

scenario("a note in Cloud của tôi shows on the other device", () => [dung, dungPhone], async () => {
	await openChat(dung, CLOUD);
	await dung.page.getByText("Chỉ mình bạn thấy · đồng bộ mọi máy").first().waitFor();
	await send(dung, "Ghi chú: đổi mật khẩu VPN");
	await openChat(dungPhone, CLOUD);
	await message(dungPhone, "Ghi chú: đổi mật khẩu VPN").waitFor();
});

scenario("a group created with nobody gives an invite link that brings Bình in", () => [dung, binh], async () => {
	await dung.page.getByRole("button", { name: "Tạo nhóm và mời" }).click();
	const dialog = dung.page.getByRole("dialog", { name: "Tạo nhóm" });
	await dialog.getByLabel(/Tên nhóm/).fill(GROUP);
	await dialog.getByRole("button", { name: "Tạo nhóm", exact: true }).click();
	const invite = dung.page.getByRole("dialog", { name: `Mời đồng đội vào ${GROUP}` });
	const shown = await invite.locator(".mid-trunc[title]").first().getAttribute("title");
	const path = new URL(shown?.startsWith("http") ? shown : `http://${shown}`).pathname;
	await invite.getByRole("button", { name: "Đóng" }).click();
	await dung.page.getByText("Mời đồng đội vào cùng").waitFor({ state: "detached" });

	await binh.page.goto(WEB_ORIGIN + path);
	await binh.page.getByRole("dialog", { name: GROUP }).getByRole("button", { name: "Tham gia nhóm" }).click();
	await composer(binh).waitFor();
	await send(binh, "Bình đây, vào nhóm rồi");
	await message(dung, "Bình đây, vào nhóm rồi").waitFor();
});

scenario("any message can be saved to Cloud của tôi", () => [dung, dungPhone], async () => {
	const menu = await messageMenu(dung, "Bình đây, vào nhóm rồi");
	await menu.getByRole("menuitem", { name: "Lưu vào Cloud của tôi" }).click();
	await dung.page.getByText("Đã lưu vào Cloud của tôi").waitFor();
	await message(dungPhone, "Bình đây, vào nhóm rồi").filter({ hasText: "Chuyển tiếp từ" }).waitFor();
});

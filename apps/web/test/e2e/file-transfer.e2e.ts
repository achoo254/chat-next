// A file sent in a private chat arrives on the other side and downloads
// with the same bytes (media stored by the api on the server's disk).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before } from "node:test";
import type { Browser } from "playwright";
import { composer, launch, messages, openChat, scenario, signIn, startPrivateChat, type Person } from "./people.ts";

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

scenario("a file reaches the other person and downloads unchanged", () => [an, binh], async () => {
	const content = Buffer.from("Báo cáo trực tuần 15/10\n" + "x".repeat(200_000), "utf8");
	await startPrivateChat(an, "binh");
	await an.page.getByTestId("pick-files").setInputFiles({ name: "bao-cao-truc.txt", mimeType: "text/plain", buffer: content });
	await an.page.getByRole("group", { name: "File sắp gửi" }).getByText("bao-cao-truc.txt").waitFor();
	await composer(an).press("Enter");
	await messages(an).getByRole("button", { name: "Tải xuống bao-cao-truc.txt" }).waitFor();

	await openChat(binh, "An");
	const download = binh.page.waitForEvent("download");
	await messages(binh).getByRole("button", { name: "Tải xuống bao-cao-truc.txt" }).click();
	const file = await (await download).path();
	assert.deepEqual(await readFile(file), content);
});

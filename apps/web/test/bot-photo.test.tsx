// A bot's photo (mockups/console.html#bot-photo): chosen and removed on the
// Console's Profile tab, shown on the bot's avatars through the real client
// core (downloads in the user_photo_of context). Cropping and saving draw
// on a canvas, which jsdom lacks; they are checked in the browser.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function file(name: string, type: string, bytes: number): File {
	return new File([new Uint8Array(bytes)], name, { type });
}

describe("bot photo", () => {
	it("refuses files that are not a small enough picture before any crop", async () => {
		const demo = seedDemo();
		demo.fixture.enableMedia();
		const botId = demo.fixture.bots.seed("Báo cáo Bot", "bao_cao_bot");
		renderMessaging(demo.fixture, `/console/${botId}`);
		const form = await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		expect(within(form).getByRole("button", { name: "Chọn ảnh" })).toBeTruthy();
		const input = screen.getByTestId("pick-bot-photo");
		await userEvent.upload(input, file("ghi-chu.txt", "text/plain", 10), { applyAccept: false });
		expect(await within(form).findByRole("alert")).toHaveProperty("textContent", "Chọn một ảnh JPEG, PNG hoặc WebP.");
		await userEvent.upload(input, file("lon.jpg", "image/jpeg", 5 * 1024 * 1024 + 1));
		expect(await within(form).findByText("Ảnh lớn hơn 5 MB.")).toBeTruthy();
		expect(screen.queryByRole("dialog", { name: "Cắt ảnh" })).toBeNull();
	});

	it("shows on the bot's avatars and is removed after one confirm", async () => {
		const demo = seedDemo();
		const media = demo.fixture.enableMedia();
		const { deployBot } = demo.ids.users;
		demo.fixture.bots.adopt(deployBot, "Deploy Bot", "deploy_bot");
		const ref = demo.fixture.addFile(deployBot, { kind: "photo", mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), sizes: ["s", "m"] });
		demo.fixture.setPhoto(deployBot, ref.fileId);
		renderMessaging(demo.fixture, `/c/${demo.ids.bot}`);
		// The chat list and the chat header draw the photo over the robot icon.
		await waitFor(() => expect(document.querySelectorAll(".avatar img.avatar-photo").length).toBeGreaterThanOrEqual(2), LONG);
		expect(media.gets.some((url) => url.includes(`/photo/${deployBot}/`))).toBe(true);

		renderMessaging(demo.fixture, `/console/${deployBot}`);
		const form = await screen.findByRole("form", { name: "Hồ sơ bot" }, LONG);
		await userEvent.click(within(form).getByRole("button", { name: "Xoá ảnh" }));
		const confirm = await screen.findByRole("dialog", { name: "Xoá ảnh của Deploy Bot?" }, LONG);
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoá ảnh" }));
		await waitFor(() => expect(demo.fixture.photos.has(deployBot)).toBe(false), LONG);
		expect(await within(form).findByRole("button", { name: "Chọn ảnh" }, LONG)).toBeTruthy();
		expect(within(form).queryByRole("button", { name: "Xoá ảnh" })).toBeNull();
	});
});

// People's, groups' and channels' photos (mockups/chat.html#edit-chat,
// settings.html#profile): shown on avatars through the real client core,
// changed from the info column's pencil and from Settings › Profile.
// Cropping draws on a canvas, which jsdom lacks; it is checked in the browser.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatType, MemberRole } from "@achoo254/chat-proto/chats";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

describe("group photo", () => {
	it("shows on the group's avatars and is changed with the name from the info column", async () => {
		const demo = seedDemo();
		const media = demo.fixture.enableMedia();
		const { ops } = demo.ids;
		const ref = demo.fixture.addFile(demo.fixture.selfId, { kind: "photo", mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]), sizes: ["s", "m"] });
		demo.fixture.setChatPhoto(ops, ref.fileId);
		renderMessaging(demo.fixture, `/c/${ops}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		// The chat list, the chat header and the info column draw it.
		await waitFor(() => expect(document.querySelectorAll(".avatar img.avatar-photo").length).toBeGreaterThanOrEqual(3), LONG);
		expect(media.gets.some((url) => url.includes(`/chatphoto/${ops}/`))).toBe(true);

		await userEvent.click(within(info).getByRole("button", { name: "Sửa tên, ảnh, mô tả nhóm" }));
		const dialog = await screen.findByRole("dialog", { name: "Sửa thông tin nhóm" }, LONG);
		const name = within(dialog).getByRole("textbox", { name: "Tên nhóm" });
		await userEvent.clear(name);
		await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
		expect(within(dialog).getByText("Nhập tên.")).toBeTruthy();
		await userEvent.type(name, "Trực vận hành");
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá ảnh" }));
		expect(within(dialog).getByText("Ảnh sẽ được xoá khi bấm Lưu.")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Chọn ảnh" })).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(demo.fixture.updatedChats).toContainEqual({ chatId: ops, forum: undefined, title: "Trực vận hành", photoFileId: "" }), LONG);
		expect(await screen.findByText("Đã lưu thông tin nhóm")).toBeTruthy();
		expect(screen.queryByRole("dialog", { name: "Sửa thông tin nhóm" })).toBeNull();
	});

	it("offers no pencil to members not allowed to change the group's info", async () => {
		const demo = seedDemo();
		const { huy } = demo.ids.users;
		const chatId = demo.fixture.createChat(ChatType.GROUP, "Nhóm đọc", [demo.fixture.selfId, huy], { myRole: MemberRole.MEMBER, myPermissions: 0x0f });
		renderMessaging(demo.fixture, `/c/${chatId}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		expect(within(info).getByRole("heading", { name: "Nhóm đọc" })).toBeTruthy();
		expect(within(info).queryByRole("button", { name: "Sửa tên, ảnh, mô tả nhóm" })).toBeNull();
	});
});

describe("people's photos", () => {
	it("shows a person's photo on their private chat", async () => {
		const demo = seedDemo();
		const media = demo.fixture.enableMedia();
		const { huy } = demo.ids.users;
		const ref = demo.fixture.addFile(huy, { kind: "photo", mimeType: "image/jpeg", bytes: new Uint8Array([4, 5, 6]), sizes: ["s", "m"] });
		demo.fixture.setPhoto(huy, ref.fileId);
		renderMessaging(demo.fixture, "/");
		await waitFor(() => expect(media.gets.some((url) => url.includes(`/photo/${huy}/`))).toBe(true), LONG);
		expect(document.querySelector(".chat-row .avatar img.avatar-photo")).not.toBeNull();
	});

	it("chooses the user's own photo on Settings › Profile", async () => {
		const demo = seedDemo();
		demo.fixture.enableMedia();
		renderMessaging(demo.fixture, "/settings/profile");
		const choose = await screen.findByRole("button", { name: "Chọn ảnh" }, LONG);
		expect(choose.getAttribute("aria-describedby")).not.toBeNull();
		await userEvent.upload(screen.getByTestId("pick-profile-photo"), new File([new Uint8Array(10)], "a.txt", { type: "text/plain" }), { applyAccept: false });
		expect(await screen.findByText("Chọn một ảnh JPEG, PNG hoặc WebP.")).toBeTruthy();
	});

	it("points the notification preview to the Notifications screen", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/privacy");
		const link = await screen.findByRole("link", { name: /Xem trước nội dung trong thông báo/ }, LONG);
		expect(link.getAttribute("href")).toBe("/settings/notifications");
		expect(screen.queryByRole("switch", { name: "Xem trước nội dung trong thông báo" })).toBeNull();
	});
});

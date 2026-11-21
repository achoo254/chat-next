// What Chat does to people and groups in the other app for one synced group, in the group's
// info panel (ADR 0024 took the per-chat settings away): invite links of the app, adding a
// person; and leaving or deleting the group, which the one leave and delete of the chat also
// do in the app, each with its own confirmations.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

async function openTools(fixture: ChatFixture): Promise<HTMLElement> {
	const other = fixture.addUser("Lan");
	const chatId = fixture.createChat(ChatType.GROUP, "Anh Đô CEO", [fixture.selfId, other], { externalApp: "telegram" });
	fixture.bridge.seedTwoWay(chatId);
	// Every feature follows the chat, two-way here.
	fixture.bridge.features = fixture.bridge.features.map((f) => ({ ...f, direction: f.canSend ? "both" : "in" }));
	renderMessaging(fixture, `/c/${chatId}`);
	const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
	return (await within(info).findByText("Người và nhóm ở ứng dụng kia", {}, LONG)).closest("[data-id=bridge-chat-tools]") as HTMLElement;
}

/** The dialog once its lazy content is in (the shell shows "Đang tải…" first): the one with the typed-name field. */
async function openedDialog(): Promise<HTMLElement> {
	return (await screen.findByLabelText(/Gõ/, {}, LONG)).closest("dialog") as HTMLElement;
}

/** The info panel of a two-way synced group, with its group tools loaded. */
async function openInfo(fixture: ChatFixture): Promise<HTMLElement> {
	await openTools(fixture);
	return screen.getByRole("complementary", { name: "Thông tin nhóm" });
}

describe("people and the group in the other app, from the info panel", () => {
	it("lists the links of the other app, and makes and revokes them", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.invites = [{ $typeName: "app.v1.BridgeInvite", link: "https://t.me/+abc", title: "Nhóm dự án", revoked: false, usage: 4 }];
		const tools = await openTools(fixture);
		expect(await within(tools).findByText(/https:\/\/t\.me\/\+abc/, {}, LONG)).toBeTruthy();
		await userEvent.type(within(tools).getByLabelText("Tên link (không bắt buộc)"), "mới");
		await userEvent.click(within(tools).getByRole("button", { name: "Tạo link" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("invite:create:mới"), LONG);
		await userEvent.click((await within(tools).findAllByRole("button", { name: "Thu hồi" }, LONG))[0] as HTMLElement);
		await waitFor(() => expect(fixture.bridge.calls).toContain("invite:revoke:https://t.me/+abc"), LONG);
	});

	it("adds a person the other app has shown", async () => {
		const fixture = new ChatFixture();
		const tools = await openTools(fixture);
		expect(await within(tools).findByText("Giang", { selector: "option" }, LONG)).toBeTruthy();
		await userEvent.selectOptions(within(tools).getByLabelText("Chọn người"), "88");
		await waitFor(() => expect((within(tools).getByRole("button", { name: "Thêm" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(within(tools).getByRole("button", { name: "Thêm" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("member:add:88"), LONG);
	});

	it("leaves the group in the other app and in Chat from the one leave button, only with the name typed again", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.chatName = "Anh Đô CEO";
		const info = await openInfo(fixture);
		// One leave and one delete in the panel, and no second pair among the group tools.
		expect(within(info).getAllByRole("button", { name: "Rời nhóm" })).toHaveLength(1);
		expect(within(info).getAllByRole("button", { name: "Xoá nhóm" })).toHaveLength(1);
		expect(within(info).queryByText(/Rời hoặc xoá nhóm/)).toBeNull();
		await userEvent.click(within(info).getByRole("button", { name: "Rời nhóm" }));
		const dialog = await openedDialog();
		expect(await within(dialog).findByText(/Cũng rời nhóm ở Telegram/, {}, LONG)).toBeTruthy();
		const leave = within(dialog).getByRole("button", { name: "Rời nhóm" }) as HTMLButtonElement;
		expect(leave.disabled).toBe(true);
		await userEvent.type(within(dialog).getByLabelText("Gõ lại tên nhóm"), "Anh Đô CEO");
		await waitFor(() => expect(leave.disabled).toBe(false), LONG);
		await userEvent.click(leave);
		await waitFor(() => expect(fixture.bridge.calls).toContain("group:leave"), LONG);
	});

	it("deletes the group in the other app after a second confirmation that waits, from the one delete button", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.chatName = "Anh Đô CEO";
		const info = await openInfo(fixture);
		await userEvent.click(within(info).getByRole("button", { name: "Xoá nhóm" }));
		const dialog = await openedDialog();
		expect(await within(dialog).findByText(/Nhóm sẽ bị xoá cho mọi người ở Telegram/, {}, LONG)).toBeTruthy();
		await userEvent.type(within(dialog).getByLabelText(/Gõ/), "Anh Đô CEO");
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá nhóm" }));
		const confirm = await within(dialog).findByRole("button", { name: /Chờ|Xoá vĩnh viễn/ }, LONG);
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		expect(fixture.bridge.calls).not.toContain("group:delete");
		await waitFor(() => expect((within(dialog).getByRole("button", { name: "Xoá vĩnh viễn" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá vĩnh viễn" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("group:delete"), LONG);
	});

	it("says a sign-in from the last 10 minutes is needed, with the link that comes back to this chat, and leaves nothing done", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.reauth = true;
		const info = await openInfo(fixture);
		await userEvent.click(within(info).getByRole("button", { name: "Xoá nhóm" }));
		const dialog = await openedDialog();
		await userEvent.type(within(dialog).getByLabelText(/Gõ/), "Anh Đô CEO");
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá nhóm" }));
		const banner = await within(dialog).findByRole("alert", {}, LONG);
		expect(within(banner).getByText("Thao tác này cần đăng nhập trong 10 phút gần đây.")).toBeTruthy();
		const href = within(banner).getByRole("link", { name: "Đăng nhập lại" }).getAttribute("href") ?? "";
		expect(href).toContain("reauth=1");
		expect(decodeURIComponent(href)).toContain("return_to=/c/");
		expect(within(dialog).queryByText("Chưa làm được, thử lại sau.")).toBeNull();
		expect(fixture.bridge.calls).not.toContain("group:delete");
	});

	it("is not shown for a chat that is not a copy", async () => {
		const fixture = new ChatFixture();
		const other = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.GROUP, "Nhóm Chat", [fixture.selfId, other]);
		renderMessaging(fixture, `/c/${chatId}`);
		await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		expect(screen.queryByText("Người và nhóm ở ứng dụng kia")).toBeNull();
		expect(fixture.bridge.calls).toEqual([]);
	});
});

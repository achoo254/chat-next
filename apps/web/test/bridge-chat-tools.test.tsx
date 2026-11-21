// What Chat does to people and groups in the other app for one synced group, in the group's
// info panel (ADR 0024 took the per-chat settings away): invite links of the app, adding a
// person, leaving and deleting the group, each with its own confirmations.
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

	it("leaves the group only with the name typed again, and deletes it only after a second confirmation that waits", async () => {
		const fixture = new ChatFixture();
		fixture.bridge.chatName = "Anh Đô CEO";
		const tools = await openTools(fixture);
		await userEvent.type(within(tools).getByLabelText("Gõ lại tên nhóm"), "sai tên");
		await userEvent.click(within(tools).getByRole("button", { name: "Rời nhóm" }));
		expect(await within(tools).findByText("Tên chưa đúng.", {}, LONG)).toBeTruthy();
		expect(fixture.bridge.calls).not.toContain("group:leave");
		await userEvent.clear(within(tools).getByLabelText("Gõ lại tên nhóm"));
		await userEvent.type(within(tools).getByLabelText("Gõ lại tên nhóm"), "Anh Đô CEO");
		await userEvent.click(within(tools).getByRole("button", { name: "Xoá nhóm cho mọi người…" }));
		const confirm = await within(tools).findByRole("button", { name: /Chờ|Xoá vĩnh viễn/ }, LONG);
		expect((confirm as HTMLButtonElement).disabled).toBe(true);
		expect(fixture.bridge.calls).not.toContain("group:delete");
		await waitFor(() => expect((within(tools).getByRole("button", { name: "Xoá vĩnh viễn" }) as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(within(tools).getByRole("button", { name: "Xoá vĩnh viễn" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain("group:delete"), LONG);
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

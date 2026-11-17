// A chat the Chat Bridge fills is a read-only copy of another app's chat: the
// server refuses every send into it, so the composer gives way to a note.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

describe("composer of a synced chat", () => {
	it("is replaced by a note that the chat is a read-only copy", async () => {
		const fixture = new ChatFixture();
		const partner = fixture.addUser("Anh Đô");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner], { externalSource: "telegram" });
		fixture.send(partner, chatId, "tin từ Telegram");
		renderMessaging(fixture, `/c/${chatId}`);
		expect((await screen.findAllByText("tin từ Telegram", {}, LONG)).length).toBeGreaterThan(0);
		expect(await screen.findByText("Đây là bản sao chỉ đọc từ Telegram: bạn không gửi tin vào đây được.", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: /Tin nhắn tới/ })).toBeNull();
	});

	it("leaves an ordinary private chat's composer alone", async () => {
		const fixture = new ChatFixture();
		const partner = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner]);
		fixture.send(partner, chatId, "chào");
		renderMessaging(fixture, `/c/${chatId}`);
		expect((await screen.findAllByText("chào", {}, LONG)).length).toBeGreaterThan(0);
		expect(await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG)).toBeTruthy();
		expect(screen.queryByText(/bản sao chỉ đọc/)).toBeNull();
	});
});

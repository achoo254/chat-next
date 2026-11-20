// The bell-off mark tells a reader that a message came without a notification. It is not
// shown to the message's own sender, who knows, nor in a copy of another app's chat, whose
// history the Chat Bridge imports silently as a whole.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const MARK = { name: "Gửi im lặng, không thông báo" };

async function bubbleOf(text: string): Promise<HTMLElement> {
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	return (await within(log).findByText(text, {}, LONG)).closest(".bubble") as HTMLElement;
}

describe("the bell-off mark of a silent message", () => {
	it("shows on somebody else's silent message, not on my own", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, chatId, "tin im lặng của Lan", { silent: true });
		fixture.send(fixture.selfId, chatId, "tin im lặng của tôi", { silent: true });
		renderMessaging(fixture, `/c/${chatId}`);

		expect(within(await bubbleOf("tin im lặng của Lan")).getByRole("img", MARK)).toBeTruthy();
		expect(within(await bubbleOf("tin im lặng của tôi")).queryByRole("img", MARK)).toBeNull();
	});

	it("does not show in a copy of a Telegram chat", async () => {
		const fixture = new ChatFixture();
		const partner = fixture.addUser("Anh Đô");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner], { externalSource: "telegram" });
		fixture.send(partner, chatId, "tin nhập từ Telegram", { silent: true });
		renderMessaging(fixture, `/c/${chatId}`);

		expect(within(await bubbleOf("tin nhập từ Telegram")).queryByRole("img", MARK)).toBeNull();
	});
});

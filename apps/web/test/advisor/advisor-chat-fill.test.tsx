// Advisor's answer about a chat message goes into the open chat's box after what is typed, for the
// user to read and send: the composer says which chat is open and takes the text once.
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { advisorStore } from "../../src/advisor/advisor-store.ts";
import { ChatFixture } from "../support/fake-chat.ts";
import { renderMessaging } from "../support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => advisorStore.forgetAll());

describe("the chat composer and Advisor's answer", () => {
	it("puts the answer in the box without sending, and names the open chat while it shows", async () => {
		const fixture = new ChatFixture();
		const partner = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner]);
		fixture.send(partner, chatId, "mai họp lúc mấy giờ?");
		renderMessaging(fixture, `/c/${chatId}`);
		const box = (await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG)) as HTMLElement;
		await waitFor(() => expect(advisorStore.snapshot().chat).toEqual({ chatId, topicId: 0 }), LONG);

		act(() => advisorStore.fillChat(chatId, 0, "Mai 9 giờ nhé."));
		await waitFor(() => expect(box.textContent || (box as HTMLTextAreaElement).value).toContain("Mai 9 giờ nhé."), LONG);
		// Taken once: nothing is left waiting (sending stays the user's).
		expect(advisorStore.snapshot().fills.size).toBe(0);
	});
});

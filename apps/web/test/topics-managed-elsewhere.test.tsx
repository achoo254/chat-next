// A forum the Chat Bridge copies from another app has its topics managed there:
// the server takes the right to manage topics away, so an admin gets no topic menu.
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatType, MemberRole } from "@achoo254/chat-proto/chats";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
// Every permission bit but "manage topics" (32): what the server sends for a copy.
const WITHOUT_MANAGE_TOPICS = 0x1f;
const WITH_MANAGE_TOPICS = 0x3f;

function forum(permissions: number): { fixture: ChatFixture; chatId: number } {
	const fixture = new ChatFixture();
	const partner = fixture.addUser("Lan");
	const chatId = fixture.createChat(ChatType.GROUP, "Diễn đàn", [fixture.selfId, partner], {
		myRole: MemberRole.OWNER,
		forum: true,
		myPermissions: permissions,
	});
	fixture.topics.set(chatId, [{ id: 1, title: "General", iconColor: 0x8e8e93, creatorId: partner, pinned: false, closed: false, hidden: false, unreadCount: 0 }]);
	fixture.send(partner, chatId, "tin trong General");
	return { fixture, chatId };
}

describe("topics of a copied forum", () => {
	it("opens no topic menu for an owner who has lost the right to manage topics", async () => {
		const { fixture, chatId } = forum(WITHOUT_MANAGE_TOPICS);
		renderMessaging(fixture, `/c/${chatId}`);
		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		fireEvent.contextMenu(within(topics).getAllByRole("button")[0] as HTMLElement);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("still opens it in an ordinary forum", async () => {
		const { fixture, chatId } = forum(WITH_MANAGE_TOPICS);
		renderMessaging(fixture, `/c/${chatId}`);
		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		fireEvent.contextMenu(within(topics).getAllByRole("button")[0] as HTMLElement);
		expect(await screen.findByRole("menu", {}, LONG)).toBeTruthy();
	});
});

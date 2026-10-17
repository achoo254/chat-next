// "đang gõ…" on the real client core and the core's in-memory protocol
// server: the dialog list, the line under the newest message, and what the
// composer tells the server.
import { ChatType } from "@app/proto-ts/chats";
import { TypingAction } from "@app/proto-ts/realtime";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => {
	window.localStorage.clear();
});

function row(title: string): HTMLElement {
	const link = within(screen.getByRole("list", { name: "Danh sách chat" }))
		.getAllByRole("link")
		.find((element) => element.textContent?.includes(title));
	if (link === undefined) throw new Error(`no row ${title}`);
	return link;
}

describe("typing", () => {
	it("shows who types in the list and under the newest message, until they post", async () => {
		const fixture = new ChatFixture();
		const ngan = fixture.addUser("Ngân");
		const minh = fixture.addUser("Minh");
		const lan = fixture.addUser("Lan");
		const priv = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
		const group = fixture.createChat(ChatType.GROUP, "Team Mobile", [fixture.selfId, minh, lan]);
		fixture.send(ngan, priv, "chào");
		fixture.send(minh, group, "họp lúc 9 giờ");
		renderMessaging(fixture, `/c/${priv}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		await within(log).findByText("chào", {}, LONG);

		fixture.server.typing(ngan, priv, TypingAction.TYPING);
		fixture.server.typing(minh, group, TypingAction.TYPING);
		fixture.server.typing(lan, group, TypingAction.UPLOADING_PHOTO);
		// A private chat's row says only what the person does; the open chat names them.
		await waitFor(() => expect(row("Ngân").textContent).toContain("đang gõ…"), LONG);
		expect(within(log).getByText("Ngân đang gõ…")).toBeTruthy();
		await waitFor(() => expect(row("Team Mobile").textContent).toContain("Minh và Lan đang gõ…"), LONG);

		fixture.send(ngan, priv, "xong rồi");
		await within(log).findByText("xong rồi", {}, LONG);
		await waitFor(() => expect(within(log).queryByText("Ngân đang gõ…")).toBeNull(), LONG);
		expect(row("Ngân").textContent).not.toContain("đang gõ…");
	});

	it("tells the open chat while the user types, and ends it when the draft is cleared", async () => {
		const fixture = new ChatFixture();
		const ngan = fixture.addUser("Ngân");
		const priv = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
		fixture.send(ngan, priv, "chào");
		renderMessaging(fixture, `/c/${priv}`);
		await within(await screen.findByRole("log", { name: "Tin nhắn" }, LONG)).findByText("chào", {}, LONG);
		const box = screen.getByRole("textbox", { name: /^Tin nhắn tới / });
		await userEvent.type(box, "đang viết");
		await waitFor(() => expect(fixture.server.typingSent).toEqual([{ userId: fixture.selfId, chatId: priv, action: TypingAction.TYPING }]), LONG);
		await userEvent.clear(box);
		await waitFor(() => expect(fixture.server.typingSent.at(-1)?.action).toBe(TypingAction.CANCEL), LONG);
	});
});

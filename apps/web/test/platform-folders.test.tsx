// A chat synced with another app (Chat Bridge) adds a folder for that app after the built-in
// ones, whatever its direction; the built-in folders and their shortcuts do not move.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(cleanup);

/** A fixture with a chat synced two ways with Telegram, a read-only copy and an ordinary chat. */
function mixed(): ChatFixture {
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan");
	const minh = fixture.addUser("Minh");
	const tom = fixture.addUser("Tôm");
	const twoWay = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan], { externalApp: "telegram" });
	const copy = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, minh], { externalSource: "telegram" });
	const plain = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, tom]);
	fixture.send(lan, twoWay, "tin hai chiều");
	fixture.send(minh, copy, "tin bản sao");
	fixture.send(tom, plain, "tin thường");
	return fixture;
}

describe("platform folders", () => {
	it("lists the chats of an app after the built-in folders, two-way ones included", async () => {
		renderMessaging(mixed(), "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await within(rail).findByRole("button", { name: /^Telegram/ }, LONG);
		const labels = within(rail)
			.getAllByRole("button")
			.map((button) => button.textContent ?? "");
		const telegram = labels.findIndex((text) => text.startsWith("Telegram"));
		expect(telegram).toBeGreaterThan(labels.findIndex((text) => text.startsWith("Chưa đọc")));

		await userEvent.click(within(rail).getByRole("button", { name: /^Telegram/ }));
		expect(await screen.findByText("tin hai chiều", {}, LONG)).toBeTruthy();
		expect(screen.getByText("tin bản sao")).toBeTruthy();
		expect(screen.queryByText("tin thường")).toBeNull();

		await userEvent.click(within(rail).getByRole("button", { name: /^Tất cả/ }));
		expect(await screen.findByText("tin thường", {}, LONG)).toBeTruthy();
	});

	it("marks a chat synced with Telegram by its logo alone, not by the app's name", async () => {
		renderMessaging(mixed(), "/");
		const list = await screen.findByText("tin hai chiều", {}, LONG);
		const row = list.closest("a") as HTMLElement;
		expect(within(row).getAllByRole("img", { name: "Telegram" })).toHaveLength(1);
		expect(within(row).queryByText("Telegram")).toBeNull();
	});

	it("has no app folder when no chat is synced with an app", async () => {
		const fixture = new ChatFixture();
		const tom = fixture.addUser("Tôm");
		const plain = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, tom]);
		fixture.send(tom, plain, "tin thường");
		renderMessaging(fixture, "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await screen.findByText("tin thường", {}, LONG);
		expect(within(rail).queryByRole("button", { name: /^Telegram/ })).toBeNull();
	});

	it("counts the unread chats of an app in its folder", async () => {
		const fixture = mixed();
		renderMessaging(fixture, "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		const folder = await within(rail).findByRole("button", { name: /^Telegram/ }, LONG);
		expect(within(folder).getByLabelText("2 chat chưa đọc")).toBeTruthy();
	});
});

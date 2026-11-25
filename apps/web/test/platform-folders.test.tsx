// Telegram and Zalo (Chat Bridge) each have a folder after the built-in ones, with their logo,
// whether or not a chat is synced yet; a chat synced with one lands in it whatever its direction,
// and the built-in folders and their shortcuts do not move.
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

	it("leaves the logo off the rows in the app's own folder, where every chat is from it", async () => {
		renderMessaging(mixed(), "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await userEvent.click(await within(rail).findByRole("button", { name: /^Telegram/ }, LONG));
		const row = (await screen.findByText("tin hai chiều", {}, LONG)).closest("a") as HTMLElement;
		expect(within(row).queryByRole("img", { name: "Telegram" })).toBeNull();

		await userEvent.click(within(rail).getByRole("button", { name: /^Tất cả/ }));
		const again = (await screen.findByText("tin hai chiều", {}, LONG)).closest("a") as HTMLElement;
		expect(within(again).getAllByRole("img", { name: "Telegram" })).toHaveLength(1);
	});

	it("lists Telegram and Zalo with their logos even when no chat is synced with an app", async () => {
		const fixture = new ChatFixture();
		const tom = fixture.addUser("Tôm");
		const plain = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, tom]);
		fixture.send(tom, plain, "tin thường");
		renderMessaging(fixture, "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await screen.findByText("tin thường", {}, LONG);
		const labels = within(rail)
			.getAllByRole("button")
			.map((button) => button.textContent ?? "");
		const telegram = labels.findIndex((text) => text.startsWith("Telegram"));
		const zalo = labels.findIndex((text) => text.startsWith("Zalo"));
		expect(telegram).toBeGreaterThan(labels.findIndex((text) => text.startsWith("Chưa đọc")));
		expect(zalo).toBe(telegram + 1);
		// Each carries its logo (drawn, hidden from the reader) and no unread badge.
		for (const name of [/^Telegram/, /^Zalo/]) {
			const folder = within(rail).getByRole("button", { name });
			expect(folder.querySelector("svg circle")).not.toBeNull();
			expect(folder.querySelector(".badge")).toBeNull();
		}
	});

	it("opens an empty app folder to an empty list and goes back to all", async () => {
		const fixture = new ChatFixture();
		const tom = fixture.addUser("Tôm");
		const plain = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, tom]);
		fixture.send(tom, plain, "tin thường");
		renderMessaging(fixture, "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await screen.findByText("tin thường", {}, LONG);
		await userEvent.click(within(rail).getByRole("button", { name: /^Zalo/ }));
		await screen.findByText("Chưa có chat nào ở đây", {}, LONG);
		expect(screen.queryByText("tin thường")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Xem tất cả chat" }));
		expect(await screen.findByText("tin thường", {}, LONG)).toBeTruthy();
	});

	it("counts the unread chats of an app in its folder", async () => {
		const fixture = mixed();
		renderMessaging(fixture, "/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		const folder = await within(rail).findByRole("button", { name: /^Telegram/ }, LONG);
		expect(await within(folder).findByLabelText("2 chat chưa đọc", {}, LONG)).toBeTruthy();
	});
});

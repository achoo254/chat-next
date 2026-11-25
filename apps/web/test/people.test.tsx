// People (ADR 0025) on the web: "Cùng một người" in the info column of a
// private chat (linked identities, unlink, suggestions for this user, "Nối
// với…"), "Gợi ý nối" on the contacts screen, and the live refresh when
// another session changes the people.
import { Code } from "@connectrpc/connect";
import { ChatType } from "@achoo254/chat-proto/chats";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

/** Lan Anh on Chat and on Telegram, Minh on Chat, a bot and Hùng (a group only), each with a message. */
function seed() {
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan Anh");
	const lanTelegram = fixture.addUser("Lan Anh");
	const minh = fixture.addUser("Minh");
	const bot = fixture.addUser("Trợ lý Bot", { username: "helper_bot", isBot: true });
	const hung = fixture.addUser("Hùng");
	const lanChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	const telegramChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanTelegram], { externalApp: "telegram" });
	const minhChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, minh]);
	const botChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, bot]);
	const group = fixture.createChat(ChatType.GROUP, "Nhóm dự án", [fixture.selfId, hung, lan]);
	fixture.send(lan, lanChat, "Chào bạn");
	fixture.send(lanTelegram, telegramChat, "Tin từ Telegram");
	fixture.send(minh, minhChat, "Minh đây");
	fixture.send(bot, botChat, "Xin chào");
	fixture.send(hung, group, "Họp lúc 9 giờ");
	return { fixture, lan, lanTelegram, minh, lanChat };
}

async function openInfo(fixture: ChatFixture, chatId: number): Promise<HTMLElement> {
	renderMessaging(fixture, `/c/${chatId}`);
	const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
	await within(info).findByRole("button", { name: "Nối với…" }, LONG);
	return info;
}

describe("the same person in the info column of a private chat", () => {
	it("lists the identities linked with this chat's person, the one of this chat marked in words", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		fixture.people.link([lan, lanTelegram]);
		const info = await openInfo(fixture, lanChat);
		const list = await within(info).findByRole("list", { name: "Cùng một người" }, LONG);
		expect(within(info).getByRole("heading", { name: "Cùng một người" })).toBeTruthy();
		expect(within(list).getAllByRole("listitem")).toHaveLength(2);
		expect(within(list).getByText("Telegram")).toBeTruthy();
		expect(within(list).getByText("Cuộc trò chuyện này")).toBeTruthy();
		expect(within(list).getByRole("button", { name: "Bỏ nối Lan Anh (Chat)" })).toBeTruthy();
		expect(within(list).getByRole("button", { name: "Bỏ nối Lan Anh (Telegram)" })).toBeTruthy();
	});

	it("shows only “Nối với…” when nothing is linked or suggested", async () => {
		const { fixture, lan, lanChat } = seed();
		const info = await openInfo(fixture, lanChat);
		await waitFor(() => expect(fixture.people.calls).toContain(`suggestions:${lan}`), LONG);
		expect(within(info).queryByRole("heading", { name: "Cùng một người" })).toBeNull();
		expect(within(info).queryByText("Tên giống nhau, chưa xác minh")).toBeNull();
	});

	it("links a suggested pair, then lists the person again", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		fixture.people.suggested.push([lan, lanTelegram]);
		const info = await openInfo(fixture, lanChat);
		expect(await within(info).findByText("Tên giống nhau, chưa xác minh", {}, LONG)).toBeTruthy();
		await userEvent.click(within(info).getByRole("button", { name: "Nối Lan Anh (Chat) với Lan Anh (Telegram)" }));
		await waitFor(() => expect(fixture.people.calls).toContain(`link:${lan},${lanTelegram}`), LONG);
		expect(await screen.findByText("Đã nối với Lan Anh")).toBeTruthy();
		const list = await within(info).findByRole("list", { name: "Cùng một người" }, LONG);
		expect(within(list).getAllByRole("listitem")).toHaveLength(2);
		await waitFor(() => expect(within(info).queryByText("Tên giống nhau, chưa xác minh")).toBeNull(), LONG);
	});

	it("hides a pair the user says is not the same person", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		fixture.people.suggested.push([lan, lanTelegram]);
		const info = await openInfo(fixture, lanChat);
		await userEvent.click(await within(info).findByRole("button", { name: "Lan Anh (Chat) và Lan Anh (Telegram) không phải cùng một người" }, LONG));
		await waitFor(() => expect(fixture.people.calls).toContain(`reject:${lan}:${lanTelegram}`), LONG);
		await waitFor(() => expect(within(info).queryByText("Tên giống nhau, chưa xác minh")).toBeNull(), LONG);
		expect(fixture.people.people).toHaveLength(0);
		expect(await screen.findByText("Sẽ không gợi ý cặp này nữa")).toBeTruthy();
	});

	it("unlinks an identity; a person left with one user is gone", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		fixture.people.link([lan, lanTelegram]);
		const info = await openInfo(fixture, lanChat);
		const list = await within(info).findByRole("list", { name: "Cùng một người" }, LONG);
		await userEvent.click(within(list).getByRole("button", { name: "Bỏ nối Lan Anh (Telegram)" }));
		await waitFor(() => expect(fixture.people.calls).toContain(`unlink:${lanTelegram}`), LONG);
		await waitFor(() => expect(within(info).queryByRole("list", { name: "Cùng một người" })).toBeNull(), LONG);
		expect(await screen.findByText("Đã bỏ nối Lan Anh")).toBeTruthy();
	});

	it("offers only the other private-chat peers in “Nối với…”, searched without accents, and links the chosen one", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		const info = await openInfo(fixture, lanChat);
		await userEvent.click(within(info).getByRole("button", { name: "Nối với…" }));
		const dialog = await screen.findByRole("dialog", { name: "Nối với cùng một người" }, LONG);
		const list = await within(dialog).findByRole("list", { name: "Nối với cùng một người" }, LONG);
		const offered = () => within(list).getAllByRole("button").map((button) => `${button.querySelector("b")?.textContent ?? ""} · ${button.querySelector(".tag")?.textContent ?? ""}`);
		await waitFor(() => expect(offered()).toEqual(["Lan Anh · Telegram", "Minh · Chat"]), LONG);
		expect(within(dialog).queryByText("Hùng")).toBeNull();
		expect(within(dialog).queryByText("Trợ lý Bot")).toBeNull();
		await userEvent.type(within(dialog).getByRole("searchbox", { name: "Tìm theo tên" }), "MÍNH");
		await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(1), LONG);
		await userEvent.clear(within(dialog).getByRole("searchbox", { name: "Tìm theo tên" }));
		await userEvent.click(within(list).getByRole("button", { name: /Lan Anh/ }));
		await waitFor(() => expect(fixture.people.calls).toContain(`link:${lan},${lanTelegram}`), LONG);
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nối với cùng một người" })).toBeNull(), LONG);
		expect(await within(info).findByRole("list", { name: "Cùng một người" }, LONG)).toBeTruthy();
	});

	it("lists again when another session changes the people", async () => {
		const { fixture, lan, lanTelegram, lanChat } = seed();
		const info = await openInfo(fixture, lanChat);
		await waitFor(() => expect(fixture.people.calls).toContain("people"), LONG);
		fixture.people.link([lan, lanTelegram]);
		fixture.announcePeopleChanged();
		const list = await within(info).findByRole("list", { name: "Cùng một người" }, LONG);
		expect(within(list).getByText("Telegram")).toBeTruthy();
	});

	it("says why a link failed, offers a retry when the list failed, and hides everything on a server without people", async () => {
		const first = seed();
		first.fixture.people.listFailure = Code.Internal;
		const info = await openInfo(first.fixture, first.lanChat);
		const banner = await within(info).findByRole("alert", {}, LONG);
		expect(within(banner).getByText("Không tải được dữ liệu. Kiểm tra kết nối mạng rồi thử lại.")).toBeTruthy();
		first.fixture.people.listFailure = null;
		first.fixture.people.linkFailure = Code.NotFound;
		await userEvent.click(within(banner).getByRole("button", { name: "Thử lại" }));
		await waitFor(() => expect(within(info).queryByRole("alert")).toBeNull(), LONG);
		await userEvent.click(within(info).getByRole("button", { name: "Nối với…" }));
		const dialog = await screen.findByRole("dialog", { name: "Nối với cùng một người" }, LONG);
		await userEvent.click(await within(dialog).findByRole("button", { name: /Minh/ }, LONG));
		expect(await within(dialog).findByText("Không tìm thấy người này, hoặc bạn chưa có trò chuyện riêng với họ.", {}, LONG)).toBeTruthy();
		expect(first.fixture.people.people).toHaveLength(0);
	});

	it("shows nothing about people when the server does not support them", async () => {
		const { fixture, lanChat } = seed();
		fixture.people.listFailure = Code.Unimplemented;
		renderMessaging(fixture, `/c/${lanChat}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		await waitFor(() => expect(fixture.people.calls).toContain("people"), LONG);
		await waitFor(() => expect(within(info).queryByRole("button", { name: "Nối với…" })).toBeNull(), LONG);
	});
});

describe("link suggestions on the contacts screen", () => {
	it("lists every pending suggestion with Nối and Không phải, and hides the list once none is left", async () => {
		const { fixture, lan, lanTelegram, minh } = seed();
		fixture.people.suggested.push([lan, lanTelegram], [minh, lanTelegram]);
		renderMessaging(fixture, "/contacts");
		const region = await screen.findByRole("region", { name: "Gợi ý nối" }, LONG);
		await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(2), LONG);
		expect(within(region).getAllByText("Tên giống nhau, chưa xác minh")).toHaveLength(2);
		await userEvent.click(within(region).getByRole("button", { name: "Minh (Chat) và Lan Anh (Telegram) không phải cùng một người" }));
		await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(1), LONG);
		await userEvent.click(within(region).getByRole("button", { name: "Nối Lan Anh (Chat) với Lan Anh (Telegram)" }));
		await waitFor(() => expect(screen.queryByRole("region", { name: "Gợi ý nối" })).toBeNull(), LONG);
		expect(fixture.people.calls).toContain("suggestions:0");
		expect(fixture.people.people).toHaveLength(1);
	});

	it("says a phone match is the same number and still waits for Nối", async () => {
		const { fixture, lan, lanTelegram, minh } = seed();
		fixture.people.suggested.push([lan, lanTelegram], [minh, lanTelegram]);
		fixture.people.samePhone.add(`${Math.min(minh, lanTelegram)}:${Math.max(minh, lanTelegram)}`);
		renderMessaging(fixture, "/contacts");
		const region = await screen.findByRole("region", { name: "Gợi ý nối" }, LONG);
		await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(2), LONG);
		const [byName, byPhone] = within(region).getAllByRole("listitem");
		expect(within(byName ?? region).getByText("Tên giống nhau, chưa xác minh")).toBeTruthy();
		expect(within(byPhone ?? region).getByText("Cùng số điện thoại trên các ứng dụng kia, cần bạn xác nhận")).toBeTruthy();
		expect(within(byPhone ?? region).queryByText("Tên giống nhau, chưa xác minh")).toBeNull();
		expect(fixture.people.people).toHaveLength(0);
	});
});

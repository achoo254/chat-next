// R1 flows on the newest backend RPCs, through the real client core and the
// in-memory server: contacts, removing members with or without a ban, the
// banned list, an owner leaving, capped counts, paged topics, sending without
// a link preview, banned invitees, the emoji panel and the row menu.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entity, seedDemo } from "./support/demo-data.ts";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A window between 760 and 1100px wide: neither the wide nor the narrow query matches. */
function stubMediumWindow(): void {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
	}));
}

async function openOps(demo = seedDemo()) {
	renderMessaging(demo.fixture, demo.data, `/c/${demo.ids.ops}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText("Dashboard ổn định.", {}, LONG);
	return { demo, log };
}

function contactNames(): (string | null | undefined)[] {
	return within(screen.getByRole("list", { name: "Danh bạ" }))
		.getAllByRole("link")
		.map((row) => row.querySelector(".title-text")?.textContent);
}

describe("contacts", () => {
	it("lists your contacts by name, adds one by username and removes one", async () => {
		const demo = seedDemo();
		const { ha, lan } = demo.ids.users;
		renderMessaging(demo.fixture, demo.data, "/contacts");

		const list = await screen.findByRole("list", { name: "Danh bạ" }, LONG);
		await within(list).findByText("Bảo Ngọc", {}, LONG);
		expect(contactNames()).toEqual(["Bảo Ngọc", "Lan Anh", "Quang Huy"]);
		expect(screen.getByText("3 liên hệ")).toBeTruthy();
		// Sharing a group does not make Thu Hà a contact.
		expect(within(list).queryByText("Thu Hà")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Thêm liên hệ" }));
		const dialog = await screen.findByRole("dialog", { name: "Thêm liên hệ" });
		await userEvent.type(within(dialog).getByRole("searchbox", { name: "Username hoặc email đầy đủ" }), "@thuha");
		await userEvent.click(await within(dialog).findByRole("button", { name: "Thêm vào danh bạ" }, LONG));
		expect(await within(dialog).findByText("Đã trong danh bạ", {}, LONG)).toBeTruthy();
		expect(demo.fixture.contacts.has(ha)).toBe(true);
		await userEvent.click(within(dialog).getByRole("button", { name: "Đóng" }));
		await waitFor(() => expect(contactNames()).toEqual(["Bảo Ngọc", "Lan Anh", "Quang Huy", "Thu Hà"]));

		await userEvent.click(within(screen.getByRole("list", { name: "Danh bạ" })).getByRole("link", { name: /Lan Anh/ }));
		expect(window.location.pathname).toBe(`/contacts/${lan}`);
		await userEvent.click(await screen.findByRole("button", { name: "Xoá khỏi danh bạ" }, LONG));
		await waitFor(() => expect(demo.fixture.contacts.has(lan)).toBe(false));
		expect(await screen.findByText("Đã xoá Lan Anh khỏi danh bạ")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Thêm vào danh bạ" })).toBeTruthy();
		await waitFor(() => expect(contactNames()).not.toContain("Lan Anh"));
	});

	it("shows the same not found for someone whose privacy hides them", async () => {
		const demo = seedDemo();
		demo.fixture.hiddenFromSearch.add(demo.ids.users.minh);
		renderMessaging(demo.fixture, demo.data, "/contacts");
		await screen.findByRole("list", { name: "Danh bạ" }, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Thêm liên hệ" }));
		const dialog = await screen.findByRole("dialog", { name: "Thêm liên hệ" });
		await userEvent.type(within(dialog).getByRole("searchbox", { name: "Username hoặc email đầy đủ" }), "minh");
		expect(await within(dialog).findByText("Không tìm thấy", {}, LONG)).toBeTruthy();
		expect(demo.fixture.contacts.has(demo.ids.users.minh)).toBe(false);
	});

	it("adds the other person of a 1-1 chat from the info column", async () => {
		const demo = seedDemo();
		demo.fixture.contacts.delete(demo.ids.users.lan);
		renderMessaging(demo.fixture, demo.data, `/c/${demo.ids.lanAnh}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		expect(await within(info).findByText("Chưa có trong danh bạ", {}, LONG)).toBeTruthy();
		await userEvent.click(within(info).getByRole("button", { name: "Thêm vào danh bạ" }));
		expect(await within(info).findByText("Trong danh bạ của bạn", {}, LONG)).toBeTruthy();
		expect(demo.fixture.contacts.has(demo.ids.users.lan)).toBe(true);
	});
});

describe("members", () => {
	it("removes with a ban by default and removes only on request", async () => {
		const { demo } = await openOps();
		const { minh, deployBot } = demo.ids.users;
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(await within(info).findByRole("button", { name: /^Xem cả \d+ thành viên$/ }, LONG));

		let members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await userEvent.click(await within(members).findByRole("button", { name: "Thao tác với Minh" }, LONG));
		await userEvent.click(within(screen.getByRole("menu", { name: "Thao tác với Minh" })).getByRole("menuitem", { name: "Xoá khỏi nhóm" }));
		const confirm = await screen.findByRole("dialog", { name: "Xoá Minh khỏi nhóm?" }, LONG);
		expect(within(confirm).getByText("Mọi link mời do Minh tạo bị thu hồi ngay.")).toBeTruthy();
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoá và cấm vào lại" }));
		await waitFor(() => expect(demo.fixture.removals).toEqual([{ chatId: demo.ids.ops, userId: minh, ban: true }]), LONG);
		expect(await screen.findByText("Đã xoá và cấm Minh, link mời do Minh tạo đã bị thu hồi")).toBeTruthy();

		// Back on the member list, which no longer has Minh.
		members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await waitFor(() => expect(within(members).queryByText("Minh")).toBeNull(), LONG);
		await userEvent.click(await within(members).findByRole("button", { name: "Thao tác với Deploy Bot" }, LONG));
		await userEvent.click(within(screen.getByRole("menu", { name: "Thao tác với Deploy Bot" })).getByRole("menuitem", { name: "Xoá khỏi nhóm" }));
		const second = await screen.findByRole("dialog", { name: "Xoá Deploy Bot khỏi nhóm?" }, LONG);
		await userEvent.click(within(second).getByRole("button", { name: "Chỉ xoá (có thể vào lại bằng link)" }));
		await waitFor(() => expect(demo.fixture.removals.at(-1)).toEqual({ chatId: demo.ids.ops, userId: deployBot, ban: false }), LONG);
		expect(demo.fixture.bans.get(demo.ids.ops)?.map((ban) => ban.userId)).not.toContain(deployBot);
	});

	it("offers no removal of the owner to an admin", async () => {
		await openOps();
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(await within(info).findByRole("button", { name: /^Xem cả \d+ thành viên$/ }, LONG));
		const members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await within(members).findByText("Quang Huy", {}, LONG);
		expect(within(members).queryByRole("button", { name: "Thao tác với Quang Huy" })).toBeNull();
		expect(within(members).queryByRole("button", { name: "Thao tác với Lan Anh" })).toBeNull();
	});

	it("lists banned users and unbans one", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, demo.data, `/c/${demo.ids.ops}/admin/banned`);
		expect(await screen.findByText("Đã cấm · 1", {}, LONG)).toBeTruthy();
		expect(await screen.findByText(/^@khoapham · xoá bởi bạn · /, {}, LONG)).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "Gỡ cấm Phạm Khoa" }));
		await waitFor(() => expect(demo.fixture.bans.get(demo.ids.ops)).toEqual([]), LONG);
		expect(await screen.findByText("Chưa cấm ai")).toBeTruthy();
		expect(screen.getByText("Đã cấm · 0")).toBeTruthy();
		expect(screen.getByText("Đã gỡ cấm Phạm Khoa. Họ vào lại được bằng link mời hoặc khi được thêm")).toBeTruthy();
	});

	it("links the member and banned lists from the admin page", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, demo.data, `/c/${demo.ids.ops}/admin`);
		const banned = await screen.findByRole("link", { name: /^Đã cấm/ }, LONG);
		await waitFor(() => expect(banned.textContent).toContain("1 người · gỡ cấm để họ vào lại được"), LONG);
		await userEvent.click(banned);
		expect(window.location.pathname).toBe(`/c/${demo.ids.ops}/admin/banned`);
	});
});

describe("leaving as the owner", () => {
	it("asks for an admin first, then hands the group over", async () => {
		const fixture = new ChatFixture();
		const minh = fixture.addUser("Minh");
		const ha = fixture.addUser("Thu Hà");
		const chat = fixture.createChat(ChatType.GROUP, "Nhóm đọc sách", [fixture.selfId, minh, ha], { myRole: MemberRole.OWNER });
		fixture.setRole(chat, fixture.selfId, MemberRole.OWNER);
		fixture.send(minh, chat, "Tuần này đọc chương 3");
		fixture.ownerNeedsAdmin.add(chat);
		renderMessaging(fixture, undefined, `/c/${chat}`);

		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(await within(info).findByRole("button", { name: /Rời nhóm/ }, LONG));
		const leave = await screen.findByRole("dialog", { name: "Rời “Nhóm đọc sách”?" });
		expect(within(leave).getByText("Bạn là chủ nhóm. Khi bạn rời, quyền chủ nhóm chuyển cho admin lâu năm nhất.")).toBeTruthy();
		await userEvent.click(within(leave).getByRole("button", { name: "Chuyển quyền và rời nhóm" }));

		const blocked = await screen.findByRole("dialog", { name: "Chưa thể rời nhóm" }, LONG);
		await userEvent.click(within(blocked).getByRole("button", { name: "Chọn admin" }));
		const pick = await screen.findByRole("dialog", { name: "Chọn admin cho nhóm" });
		await userEvent.click(await within(pick).findByRole("radio", { name: /Minh/ }, LONG));
		await userEvent.click(within(pick).getByRole("button", { name: "Cấp quyền admin" }));
		expect(await screen.findByText("Đã cấp quyền admin cho Minh, giờ bạn chuyển được quyền chủ nhóm")).toBeTruthy();

		const again = await screen.findByRole("dialog", { name: "Rời “Nhóm đọc sách”?" }, LONG);
		expect(await within(again).findByText("Minh", {}, LONG)).toBeTruthy();
		await userEvent.click(within(again).getByRole("button", { name: "Chuyển quyền và rời nhóm" }));
		await waitFor(() => expect(window.location.pathname).toBe("/"), LONG);
	});
});

describe("capped counts", () => {
	it("shows 999+ for chats and topics at the server's cap", async () => {
		const demo = seedDemo();
		demo.fixture.unread(demo.ids.mobile, 1000);
		// Not General: opening the group opens General and reads it.
		const release = demo.fixture.topics.get(demo.ids.forum)?.find((topic) => topic.id === 5);
		if (release === undefined) throw new Error("no release topic");
		release.unreadCount = 1000;
		renderMessaging(demo.fixture, demo.data);

		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const row = (await within(list).findByText("Team Mobile", {}, LONG)).closest("a");
		await waitFor(() => expect(row?.querySelector(".badge")?.textContent).toBe("999+"), LONG);

		await userEvent.click(within(list).getByText("Dự án Hải Đăng"));
		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		const releaseRow = within(topics).getByRole("button", { name: /Phát hành 1\.3/ });
		expect(releaseRow.querySelector(".badge:not(.at)")?.textContent).toBe("999+");
	});
});

describe("topics", () => {
	it("loads the next page of topics", async () => {
		const demo = seedDemo();
		demo.fixture.topicPageSize = 3;
		renderMessaging(demo.fixture, demo.data, `/c/${demo.ids.forum}`);

		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		// Pinned first, then by newest message: Chung, Thông báo, Backend API.
		await waitFor(() => expect(within(topics).getAllByRole("button")).toHaveLength(3), LONG);
		expect(within(topics).queryByText("Phát hành 1.3")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Tải thêm chủ đề" }));
		expect(await within(topics).findByText("Phát hành 1.3", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("button", { name: "Tải thêm chủ đề" })).toBeNull(), LONG);
		// Five visible topics; the hidden one is in the admins' section.
		expect(within(topics).getAllByRole("button")).toHaveLength(5);
		expect(screen.getByText("Đã ẩn · 1 · chỉ admin thấy")).toBeTruthy();
	});
});

describe("composer", () => {
	it("sends without a link preview after the preview is removed", async () => {
		const { demo, log } = await openOps();
		const text = "Xem lại https://docs.example.com/postgres/upgrade";
		await userEvent.type(screen.getByRole("textbox", { name: "Tin nhắn" }), text);
		await userEvent.click(await screen.findByRole("button", { name: "Gửi không kèm xem trước" }, LONG));
		await userEvent.keyboard("{Enter}");
		expect(await within(log).findByText(/^Xem lại /, {}, LONG)).toBeTruthy();
		await waitFor(() => expect(demo.fixture.sentWithoutPreview).toEqual([text]), LONG);
	});

	it("keeps the preview unless removed", async () => {
		const { demo, log } = await openOps();
		await userEvent.type(screen.getByRole("textbox", { name: "Tin nhắn" }), "Đọc https://docs.example.com/postgres/upgrade");
		await screen.findByRole("button", { name: "Gửi không kèm xem trước" }, LONG);
		await userEvent.keyboard("{Enter}");
		expect(await within(log).findByText(/^Đọc /, {}, LONG)).toBeTruthy();
		await waitFor(() => expect(demo.fixture.sent.some((m) => m.text.startsWith("Đọc "))).toBe(true), LONG);
		expect(demo.fixture.sentWithoutPreview).toEqual([]);
	});

	it("inserts emoji found by a name without accents and keeps the panel open", async () => {
		await openOps();
		const box = screen.getByRole("textbox", { name: "Tin nhắn" }) as HTMLTextAreaElement;
		await userEvent.type(box, "Ổn rồi ");
		await userEvent.click(screen.getByRole("button", { name: "Emoji" }));
		const panel = await screen.findByRole("group", { name: "Chèn emoji" }, LONG);
		await userEvent.type(within(panel).getByRole("searchbox", { name: "Tìm emoji" }), "cuoi");
		const results = within(panel).getByRole("group", { name: "Kết quả cho “cuoi”" });
		await userEvent.click(within(results).getByRole("button", { name: "Mỉm cười" }));
		expect(box.value).toBe("Ổn rồi 🙂");
		expect(screen.getByRole("group", { name: "Chèn emoji" })).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("group", { name: "Chèn emoji" })).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Emoji" }));
	});

	it("shows the edit bar with Save and outlines the message being edited", async () => {
		const { log } = await openOps();
		const own = within(log).getByText("Mục 3 ổn, extension đã lên bản mới.").closest<HTMLElement>(".msg");
		if (own === null) throw new Error("message not found");
		fireEvent.contextMenu(own);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với tin của bạn" })).getByRole("menuitem", { name: "Sửa" }));
		expect(await screen.findByRole("button", { name: "Lưu" })).toBeTruthy();
		await waitFor(() => expect(own.classList.contains("editing")).toBe(true));
		await userEvent.click(await screen.findByRole("button", { name: "Huỷ sửa (Esc)" }));
		expect(await screen.findByText("Đã huỷ sửa, tin giữ nguyên")).toBeTruthy();
		expect(own.classList.contains("editing")).toBe(false);
	});
});

describe("external links", () => {
	it("warns when the link text names another domain", async () => {
		const demo = seedDemo();
		const text = "Khuyến mãi ở hoandat.com/khuyen-mai nhé";
		demo.fixture.send(demo.ids.users.minh, demo.ids.ops, text, {
			entities: [entity(EntityType.TEXT_LINK, text, "hoandat.com/khuyen-mai", { url: "https://hoandat-qua.example.net/nhan?id=8812" })],
		});
		const { log } = await openOps(demo);
		await userEvent.click(await within(log).findByRole("link", { name: "hoandat.com/khuyen-mai" }, LONG));
		const dialog = await screen.findByRole("dialog", { name: "Link khác với chữ hiển thị" });
		expect(within(dialog).getByText("Domain thật không phải hoandat.com. Đây là dấu hiệu thường gặp của link lừa đảo.")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Vẫn mở" })).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Huỷ" }).className).toContain("btn-primary");
	});
});

describe("invites", () => {
	it("refuses a user an admin removed with a ban", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, demo.data, "/+bannedlink");
		const dialog = await screen.findByRole("dialog", { name: "Bạn không thể tham gia qua link này" }, LONG);
		expect(within(dialog).queryByRole("button", { name: "Tham gia nhóm" })).toBeNull();
		expect(within(dialog).getByText("Nếu nghĩ đây là nhầm lẫn, hãy nhắn riêng cho một admin.")).toBeTruthy();
	});

	it("previews a few members and whether history is shared", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, demo.data, "/+teammobile");
		const dialog = await screen.findByRole("dialog", { name: "Team Mobile" }, LONG);
		expect(within(dialog).getByRole("img", { name: /^Một số thành viên: Minh, Quang Huy, Thu Hà$/ })).toBeTruthy();
		expect(within(dialog).getByText("Bạn sẽ xem được tin cũ của nhóm. Thành viên thấy tên và username của bạn.")).toBeTruthy();
	});
});

describe("add members result", () => {
	it("offers to copy the link when the person refuses messages from you", async () => {
		const demo = seedDemo();
		const outsider = demo.fixture.addUser("Hoàng Nam", { username: "hoangnam" });
		demo.fixture.refusesGroups.add(outsider);
		demo.fixture.refusesMessages.add(outsider);
		await openOps(demo);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(within(info).getByRole("button", { name: /Thêm thành viên/ }));
		const picker = await screen.findByRole("dialog", { name: "Thêm thành viên" }, LONG);
		await userEvent.type(within(picker).getByRole("searchbox"), "hoang");
		await userEvent.click(await within(picker).findByRole("checkbox", { name: /Hoàng Nam/ }, LONG));
		await userEvent.click(within(picker).getByRole("button", { name: "Thêm 1 người" }));

		const result = await screen.findByRole("dialog", { name: "Chưa thêm được 1 người" }, LONG);
		await userEvent.click(await within(result).findByRole("button", { name: "Gửi link mời cho 1 người" }, LONG));
		expect(await within(result).findByText(/^Không gửi được link mời: Hoàng Nam chỉ nhận tin từ danh bạ của họ/, {}, LONG)).toBeTruthy();
		expect(within(result).getByRole("button", { name: "Sao chép link" })).toBeTruthy();
		expect(within(result).getByRole("button", { name: "Gửi link mời" })).toHaveProperty("disabled", true);
	});
});

describe("chat list row menu", () => {
	it("pins, mutes for a while and marks read from a row's menu", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, demo.data);
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const slot = (await within(list).findByText("Dự án Hải Đăng", {}, LONG)).closest("li");
		if (slot === null) throw new Error("row not found");

		fireEvent.contextMenu(slot, { clientX: 40, clientY: 40 });
		let menu = await screen.findByRole("menu", { name: "Thao tác với chat Dự án Hải Đăng" }, LONG);
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Ghim chat" }));
		expect(await screen.findByText("Đã ghim Dự án Hải Đăng lên đầu danh sách")).toBeTruthy();
		await waitFor(() => expect(within(list).getAllByRole("link")[0]?.textContent).toContain("Dự án Hải Đăng"));

		fireEvent.contextMenu(slot, { clientX: 40, clientY: 40 });
		menu = await screen.findByRole("menu", { name: "Thao tác với chat Dự án Hải Đăng" }, LONG);
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Tắt tiếng" }));
		const durations = await screen.findByRole("menu", { name: "Tắt tiếng trong" });
		await userEvent.click(within(durations).getByRole("menuitem", { name: "8 giờ" }));
		expect(await screen.findByText("Đã tắt tiếng 8 giờ")).toBeTruthy();
		expect(within(slot).getByRole("img", { name: "Đã tắt tiếng" })).toBeTruthy();
	});
});

describe("info column", () => {
	it("lays over the chat on a medium window: focus moves in, Esc closes it and returns focus", async () => {
		stubMediumWindow();
		await openOps();
		expect(screen.queryByRole("complementary", { name: "Thông tin nhóm" })).toBeNull();

		const toggle = screen.getByRole("button", { name: "Thông tin chat" });
		await userEvent.click(toggle);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await waitFor(() => expect(document.activeElement).toBe(within(info).getByRole("button", { name: "Đóng cột thông tin (Esc)" })));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("complementary", { name: "Thông tin nhóm" })).toBeNull());
		expect(document.activeElement).toBe(toggle);
	});
});

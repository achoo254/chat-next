// The redesigned chat screens (Telegram layout and keys, Zalo wording and
// order) on the real client core and the in-memory server: folder badges
// without muted chats, quick actions on messages, the mention jump, pinning
// with or without notifying, who reacted, unsend and delete for me, one-screen
// group creation, contacts A–Z, add-member reasons, the moderation queue,
// grouped search, keyboard shortcuts, the list width handle and the composer.
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { FeedbackStatus, ModerationAction } from "@app/proto-ts/moderation";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { entity, seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { newChatDialog } from "./support/new-chat-dialog.ts";

const LONG = { timeout: 8000 };

async function openChat(path: string, waitFor: string | RegExp, demo = seedDemo()) {
	renderMessaging(demo.fixture, path);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText(waitFor, {}, LONG);
	return { demo, log };
}

function messageOf(log: HTMLElement, text: string): HTMLElement {
	const message = within(log).getByText(text).closest<HTMLElement>(".msg");
	if (message === null) throw new Error(`no message "${text}"`);
	return message;
}

describe("chat list", () => {
	it("leaves muted chats out of the folder badges and shows their count in grey", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const mobile = (await within(list).findByText("Team Mobile", {}, LONG)).closest("li");
		if (mobile === null) throw new Error("row not found");
		expect(await within(mobile).findByRole("img", { name: "1 tin chưa đọc, đã tắt thông báo" }, LONG)).toBeTruthy();
		expect(within(mobile).getByRole("img", { name: "Đã tắt thông báo" })).toBeTruthy();
		// Groups with unread messages: Vận hành hệ thống and Dự án Hải Đăng; the muted Team Mobile does not count.
		const rail = screen.getByRole("navigation", { name: "Thư mục chat" });
		await waitFor(() => expect(within(rail).getByRole("button", { name: /^Nhóm/ }).querySelector(".badge")?.getAttribute("aria-label")).toBe("2 chat chưa đọc"), LONG);
	});

	it("picks folders with Ctrl+1…5 and resizes the list with the arrow keys", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const tabs = screen.getByRole("tablist", { name: "Lọc chat" });
		expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Tất cả", "Cá nhân", "Nhóm", "Bot", "Chưa đọc"]);
		fireEvent.keyDown(document, { key: "5", ctrlKey: true });
		await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Chưa đọc" }).getAttribute("aria-selected")).toBe("true"));
		fireEvent.keyDown(document, { key: "4", metaKey: true });
		await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Bot" }).getAttribute("aria-selected")).toBe("true"));

		const handle = screen.getByRole("separator", { name: "Độ rộng danh sách chat" });
		expect(handle.getAttribute("aria-valuemin")).toBe("280");
		expect(handle.getAttribute("aria-valuemax")).toBe("420");
		handle.focus();
		await userEvent.keyboard("{End}");
		expect(handle.getAttribute("aria-valuenow")).toBe("420");
		await userEvent.keyboard("{ArrowLeft}");
		expect(handle.getAttribute("aria-valuenow")).toBe("410");
		expect(window.localStorage.getItem("chat:list-width")).toBe("410");
		await userEvent.keyboard("{Home}{ArrowLeft}");
		expect(handle.getAttribute("aria-valuenow")).toBe("280");
	});

	it("opens grouped search with Ctrl+K or Ctrl+F and highlights the words", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		const box = await screen.findByRole("searchbox", { name: "Tìm chat và tin nhắn" }, LONG);
		await within(await screen.findByRole("list", { name: "Danh sách chat" }, LONG)).findByText("Vận hành hệ thống", {}, LONG);
		fireEvent.keyDown(document, { key: "k", ctrlKey: true });
		await waitFor(() => expect(document.activeElement).toBe(box));
		box.blur();
		fireEvent.keyDown(document, { key: "f", metaKey: true });
		await waitFor(() => expect(document.activeElement).toBe(box));

		await userEvent.type(box, "van hanh");
		const groups = await screen.findByRole("heading", { name: "Nhóm và kênh" }, LONG);
		const section = groups.closest("section");
		if (section === null) throw new Error("no section");
		expect([...section.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Vận", "hành"]);
		await userEvent.clear(box);
		await userEvent.type(box, "lan anh");
		expect(await screen.findByRole("heading", { name: /^Liên hệ/ }, LONG)).toBeTruthy();
		const results = screen.getByRole("region", { name: "Tìm liên hệ, nhóm và kênh, tin nhắn" });
		await userEvent.click(await within(results).findByRole("button", { name: /Lan Anh.*Trong danh bạ/ }, LONG));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${demo.ids.lanAnh}`), LONG);
	});
});

describe("messages", () => {
	it("replies from the hover actions and by double-clicking", async () => {
		const { log } = await openChat(`/c/${seedDemo().ids.ops}`, "Dashboard ổn định.");
		const message = messageOf(log, "Dashboard ổn định.");
		const actions = within(message).getByRole("toolbar", { name: "Thao tác nhanh với tin của Lan Anh" });
		expect(within(actions).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Thả cảm xúc", "Trả lời", "Chuyển tiếp", "Thêm thao tác"]);
		await userEvent.click(within(actions).getByRole("button", { name: "Trả lời" }));
		expect(await screen.findByText("Trả lời Lan Anh")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByText("Trả lời Lan Anh")).toBeNull());

		await userEvent.dblClick(within(messageOf(log, "Xong rồi, mọi người kiểm tra giúp mình.")).getByText("Xong rồi, mọi người kiểm tra giúp mình."));
		expect(await screen.findByText("Trả lời Quang Huy")).toBeTruthy();
	});

	it("jumps to an unread mention with the @ button", async () => {
		const demo = seedDemo();
		const text = "@ductrung nhờ bạn duyệt bản phát hành.";
		demo.fixture.send(demo.ids.users.huy, demo.ids.ops, text, { entities: [entity(EntityType.MENTION, text, "@ductrung")] });
		demo.fixture.mentions(demo.ids.ops, 1);
		// Opened in a background tab, nothing is read yet (an open chat at its
		// newest message reads the mention, and the "@" goes away).
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		try {
			const { log } = await openChat(`/c/${demo.ids.ops}`, /nhờ bạn duyệt bản phát hành/, demo);
			await userEvent.click(await screen.findByRole("button", { name: "Tới tin nhắc bạn, 1 tin" }, LONG));
			await waitFor(() => expect(log.querySelector(".msg.flash")?.textContent).toContain("nhờ bạn duyệt bản phát hành"), LONG);
		} finally {
			visibility.mockRestore();
		}
	});

	it("pins quietly when 'Thông báo cho mọi thành viên' is off", async () => {
		const { demo, log } = await openChat(`/c/${seedDemo().ids.ops}`, "Dashboard ổn định.");
		const message = messageOf(log, "Dashboard ổn định.");
		fireEvent.contextMenu(message);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với tin" })).getByRole("menuitem", { name: "Ghim" }));
		const dialog = await screen.findByRole("dialog", { name: "Ghim tin này?" }, LONG);
		const notify = within(dialog).getByRole("checkbox", { name: "Thông báo cho mọi thành viên" });
		expect(notify.getAttribute("aria-checked")).toBe("true");
		expect(within(dialog).getByText(/đang có 1 tin ghim; tin này thành tin ghim mới nhất \(2\/2\)/)).toBeTruthy();
		await userEvent.click(notify);
		await userEvent.click(within(dialog).getByRole("button", { name: "Ghim" }));
		await waitFor(() => expect(demo.fixture.silentPins).toEqual([Number(message.dataset.seq)]), LONG);
		expect(await screen.findByText("Đã ghim tin")).toBeTruthy();
	});

	it("lists who reacted, per emoji", async () => {
		const { log } = await openChat(`/c/${seedDemo().ids.ops}`, "Dashboard ổn định.");
		fireEvent.contextMenu(within(log).getByRole("button", { name: "👍 3 người: bạn, Minh, Lan Anh" }));
		const dialog = await screen.findByRole("dialog", { name: "Ai đã thả cảm xúc" }, LONG);
		// Only the chip's list opens, not the message's own menu.
		expect(screen.queryByRole("menu", { name: "Thao tác với tin" })).toBeNull();
		const filter = within(dialog).getByRole("group", { name: "Lọc theo biểu cảm" });
		expect(within(filter).getByRole("button", { name: "👍 3" }).getAttribute("aria-pressed")).toBe("true");
		await within(dialog).findByText("Lan Anh", {}, LONG);
		expect(within(dialog).getByText("Minh")).toBeTruthy();
		expect(within(dialog).getByText("Bấm lần nữa để bỏ")).toBeTruthy();
		await userEvent.click(within(filter).getByRole("button", { name: "👀 1" }));
		await waitFor(() => expect(within(dialog).queryByText("Lan Anh")).toBeNull(), LONG);
		expect(within(dialog).getByText("Quang Huy")).toBeTruthy();
		await userEvent.click(within(filter).getByRole("button", { name: "Tất cả 4" }));
		expect(await within(dialog).findByText("Lan Anh", {}, LONG)).toBeTruthy();
	});

	it("unsends your message for everyone and deletes someone else's for you only", async () => {
		const { log } = await openChat(`/c/${seedDemo().ids.ops}`, "Dashboard ổn định.");
		fireEvent.contextMenu(messageOf(log, "Dashboard ổn định."));
		const theirs = await screen.findByRole("menu", { name: "Thao tác với tin" });
		expect(within(theirs).queryByRole("menuitem", { name: "Thu hồi" })).toBeNull();
		await userEvent.click(within(theirs).getByRole("menuitem", { name: "Xoá ở phía tôi" }));
		let dialog = await screen.findByRole("dialog", { name: "Xoá tin của Lan Anh ở phía bạn?" }, LONG);
		expect(within(dialog).getByText(/Chỉ Lan Anh thu hồi được tin này\./)).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá ở phía tôi" }));
		await waitFor(() => expect(within(log).queryByText("Dashboard ổn định.")).toBeNull(), LONG);

		fireEvent.contextMenu(messageOf(log, "Mục 3 ổn, extension đã lên bản mới."));
		const mine = await screen.findByRole("menu", { name: "Thao tác với tin của bạn" });
		expect(within(mine).getByRole("menuitem", { name: "Xoá ở phía tôi" })).toBeTruthy();
		await userEvent.click(within(mine).getByRole("menuitem", { name: "Thu hồi" }));
		dialog = await screen.findByRole("dialog", { name: "Thu hồi tin nhắn?" }, LONG);
		expect(within(dialog).getByRole("button", { name: "Xoá ở phía tôi" })).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Thu hồi" }));
		await waitFor(() => expect(within(log).queryByText("Mục 3 ổn, extension đã lên bản mới.")).toBeNull(), LONG);
		expect(await screen.findByText("Đã thu hồi tin")).toBeTruthy();
	});
});

describe("composer", () => {
	it("says where the message goes, hints the keys until the first send and edits the last message with ↑", async () => {
		const demo = seedDemo();
		const { log } = await openChat(`/c/${demo.ids.lanAnh}`, "Mình gửi file thiết kế rồi nhé", demo);
		const box = screen.getByRole("textbox", { name: "Tin nhắn tới Lan Anh" }) as HTMLTextAreaElement;
		expect(box.placeholder).toBe("Nhập tin nhắn tới Lan Anh");
		expect(screen.getByText("Enter gửi · Shift+Enter xuống dòng")).toBeTruthy();
		await userEvent.type(box, "Mình nhận rồi{Enter}");
		expect(await within(log).findByText("Mình nhận rồi", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("Enter gửi · Shift+Enter xuống dòng")).toBeNull());
		expect(window.localStorage.getItem("chat:composer-hint-done")).toBe("1");

		await waitFor(() => expect(messageOf(log, "Mình nhận rồi").dataset.seq).toBeTruthy(), LONG);
		box.focus();
		await userEvent.keyboard("{ArrowUp}");
		expect(await screen.findByText("Sửa tin")).toBeTruthy();
		await waitFor(() => expect(box.value).toBe("Mình nhận rồi"));
	});

	it("asks groups for @ mentions in the placeholder and counts who is online", async () => {
		const demo = seedDemo();
		await openChat(`/c/${demo.ids.ops}`, "Dashboard ổn định.", demo);
		expect((screen.getByRole("textbox", { name: "Tin nhắn tới Vận hành hệ thống" }) as HTMLTextAreaElement).placeholder).toBe(
			"Nhập @ để nhắc tên, tin nhắn tới Vận hành hệ thống",
		);
		const head = document.querySelector(".convo-head .title");
		await waitFor(() => expect(head?.textContent).toMatch(/5 thành viên · \d+ đang hoạt động$/), LONG);
	});
});

describe("info column", () => {
	it("mutes for a while and unpins from the quick actions", async () => {
		const demo = seedDemo();
		await openChat(`/c/${demo.ids.ops}`, "Dashboard ổn định.", demo);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		const actions = within(info).getByRole("group", { name: "Thao tác nhanh" });
		await userEvent.click(within(actions).getByRole("button", { name: "Tắt thông báo" }));
		await userEvent.click(within(await screen.findByRole("menu", { name: "Tắt thông báo trong" })).getByRole("menuitem", { name: "1 tuần" }));
		expect(await screen.findByText(/^Đã tắt thông báo 1 tuần, tới /)).toBeTruthy();
		await waitFor(() => expect(within(actions).getByRole("button", { name: "Bật thông báo" }).getAttribute("aria-pressed")).toBe("true"), LONG);
		expect(demo.fixture.mutes).toEqual([{ chatId: demo.ids.ops, durationSeconds: 7 * 86_400, forever: false }]);

		await userEvent.click(within(actions).getByRole("button", { name: "Bỏ ghim" }));
		expect(await screen.findByText("Đã bỏ ghim Vận hành hệ thống")).toBeTruthy();
		await waitFor(() => expect(within(actions).getByRole("button", { name: "Ghim" }).getAttribute("aria-pressed")).toBe("false"), LONG);
	});

	it("shows a person's shared groups and starts a group with them", async () => {
		const demo = seedDemo();
		await openChat(`/c/${demo.ids.lanAnh}`, "Mình gửi file thiết kế rồi nhé", demo);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		expect(await within(info).findByRole("heading", { name: "1 nhóm chung" }, LONG)).toBeTruthy();
		expect(within(info).getByRole("link", { name: /Vận hành hệ thống/ })).toBeTruthy();
		expect(within(info).getByRole("button", { name: /Xoá chat/ })).toBeTruthy();
		await userEvent.click(within(within(info).getByRole("group", { name: "Thao tác nhanh" })).getByRole("button", { name: "Tạo nhóm" }));
		const dialog = await screen.findByRole("dialog", { name: "Tạo nhóm với Lan Anh" }, LONG);
		expect(await within(dialog).findByRole("button", { name: "Bỏ chọn Lan Anh" }, LONG)).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Tạo nhóm · 1 người" })).toBeTruthy();
	});
});

describe("group creation", () => {
	it("creates a group on one screen and names it after its members when the name is empty", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await userEvent.click((await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement);
		await userEvent.click(within(await newChatDialog()).getByRole("button", { name: "Tạo nhóm" }));
		const dialog = await screen.findByRole("dialog", { name: "Tạo nhóm" }, LONG);
		// Nobody picked is allowed (the group starts with an invite link), but then it needs a name.
		const create = within(dialog).getByRole("button", { name: "Tạo nhóm" });
		expect(create).toHaveProperty("disabled", true);
		// Suggestions come from your contacts first.
		await userEvent.click(await within(dialog).findByRole("checkbox", { name: /Lan Anh/ }, LONG));
		await userEvent.click(within(dialog).getByRole("checkbox", { name: /Quang Huy/ }));
		const name = within(dialog).getByRole("textbox", { name: /Tên nhóm/ }) as HTMLInputElement;
		expect(name.placeholder).toBe("Lan Anh, Quang Huy");
		expect(within(dialog).getByRole("button", { name: "Bỏ chọn Quang Huy" })).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Tạo nhóm · 2 người" }));
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Bạn đã tạo nhóm “Lan Anh, Quang Huy”", {}, LONG)).toBeTruthy();
	});
});

describe("contacts", () => {
	it("files contacts A–Z and shows the shared groups on the card", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/contacts/${demo.ids.users.lan}`);
		const list = await screen.findByRole("list", { name: "Danh bạ" }, LONG);
		await within(list).findByText("Bảo Ngọc", {}, LONG);
		expect([...list.querySelectorAll(".az-head")].map((head) => head.textContent)).toEqual(["B", "L", "Q"]);
		expect(screen.getByText("Xếp A–Z")).toBeTruthy();
		const card = await screen.findByRole("group", { name: "Lan Anh" }, LONG);
		expect(await within(card).findByText("1 nhóm chung", {}, LONG)).toBeTruthy();
		expect(within(card).getByRole("button", { name: "Tạo nhóm" })).toBeTruthy();
	});
});

describe("adding members", () => {
	it("names the reason for each person and lets an admin unban and add", async () => {
		const demo = seedDemo();
		demo.fixture.fullChats.add(demo.ids.ops);
		await openChat(`/c/${demo.ids.ops}`, "Dashboard ổn định.", demo);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(within(within(info).getByRole("group", { name: "Thao tác nhanh" })).getByRole("button", { name: "Thêm thành viên" }));
		const picker = await screen.findByRole("dialog", { name: "Thêm thành viên" }, LONG);
		const search = within(picker).getByRole("searchbox");
		await userEvent.type(search, "khoa");
		await userEvent.click(await within(picker).findByRole("checkbox", { name: /Phạm Khoa/ }, LONG));
		await userEvent.clear(search);
		await userEvent.type(search, "ducanh");
		await userEvent.click(await within(picker).findByRole("checkbox", { name: /Đức Anh/ }, LONG));
		await userEvent.click(within(picker).getByRole("button", { name: "Thêm 2 người" }));

		const result = await screen.findByRole("dialog", { name: "Chưa thêm được 2 người" }, LONG);
		expect(await within(result).findByText("Đang bị cấm khỏi nhóm này, link mời cũng bị từ chối", {}, LONG)).toBeTruthy();
		expect(within(result).getByText("Nhóm đã đủ số thành viên tối đa")).toBeTruthy();
		// The full chat offers no way round; the ban does, to an admin.
		expect(within(result).queryByRole("button", { name: "Gửi link mời" })).toBeNull();
		demo.fixture.fullChats.delete(demo.ids.ops);
		await userEvent.click(within(result).getByRole("button", { name: "Gỡ cấm và thêm" }));
		expect(await screen.findByText("Đã gỡ cấm và thêm Phạm Khoa vào nhóm")).toBeTruthy();
		expect(demo.fixture.bans.get(demo.ids.ops)).toEqual([]);
	});
});

describe("moderation", () => {
	it("is only for operators", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/moderation");
		expect(await screen.findByText("Bạn không có quyền kiểm duyệt.", {}, LONG)).toBeTruthy();
		window.history.replaceState(null, "", "/settings/profile");
		fireEvent(window, new PopStateEvent("popstate"));
		expect(await screen.findByRole("heading", { level: 1, name: "Hồ sơ" }, LONG)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Kiểm duyệt" })).toBeNull();
	});

	it("lists open reports, shows one in context and removes the content with a reason", async () => {
		const demo = seedDemo();
		demo.fixture.operator = true;
		renderMessaging(demo.fixture, "/moderation");
		const queue = await screen.findByRole("table", {}, LONG);
		expect(await within(queue).findByRole("link", { name: /Tin trong Hội săn deal công nghệ/ }, LONG)).toBeTruthy();
		expect(within(queue).getByRole("link", { name: /Nhận quà 24h/ })).toBeTruthy();
		expect(within(queue).queryByRole("link", { name: /Thông báo hoandat/ })).toBeNull();

		await userEvent.click(within(queue).getByRole("link", { name: /Tin trong Hội săn deal công nghệ/ }));
		expect(await screen.findByText("Tin bị báo cáo", {}, LONG)).toBeTruthy();
		expect(screen.getByText(/nhan-qua24h\.top/)).toBeTruthy();
		expect(screen.getByText("“Link giả trang đăng nhập, đừng bấm.”")).toBeTruthy();
		await userEvent.click(screen.getByRole("link", { name: "Hành động" }));
		expect(await screen.findByRole("checkbox", { name: /Gỡ nội dung/ }, LONG)).toHaveProperty("checked", true);
		await userEvent.click(screen.getByRole("button", { name: "Tiếp tục" }));
		const confirm = await screen.findByRole("dialog", { name: "Xác nhận hành động" }, LONG);
		await userEvent.click(within(confirm).getByRole("button", { name: "Xác nhận" }));
		expect(within(confirm).getByText("Cần nhập lý do trước khi xác nhận.")).toBeTruthy();
		await userEvent.type(within(confirm).getByRole("textbox", { name: /Lý do/ }), "Lừa đảo nhận quà");
		await userEvent.click(within(confirm).getByRole("button", { name: "Xác nhận" }));
		await waitFor(() => expect(demo.fixture.reportQueue.find((report) => report.id === 20481)?.actions).toEqual([ModerationAction.DELETE_MESSAGES]), LONG);
		expect(await screen.findByText("Đã thực hiện hành động, đã ghi nhật ký")).toBeTruthy();
		await waitFor(() => expect(window.location.pathname).toBe("/moderation"), LONG);
	});

	it("lists the assistant's feedback, marks it handled and answers it", async () => {
		const demo = seedDemo();
		demo.fixture.operator = true;
		renderMessaging(demo.fixture, "/moderation");
		// The side navigation; narrow screens show the same links as tabs instead.
		const [sideLink] = await screen.findAllByRole("link", { name: "Góp ý" }, LONG);
		if (sideLink === undefined) throw new Error("no feedback link");
		await userEvent.click(sideLink);
		await waitFor(() => expect(window.location.pathname).toBe("/moderation/feedback"), LONG);
		expect(await screen.findByText("Gửi ảnh trong nhóm bị treo ở 99%.", {}, LONG)).toBeTruthy();
		expect(screen.getByText("Báo lỗi")).toBeTruthy();
		expect(screen.queryByText("Nút gửi hơi nhỏ trên điện thoại.")).toBeNull();

		const idea = screen.getByText("Cho mình chọn chế độ tối theo giờ nhé.").closest("li");
		if (idea === null) throw new Error("item not found");
		await userEvent.click(within(idea).getByRole("button", { name: "Đã xử lý" }));
		expect(await screen.findByText("Đã chuyển sang Đã xử lý", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("Cho mình chọn chế độ tối theo giờ nhé.")).toBeNull(), LONG);
		expect(demo.fixture.feedbackQueue.find((f) => f.id === 2)?.status).toBe(FeedbackStatus.HANDLED);

		const bug = screen.getByText("Gửi ảnh trong nhóm bị treo ở 99%.").closest("li");
		if (bug === null) throw new Error("item not found");
		await userEvent.click(within(bug).getByRole("button", { name: "Trả lời" }));
		const dialog = await screen.findByRole("dialog", { name: /Trả lời/ }, LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi trả lời" }));
		expect(within(dialog).getByText("Nhập câu trả lời trước khi gửi.")).toBeTruthy();
		await userEvent.type(within(dialog).getByRole("textbox", { name: /Câu trả lời/ }), "Đã sửa, cảm ơn bạn");
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi trả lời" }));
		expect(await screen.findByText("Đã gửi trả lời qua bot Trợ lý", {}, LONG)).toBeTruthy();
		expect(demo.fixture.feedbackQueue.find((f) => f.id === 3)?.replyText).toBe("Đã sửa, cảm ơn bạn");

		await userEvent.click(screen.getByRole("tab", { name: "Đã xử lý" }));
		expect(await screen.findByText("Đã sửa, cảm ơn bạn", {}, LONG)).toBeTruthy();
		expect(screen.getByText("Nút gửi hơi nhỏ trên điện thoại.")).toBeTruthy();
		expect(screen.getAllByText(/^Đã trả lời ·/).length).toBe(2);
	});

	it("shows closed reports under their status", async () => {
		const demo = seedDemo();
		demo.fixture.operator = true;
		renderMessaging(demo.fixture, "/moderation");
		await userEvent.click(await screen.findByRole("tab", { name: "Đã xử lý" }, LONG));
		const queue = await screen.findByRole("table", {}, LONG);
		expect(await within(queue).findByRole("link", { name: /Thông báo hoandat/ }, LONG)).toBeTruthy();
		expect(within(queue).getByText("Đã xử lý")).toBeTruthy();
	});
});

describe("deleting from the chat list", () => {
	it("offers the owner of a group to delete it for everyone, after typing its name", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const group = f.createChat(ChatType.GROUP, "Nhóm tạm", [f.selfId, demo.ids.users.minh], { myRole: MemberRole.OWNER });
		f.setRole(group, f.selfId, MemberRole.OWNER);
		f.send(demo.ids.users.minh, group, "Chào cả nhóm");
		renderMessaging(f);
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const slot = (await within(list).findByText("Nhóm tạm", {}, LONG)).closest("li");
		if (slot === null) throw new Error("row not found");
		fireEvent.contextMenu(slot, { clientX: 40, clientY: 40 });
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với chat Nhóm tạm" }, LONG)).getByRole("menuitem", { name: "Xoá nhóm" }));
		const dialog = await screen.findByRole("dialog", { name: "Xoá nhóm Nhóm tạm?" }, LONG);
		await userEvent.type(within(dialog).getByRole("textbox"), "Nhóm tạm");
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá nhóm" }));
		await waitFor(() => expect(f.deletedChats).toEqual([group]), LONG);
		await waitFor(() => expect(within(list).queryByText("Nhóm tạm")).toBeNull(), LONG);
	});

	it("offers no delete to members who do not own a group", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		const slot = (await within(list).findByText("Team Mobile", {}, LONG)).closest("li");
		if (slot === null) throw new Error("row not found");
		fireEvent.contextMenu(slot, { clientX: 40, clientY: 40 });
		const menu = await screen.findByRole("menu", { name: "Thao tác với chat Team Mobile" }, LONG);
		expect(within(menu).queryByRole("menuitem", { name: /^Xoá/ })).toBeNull();
	});
});

describe("private chats", () => {
	it("keeps a deleted private chat out of the list until a new message", async () => {
		const demo = seedDemo();
		const nam = demo.fixture.addUser("Hoàng Nam", { username: "hoangnam" });
		const chat = demo.fixture.createChat(ChatType.PRIVATE, "", [demo.fixture.selfId, nam]);
		demo.fixture.send(nam, chat, "Chào bạn");
		renderMessaging(demo.fixture, `/c/${chat}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		await userEvent.click(await within(info).findByRole("button", { name: /Xoá chat/ }, LONG));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Xoá chat với Hoàng Nam?" }, LONG)).getByRole("button", { name: "Xoá chat" }));
		await waitFor(() => expect(window.location.pathname).toBe("/"), LONG);
		const list = screen.getByRole("list", { name: "Danh sách chat" });
		await waitFor(() => expect(within(list).queryByText("Hoàng Nam")).toBeNull(), LONG);
	});
});

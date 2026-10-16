// The messaging UI (release R1) on the real client core and the core's
// in-memory protocol server: chat list filtering, message rendering states,
// composer reply/edit, topics and the info panel.
import { Code } from "@connectrpc/connect";
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { newChatDialog } from "./support/new-chat-dialog.ts";

const LONG = { timeout: 8000 };

afterEach(() => {
	window.localStorage.clear();
});

function chatList(): HTMLElement {
	return screen.getByRole("list", { name: "Danh sách chat" });
}

async function openOps(demo = seedDemo()) {
	renderMessaging(demo.fixture, `/c/${demo.ids.ops}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText("Dashboard ổn định.", {}, LONG);
	return { demo, log };
}

describe("chat list", () => {
	it("lists chats with type icons, badges and the pinned group first", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);

		await within(await screen.findByRole("list", { name: "Danh sách chat" }, LONG)).findByText("Vận hành hệ thống", {}, LONG);
		const rows = within(chatList()).getAllByRole("link");
		expect(rows[0]?.textContent).toContain("Vận hành hệ thống");
		expect(within(chatList()).getAllByRole("img", { name: "Nhóm" }).length).toBeGreaterThan(0);
		expect(within(chatList()).getByRole("img", { name: "Nhóm có chủ đề" })).toBeTruthy();
		expect(within(chatList()).getByRole("img", { name: "Kênh" })).toBeTruthy();
		expect(within(chatList()).getAllByRole("img", { name: "Có người nhắc bạn" }).length).toBe(1);
		// Group previews start with the sender; topic groups show two lines.
		expect(within(chatList()).getByText("Lan Anh:")).toBeTruthy();
		await waitFor(() => expect(chatList().querySelector(".preview.two-line .topics-line")?.textContent).toContain("Thiết kế"), LONG);
	});

	it("filters by the built-in folders and shows the empty state of an empty folder", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		await within(await screen.findByRole("list", { name: "Danh sách chat" }, LONG)).findByText("Deploy Bot", {}, LONG);

		await userEvent.click(within(rail).getByRole("button", { name: /^Nhóm/ }));
		await waitFor(() => expect(within(chatList()).queryByText("Deploy Bot")).toBeNull());
		expect(within(chatList()).getByText("Team Mobile")).toBeTruthy();
		expect(within(chatList()).queryByText("Thông báo hoandat")).toBeNull();

		await userEvent.click(within(rail).getByRole("button", { name: /^Bot/ }));
		await waitFor(() => expect(within(chatList()).getAllByRole("link")).toHaveLength(1));
		expect(within(chatList()).getByText("Deploy Bot")).toBeTruthy();

		// The narrow tab row mirrors the rail.
		const tabs = screen.getByRole("tablist", { name: "Lọc chat" });
		expect(within(tabs).getByRole("tab", { name: "Bot" }).getAttribute("aria-selected")).toBe("true");
		expect(within(rail).getByRole("button", { name: /^Bot/ }).getAttribute("aria-current")).toBe("true");
	});

	it("shows the empty-folder state with a way back to all chats", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan Anh");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, chat, "Chào bạn");
		renderMessaging(fixture);
		await screen.findByText("Chào bạn", {}, LONG);

		await userEvent.click(screen.getByRole("tab", { name: "Bot" }));
		expect(screen.getByText("Chưa có chat nào ở đây")).toBeTruthy();
		expect(screen.getByText("Chat với bot sẽ hiện ở bộ lọc này.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Xem tất cả chat" }));
		expect(await screen.findByText("Chào bạn")).toBeTruthy();
	});

	it("searches local messages without accents and highlights the match", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await within(await screen.findByRole("list", { name: "Danh sách chat" }, LONG)).findByText("Vận hành hệ thống", {}, LONG);

		await userEvent.type(screen.getByRole("searchbox", { name: "Tìm chat và tin nhắn" }), "ky so");
		const results = await screen.findByRole("list", { name: "Kết quả tìm kiếm" }, LONG);
		await waitFor(() => expect(within(results).getAllByRole("button").length).toBeGreaterThan(0), LONG);
		const marks = [...results.querySelectorAll("mark")].map((mark) => mark.textContent);
		expect(marks).toEqual(expect.arrayContaining(["ký", "số"]));
	});
});

describe("message rendering", () => {
	it("renders entities, forwards, replies, reactions, previews and states", async () => {
		const { log } = await openOps();

		expect(within(log).getByText("Lịch nâng cấp").tagName).toBe("B");
		expect(within(log).getByRole("button", { name: "Nội dung ẩn, bấm để hiện" })).toBeTruthy();
		expect(within(log).getByRole("button", { name: "Sao chép đoạn code" })).toBeTruthy();
		expect(log.querySelector(".code-block pre code")?.textContent).toContain("pg_upgrade -b");
		const wiki = within(log).getByRole("link", { name: "wiki vận hành" });
		expect(wiki.getAttribute("rel")).toBe("noopener noreferrer");
		expect(within(log).getByText(/Chuyển tiếp từ/)).toBeTruthy();
		expect(log.querySelector(".msg.at-me .mention.me")?.textContent).toBe("@ductrung");
		expect(within(log).getByText(/^đã sửa/)).toBeTruthy();
		expect(within(log).getByText("Nâng cấp Postgres gần như không gián đoạn")).toBeTruthy();
		expect(within(log).getByRole("button", { name: "👍 3 người: bạn, Minh, Lan Anh" }).getAttribute("aria-pressed")).toBe("true");
		expect(within(log).getByText("Lan Anh đã thêm Deploy Bot")).toBeTruthy();
		expect((await within(log).findByRole("separator", {}, LONG)).textContent).toBe("Tin chưa đọc");
		expect(within(log).getAllByRole("img", { name: "Đã xem" }).length).toBeGreaterThan(0);
		// Reply quote of your own message names the quoted author.
		await waitFor(() => expect(log.querySelector(".msg.mine .reply b")?.textContent).toBe("Quang Huy"), LONG);
		// The pinned bar loads with the first chat that has a pinned message.
		expect((await screen.findByRole("button", { name: "Nhảy tới tin ghim" }, LONG)).textContent).toContain("Checklist sau nâng cấp");
	});

	it("drops the unread divider once the reader sends a message", async () => {
		const { log } = await openOps();
		expect((await within(log).findByRole("separator", {}, LONG)).textContent).toBe("Tin chưa đọc");
		await userEvent.type(screen.getByRole("textbox", { name: /^Tin nhắn tới / }), "Mình đọc rồi{Enter}");
		await waitFor(() => expect(within(log).queryByRole("separator")).toBeNull(), LONG);
	});

	it("reveals a spoiler and hides the pinned bar on this device", async () => {
		const { log } = await openOps();
		await userEvent.click(within(log).getByRole("button", { name: "Nội dung ẩn, bấm để hiện" }));
		expect(log.querySelector(".spoiler.revealed")?.textContent).toBe("482 913");

		await userEvent.click(await screen.findByRole("button", { name: "Ẩn thanh tin ghim" }, LONG));
		expect(screen.queryByRole("button", { name: "Nhảy tới tin ghim" })).toBeNull();
		expect(await screen.findByRole("switch", { name: "Hiện thanh tin ghim" })).toBeTruthy();
	});

	it("asks before opening a link outside the tenant's sites", async () => {
		const { log } = await openOps();
		await userEvent.click(within(log).getByRole("link", { name: "https://docs.example.com/postgres/upgrade" }));
		const dialog = await screen.findByRole("dialog", { name: "Mở link ngoài?" });
		expect(within(dialog).getByText(/^Quang Huy gửi link này\. Nó dẫn ra ngoài /)).toBeTruthy();
		expect(dialog.querySelector(".url-box b")?.textContent).toBe("docs.example.com");
		expect(within(dialog).getByRole("button", { name: "Sao chép link" })).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Mở link" })).toBeTruthy();
	});
});

describe("composer", () => {
	it("sends optimistically and shows the server tick", async () => {
		const { log } = await openOps();
		const box = screen.getByRole("textbox", { name: /^Tin nhắn tới / });
		await userEvent.type(box, "Mình kiểm tra replica nhé{Enter}");

		expect(await within(log).findByText("Mình kiểm tra replica nhé", {}, LONG)).toBeTruthy();
		await waitFor(() => {
			const last = [...log.querySelectorAll(".msg.mine")].at(-1);
			expect(last?.querySelector('[aria-label="Đã gửi"], [aria-label="Đã xem"]')).not.toBeNull();
		}, LONG);
		expect((box as HTMLTextAreaElement).value).toBe("");
	});

	it("shows a refused message as failed and resends it", async () => {
		const demo = seedDemo();
		demo.fixture.server.faults.push({ method: "sendMessage", when: "before", code: Code.InvalidArgument, remaining: 1 });
		const { log } = await openOps(demo);
		await userEvent.type(screen.getByRole("textbox", { name: /^Tin nhắn tới / }), "Tin thử lỗi{Enter}");

		const failed = await within(log).findByText("Chưa gửi được", { selector: ".failed-row" }, LONG);
		expect(within(log).getByRole("img", { name: "Chưa gửi được" })).toBeTruthy();
		await userEvent.click(within(failed).getByRole("button", { name: "Gửi lại" }));
		await waitFor(() => expect(within(log).queryByText("Chưa gửi được", { selector: ".failed-row" })).toBeNull(), LONG);
		expect(within(log).getByText("Tin thử lỗi")).toBeTruthy();
	});

	it("replies to a message from its menu", async () => {
		const { demo, log } = await openOps();
		const target = within(log).getByText("Dashboard ổn định.").closest<HTMLElement>(".msg");
		if (target === null) throw new Error("message not found");
		const seq = Number(target.dataset.seq);
		fireEvent.contextMenu(target);
		const menu = await screen.findByRole("menu", { name: "Thao tác với tin" });
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Trả lời" }));

		expect(await screen.findByText("Trả lời Lan Anh")).toBeTruthy();
		await userEvent.type(screen.getByRole("textbox", { name: /^Tin nhắn tới / }), "Cảm ơn bạn{Enter}");
		expect(await within(log).findByText("Cảm ơn bạn", {}, LONG)).toBeTruthy();
		expect(screen.queryByText("Trả lời Lan Anh")).toBeNull();
		// The test server keeps only the text, so the reply is checked on the request.
		await waitFor(() => expect(demo.fixture.sent).toContainEqual({ chatId: demo.ids.ops, text: "Cảm ơn bạn", replyToSeq: seq, topicId: 0 }), LONG);
	});

	it("edits your own message and cancels with Escape", async () => {
		const { log } = await openOps();
		const own = within(log).getByText("Mục 3 ổn, extension đã lên bản mới.").closest<HTMLElement>(".msg");
		if (own === null) throw new Error("message not found");
		fireEvent.contextMenu(own);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với tin của bạn" })).getByRole("menuitem", { name: "Sửa" }));

		const box = screen.getByRole("textbox", { name: /^Tin nhắn tới / }) as HTMLTextAreaElement;
		await waitFor(() => expect(box.value).toBe("Mục 3 ổn, extension đã lên bản mới."));
		expect(await screen.findByText("Sửa tin")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByText("Sửa tin")).toBeNull();
		expect(box.value).toBe("");

		fireEvent.contextMenu(own);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với tin của bạn" })).getByRole("menuitem", { name: "Sửa" }));
		await waitFor(() => expect(box.value).toBe("Mục 3 ổn, extension đã lên bản mới."));
		await userEvent.clear(box);
		await userEvent.type(box, "Mục 3 ổn, extension đã lên 1.4.{Enter}");
		expect(await within(log).findByText("Mục 3 ổn, extension đã lên 1.4.", {}, LONG)).toBeTruthy();
	});

	it("keeps a draft per chat and shows it in the list", async () => {
		const { demo } = await openOps();
		await userEvent.type(screen.getByRole("textbox", { name: /^Tin nhắn tới / }), "Chiều nay mình gửi bản sửa");
		const row = within(chatList()).getByText("Vận hành hệ thống").closest("a");
		await waitFor(() => expect(row?.textContent).toContain("Nháp:"));
		expect(window.localStorage.getItem(`chat:draft:${demo.fixture.selfId}:${demo.ids.ops}`)).toBe("Chiều nay mình gửi bản sửa");
	});
});

describe("turning topics on", () => {
	it("creates a group with topics from the new group dialog", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await userEvent.click((await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement);
		await userEvent.click(within(await newChatDialog()).getByRole("button", { name: "Tạo nhóm" }));
		const dialog = await screen.findByRole("dialog", { name: "Tạo nhóm" }, LONG);
		await userEvent.click(await within(dialog).findByRole("checkbox", { name: /Lan Anh/ }, LONG));
		await userEvent.type(within(dialog).getByRole("textbox", { name: /Tên nhóm/ }), "Dự án Mới");
		const topicsSwitch = within(dialog).getByRole("switch", { name: "Nhóm có chủ đề" });
		expect(topicsSwitch.getAttribute("aria-checked")).toBe("false");
		expect(within(dialog).getByText(/Bật rồi không tắt được/)).toBeTruthy();
		await userEvent.click(topicsSwitch);
		await userEvent.click(within(dialog).getByRole("button", { name: "Tạo nhóm · 1 người" }));

		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		// The server's "General" shows by its Vietnamese name.
		expect(await within(topics).findByRole("button", { name: /Chung/ }, LONG)).toBeTruthy();
		expect(within(topics).queryByText("General")).toBeNull();
	});

	it("turns topics on from Quản lý nhóm, after which the switch stays on", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin`);
		const card = (await screen.findByRole("heading", { name: "Chủ đề" }, LONG)).closest("section") as HTMLElement;
		const toggle = within(card).getByRole("switch", { name: "Bật chủ đề" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await userEvent.click(toggle);
		expect(await screen.findByText("Đã bật chủ đề cho nhóm")).toBeTruthy();
		expect(demo.fixture.updatedChats).toEqual([{ chatId: demo.ids.ops, forum: true }]);
		await waitFor(() => expect(within(card).getByText("Đã bật. Chủ đề không tắt được.")).toBeTruthy(), LONG);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(toggle).toHaveProperty("disabled", true);
	});

	it("shows no topics card for a channel", async () => {
		const { demo, chatId } = ownedChannel();
		renderMessaging(demo.fixture, `/c/${chatId}/admin`);
		expect(await screen.findByRole("heading", { name: "Link mời" }, LONG)).toBeTruthy();
		expect(screen.queryByRole("switch", { name: "Bật chủ đề" })).toBeNull();
	});
});

describe("topics", () => {
	it("replaces the chat list with the topic list and opens a topic", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.forum}`);

		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		const rows = within(topics).getAllByRole("button");
		expect(rows[0]?.textContent).toContain("Chung");
		expect(within(topics).getByRole("img", { name: "Đã đóng, chỉ admin gửi được" })).toBeTruthy();
		expect(screen.getByText("Đã ẩn · 1 · chỉ admin thấy")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Về danh sách chat" })).toBeTruthy();

		await userEvent.click(within(topics).getByRole("button", { name: /Thiết kế/ }));
		expect(window.location.pathname).toBe(`/c/${demo.ids.forum}/t/12`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Ổn, API trả đủ trường cho màn này rồi.", {}, LONG)).toBeTruthy();
		expect(within(log).queryByText("PR phân trang lịch sử đã merge")).toBeNull();
		expect(screen.getByPlaceholderText("Nhập @ để nhắc tên, tin nhắn tới Thiết kế")).toBeTruthy();
		const info = await screen.findByRole("complementary", { name: "Thông tin chủ đề" }, LONG);
		expect(within(info).getByRole("heading", { name: "Thiết kế" })).toBeTruthy();
		expect(within(info).getByTitle(`chat.example.test/c/${demo.ids.forum}/t/12`)).toBeTruthy();
	});

	it("sends into the open topic and lets admins close a topic from its menu", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.forum}/t/4`);
		const box = await screen.findByPlaceholderText("Nhập @ để nhắc tên, tin nhắn tới Backend API", {}, LONG);
		await userEvent.type(box, "Mình review PR này{Enter}");
		await waitFor(() => expect(demo.fixture.sent).toContainEqual({ chatId: demo.ids.forum, topicId: 4, text: "Mình review PR này", replyToSeq: 0 }));
		const log = screen.getByRole("log", { name: "Tin nhắn" });
		expect(await within(log).findByText("Mình review PR này", {}, LONG)).toBeTruthy();

		const topics = await screen.findByRole("list", { name: "Chủ đề" }, LONG);
		fireEvent.contextMenu(within(topics).getByRole("button", { name: /Backend API/ }));
		await userEvent.click(within(screen.getByRole("menu", { name: "Thao tác với chủ đề Backend API" })).getByRole("menuitem", { name: "Đóng chủ đề" }));
		await waitFor(() => expect(within(topics).getAllByRole("img", { name: "Đã đóng, chỉ admin gửi được" })).toHaveLength(2));
	});
});

describe("info panel", () => {
	it("shows group members with roles and the admin actions", async () => {
		await openOps();
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		expect(within(info).getByRole("heading", { name: "Vận hành hệ thống" })).toBeTruthy();
		expect(within(info).getByText("Kênh trực sự cố của đội vận hành. Cảnh báo tự động vào đây.")).toBeTruthy();
		await within(info).findByText("Quang Huy", {}, LONG);
		expect(within(info).getByText("Trưởng nhóm")).toBeTruthy();
		expect(within(info).getAllByText("Phó nhóm").length).toBeGreaterThan(0);
		expect(within(info).queryByText("Admin")).toBeNull();
		expect(within(info).getByRole("link", { name: /Quản lý nhóm/ })).toBeTruthy();
		expect(within(info).getByRole("button", { name: /Rời nhóm/ })).toBeTruthy();
		// Zalo order: quick actions, then members with "Xem tất cả", then the invite link, Quản lý, leave.
		const order = [...info.querySelectorAll(".quick-acts, .info-sec h3, .info-sec .link-row")].map((node) => node.textContent?.trim() ?? "");
		expect(order[0]).toContain("Tắt thông báo");
		expect(order.findIndex((text) => text.startsWith("Thành viên · "))).toBeLessThan(order.indexOf("Link mời"));
		expect(order.indexOf("Link mời")).toBeLessThan(order.findIndex((text) => text.includes("Quản lý nhóm")));
		expect(within(info).getByRole("button", { name: "Xem tất cả 5 thành viên" })).toBeTruthy();

		await userEvent.click(within(info).getByRole("button", { name: "Tạo link mời" }));
		expect(await within(info).findByTitle("chat.example.test/join/q7XrN2bTk4RbZ9wLc1Np1")).toBeTruthy();

		await userEvent.click(within(info).getByRole("button", { name: "Đóng cột thông tin (Esc)" }));
		expect(screen.queryByRole("complementary", { name: "Thông tin nhóm" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Thông tin chat" }));
		expect(await screen.findByRole("complementary", { name: "Thông tin nhóm" })).toBeTruthy();
	});

	it("shows the other person in a 1-1 chat and blocks them", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.lanAnh}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		expect(await within(info).findByTitle("@lananh", {}, LONG)).toBeTruthy();
		expect(within(info).getByText("Thiết kế sản phẩm. Hỏi về giao diện cứ nhắn.")).toBeTruthy();

		expect(within(info).getByRole("button", { name: /Tạo nhóm/ })).toBeTruthy();
		await userEvent.click(within(info).getByRole("button", { name: /^Chặn/ }));
		await waitFor(() => expect(demo.fixture.blocked.has(demo.ids.users.lan)).toBe(true));
		expect(within(info).getByRole("button", { name: /Bỏ chặn/ })).toBeTruthy();
	});
});

describe("dialogs", () => {
	it("forwards a message to the chats picked", async () => {
		const { demo, log } = await openOps();
		const target = within(log).getByText("Dashboard ổn định.").closest<HTMLElement>(".msg");
		if (target === null) throw new Error("message not found");
		fireEvent.contextMenu(target);
		await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Chuyển tiếp" }));

		const dialog = await screen.findByRole("dialog", { name: "Chuyển tiếp tới" });
		expect(within(dialog).getByRole("button", { name: "Chọn chat để gửi" })).toHaveProperty("disabled", true);
		await userEvent.type(within(dialog).getByRole("searchbox", { name: "Tìm chat" }), "team mobile");
		await userEvent.click(within(dialog).getByRole("checkbox", { name: /Team Mobile/ }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi tới 1 chat" }));
		await waitFor(() => expect(demo.fixture.forwards).toEqual([{ from: demo.ids.ops, seqs: [expect.any(Number)], to: demo.ids.mobile }]));
	});

	it("reports a message with a reason and blocks the sender", async () => {
		const { demo, log } = await openOps();
		const target = within(log).getByText("Dashboard ổn định.").closest<HTMLElement>(".msg");
		if (target === null) throw new Error("message not found");
		fireEvent.contextMenu(target);
		await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Báo cáo" }));

		const dialog = await screen.findByRole("dialog", { name: "Báo cáo tin nhắn" });
		const submit = within(dialog).getByRole("button", { name: "Gửi báo cáo" });
		expect(submit).toHaveProperty("disabled", true);
		await userEvent.click(within(dialog).getByRole("radio", { name: /Lừa đảo/ }));
		await userEvent.click(submit);
		expect(await screen.findByText("Đã gửi báo cáo")).toBeTruthy();
		// ReportReason.SCAM: the reason has its own value now, the comment stays the user's.
		expect(demo.fixture.reports).toEqual([{ target: expect.stringMatching(/^messages:/), reason: 7, comment: "" }]);
		expect(demo.fixture.blocked.has(demo.ids.users.lan)).toBe(true);
	});
});

describe("server features", () => {
	it("lists who read your message in a small group", async () => {
		const { log } = await openOps();
		const own = within(log).getByText("Mục 3 ổn, extension đã lên bản mới.").closest<HTMLElement>(".msg");
		if (own === null) throw new Error("message not found");
		fireEvent.contextMenu(own);
		await userEvent.click(within(await screen.findByRole("menu", { name: "Thao tác với tin của bạn" })).getByRole("menuitem", { name: "Xem ai đã xem" }));
		const dialog = await screen.findByRole("dialog", { name: "Đã xem · 2 người" }, LONG);
		expect(within(dialog).getByText("Quang Huy")).toBeTruthy();
		expect(within(dialog).getByText("2 thành viên chưa xem. Bot trong nhóm không được tính.")).toBeTruthy();
	});

	it("offers an invite link when privacy refuses adding someone", async () => {
		const demo = seedDemo();
		const outsider = demo.fixture.addUser("Ngọc Mai", { username: "ngocmai" });
		demo.fixture.refusesGroups.add(outsider);
		await openOps(demo);
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(within(info).getByRole("button", { name: /Thêm thành viên/ }));
		const picker = await screen.findByRole("dialog", { name: "Thêm thành viên" }, LONG);
		await userEvent.type(within(picker).getByRole("searchbox"), "ngoc");
		await userEvent.click(await within(picker).findByRole("checkbox", { name: /Ngọc Mai/ }, LONG));
		await userEvent.click(within(picker).getByRole("button", { name: "Thêm 1 người" }));

		const failed = await screen.findByRole("dialog", { name: "Chưa thêm được 1 người" }, LONG);
		await userEvent.click(await within(failed).findByRole("button", { name: "Gửi link mời" }, LONG));
		await waitFor(() => expect(demo.fixture.sent.some((m) => m.text.startsWith("https://chat.example.test/join/"))).toBe(true), LONG);
		expect(await within(failed).findByText("Đã gửi link mời cho Ngọc Mai")).toBeTruthy();
	});

	it("lists, creates and revokes invite links on the admin page", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin`);
		expect(await screen.findByRole("heading", { name: "Link mời" }, LONG)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Tạo link" }));
		expect(await screen.findByTitle("chat.example.test/join/q7XrN2bTk4RbZ9wLc1Np1", {}, LONG)).toBeTruthy();
		expect(demo.fixture.invites[0]?.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 86_400);
		await userEvent.click(screen.getByRole("button", { name: "Thu hồi link" }));
		expect(await screen.findByText("Đã thu hồi")).toBeTruthy();
	});

	it("previews an invite before joining", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/join/teammobile");
		const dialog = await screen.findByRole("dialog", { name: "Team Mobile" }, LONG);
		expect(within(dialog).getByText("Nhóm · 24 thành viên")).toBeTruthy();
		expect(within(dialog).getByRole("button", { name: "Tham gia nhóm" })).toBeTruthy();
	});

	it("shows a dead invite link as no longer usable", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/+expiredlink");
		expect(await screen.findByRole("dialog", { name: "Link mời không còn dùng được" }, LONG)).toBeTruthy();
	});
});

const LONG_LINK = "https://chat.hoandat.com/join/V-puXq3hT9mZ2cLk8RbkVUp";

/** A channel you own with three subscribers and a long invite link. */
function ownedChannel() {
	const demo = seedDemo();
	const f = demo.fixture;
	const { minh, ha, huy } = demo.ids.users;
	const chatId = f.createChat(ChatType.CHANNEL, "Thông báo vận hành", [f.selfId, minh, ha, huy], { myRole: MemberRole.OWNER });
	f.setRole(chatId, f.selfId, MemberRole.OWNER);
	f.send(f.selfId, chatId, "", { action: { kind: { case: "chatCreated", value: { title: "Thông báo vận hành" } } } });
	f.inviteLinks.set(chatId, [
		{ $typeName: "app.v1.InviteLink", link: LONG_LINK, creatorId: BigInt(f.selfId), expiresAt: 0n, usageLimit: 0, usageCount: 0, revoked: false },
	]);
	return { demo, chatId };
}

describe("channels", () => {
	it("names a channel a channel in the list, the chat and the info panel", async () => {
		const { demo, chatId } = ownedChannel();
		renderMessaging(demo.fixture, `/c/${chatId}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Bạn đã tạo kênh “Thông báo vận hành”", {}, LONG)).toBeTruthy();
		expect(await within(chatList()).findByText("Bạn đã tạo kênh “Thông báo vận hành”", {}, LONG)).toBeTruthy();

		const info = await screen.findByRole("complementary", { name: "Thông tin kênh" }, LONG);
		expect(within(info).getByText("Kênh · 4 người đăng ký")).toBeTruthy();
		expect(await within(info).findByText("Chủ kênh", {}, LONG)).toBeTruthy();
		expect(within(info).queryByText(/Trưởng nhóm|Phó nhóm|thành viên/)).toBeNull();
		expect(within(info).getByRole("heading", { name: "Người đăng ký · 4" })).toBeTruthy();
		expect(within(info).getByRole("button", { name: "Xem tất cả 4 người đăng ký" })).toBeTruthy();
		// The long invite link stays whole in the DOM and the tooltip; only its look is shortened.
		expect(await within(info).findByTitle("chat.hoandat.com/join/V-puXq3hT9mZ2cLk8RbkVUp", {}, LONG)).toBeTruthy();
		expect(within(info).getByRole("button", { name: "Sao chép link mời" })).toBeTruthy();

		await userEvent.click(within(info).getByRole("button", { name: /Thêm người đăng ký/ }));
		const picker = await screen.findByRole("dialog", { name: "Thêm người đăng ký" }, LONG);
		await userEvent.type(within(picker).getByRole("searchbox"), "khongcoai");
		expect(await within(picker).findByText("Không tìm thấy ai", {}, LONG)).toBeTruthy();
	});

	it("shows the owner's own posts as the channel's, on the left under the channel name", async () => {
		const { demo, chatId } = ownedChannel();
		demo.fixture.send(demo.fixture.selfId, chatId, "Bảo trì tối thứ Bảy");
		renderMessaging(demo.fixture, `/c/${chatId}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const text = await within(log).findByText("Bảo trì tối thứ Bảy", {}, LONG);
		const post = text.closest(".msg");
		expect(post?.classList.contains("post")).toBe(true);
		expect(post?.classList.contains("mine")).toBe(false);
		expect(post?.querySelector(".who")?.textContent).toBe("Thông báo vận hành");
		// No read ticks on a post: a channel has no "Đã xem".
		expect(post?.querySelector(".stamp [aria-label='Đã xem'], .stamp [aria-label='Đã gửi']")).toBeNull();
	});

	it("offers leaving and, to the owner, deleting on the channel's Quản lý kênh page", async () => {
		const { demo, chatId } = ownedChannel();
		renderMessaging(demo.fixture, `/c/${chatId}/admin`);
		expect(await screen.findByRole("heading", { name: "Rời kênh" }, LONG)).toBeTruthy();
		expect(screen.getByText("Quản lý kênh")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Người đăng ký" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Chủ kênh và admin" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Tất cả người đăng ký/ })).toBeTruthy();
		expect(await screen.findByText("Người tạo kênh", {}, LONG)).toBeTruthy();
		expect(screen.getByText("Thông báo vận hành · 4 người đăng ký · bạn là chủ kênh")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Rời kênh" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Xoá kênh" })).toBeTruthy();
		expect(screen.queryByText(/nhóm|thành viên/)).toBeNull();
	});

	it("keeps the group wording and drops deleting on the group admin page", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin`);
		expect(await screen.findByRole("heading", { name: "Rời nhóm" }, LONG)).toBeTruthy();
		expect(screen.getByRole("button", { name: /Tất cả thành viên/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Xoá nhóm/ })).toBeNull();
	});

	it("creates a channel without a public or private choice", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await userEvent.click((await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement);
		const start = await newChatDialog();
		await userEvent.click(within(start).getByRole("button", { name: "Tạo kênh" }));
		const dialog = await screen.findByRole("dialog", { name: "Tạo kênh" }, LONG);
		expect(within(dialog).queryByRole("radio")).toBeNull();
		expect(within(dialog).queryByText(/Công khai|Riêng tư|bản sau/)).toBeNull();
		expect(within(dialog).getByText(/Kênh chỉ vào được bằng link mời/)).toBeTruthy();

		await userEvent.type(within(dialog).getByRole("textbox", { name: "Tên kênh" }), "Tin nội bộ");
		await userEvent.click(within(dialog).getByRole("button", { name: "Tạo kênh" }));
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Bạn đã tạo kênh “Tin nội bộ”", {}, LONG)).toBeTruthy();
	});
});

describe("people search", () => {
	async function openNewChat() {
		const demo = seedDemo();
		renderMessaging(demo.fixture);
		await userEvent.click((await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement);
		return { demo, dialog: await newChatDialog() };
	}

	it("explains an empty result, and recognises your own account", async () => {
		const { demo, dialog } = await openNewChat();
		const box = within(dialog).getByRole("searchbox", { name: "Tìm người" });
		await userEvent.type(box, "khongcoai");
		expect(await within(dialog).findByText("Không tìm thấy ai", {}, LONG)).toBeTruthy();
		expect(within(dialog).getByText(/cần đăng nhập chat\.hoandat\.com ít nhất một lần/)).toBeTruthy();

		await userEvent.clear(box);
		await userEvent.type(box, `@${demo.fixture.selfUsername}`);
		expect(await within(dialog).findByText("Đây là tài khoản của bạn", {}, LONG)).toBeTruthy();
		expect(within(dialog).queryByText("Không tìm thấy ai")).toBeNull();
	});

	it("shows the same empty state when picking group members", async () => {
		const { dialog } = await openNewChat();
		await userEvent.click(within(dialog).getByRole("button", { name: "Tạo nhóm" }));
		const group = await screen.findByRole("dialog", { name: "Tạo nhóm" }, LONG);
		await userEvent.type(within(group).getByRole("searchbox"), "khongcoai");
		expect(await within(group).findByText("Không tìm thấy ai", {}, LONG)).toBeTruthy();
	});
});

describe("a private chat the person refuses", () => {
	async function messageRefusingPerson(fixture: ChatFixture): Promise<void> {
		const nam = fixture.addUser("Hoàng Nam", { username: "hoangnam" });
		fixture.refusesMessages.add(nam);
		renderMessaging(fixture);
		await userEvent.click((await screen.findAllByRole("button", { name: "Tạo chat mới" }, LONG))[0] as HTMLElement);
		const dialog = await newChatDialog();
		await userEvent.type(within(dialog).getByRole("searchbox", { name: "Tìm người" }), "hoangnam");
		await userEvent.click(await within(dialog).findByRole("button", { name: "Nhắn tin" }, LONG));
	}

	it("says so without naming the setting or asking to retry", async () => {
		await messageRefusingPerson(new ChatFixture());
		const toast = await screen.findByText("Không thể nhắn tin cho người này lúc này.", {}, LONG);
		expect(toast.textContent).not.toMatch(/thử lại|danh bạ|link mời/);
	});

	it("hints at invite links when the user can invite people to a group", async () => {
		const fixture = new ChatFixture();
		const minh = fixture.addUser("Minh");
		const chat = fixture.createChat(ChatType.GROUP, "Nhóm đọc sách", [fixture.selfId, minh], { myRole: MemberRole.OWNER });
		fixture.setRole(chat, fixture.selfId, MemberRole.OWNER);
		await messageRefusingPerson(fixture);
		expect(await screen.findByText("Không thể nhắn tin cho người này lúc này. Bạn có thể mời họ vào nhóm bằng link mời.", {}, LONG)).toBeTruthy();
	});
});

describe("nothing without server support", () => {
	it("shows no shared media, group photo or disabled placeholders", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.channel}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin kênh" }, LONG);
		expect(within(info).getByRole("button", { name: /Rời kênh/ })).toBeTruthy();
		expect(within(info).getByRole("button", { name: /Tắt thông báo/ })).toBeTruthy();
		expect(within(info).queryByText(/Ảnh, file, link|Ảnh và video/)).toBeNull();
		expect(screen.queryByText(/bản sau/)).toBeNull();
		expect(document.querySelector("button:disabled[title]")).toBeNull();
	});
});

describe("appearance and shortcuts", () => {
	it("keeps the theme and message size on this device", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/appearance");
		expect(await screen.findByRole("heading", { level: 1, name: "Giao diện" }, LONG)).toBeTruthy();
		await userEvent.click(within(await screen.findByRole("group", { name: "Chủ đề" }, LONG)).getByRole("button", { name: "Tối" }));
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(window.localStorage.getItem("app:theme")).toBe("dark");
		fireEvent.change(screen.getByRole("slider", { name: "Cỡ chữ tin nhắn" }), { target: { value: "18" } });
		expect(screen.getByText("18 px")).toBeTruthy();
		expect(document.documentElement.style.getPropertyValue("--msg-font")).toBe("1.125rem");
		await userEvent.click(within(screen.getByRole("group", { name: "Chủ đề" })).getByRole("button", { name: "Theo hệ thống" }));
		expect(document.documentElement.dataset.theme).toBeUndefined();
	});

	it("lists the shortcuts and opens the list with Ctrl+/", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}`);
		await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		fireEvent.keyDown(document, { key: "/", ctrlKey: true });
		expect(await screen.findByRole("heading", { level: 1, name: "Phím tắt" }, LONG)).toBeTruthy();
		await userEvent.click(within(await screen.findByRole("group", { name: "Cách ghi phím" }, LONG)).getByRole("button", { name: "Windows, Linux" }));
		const search = screen.getByText("Tìm kiếm", { selector: "dt" }).closest(".key-row");
		expect(search?.textContent).toContain("CtrlK");
		expect(search?.textContent).toContain("CtrlF");
		expect(screen.getByText("Bộ lọc Tất cả, Cá nhân, Nhóm, Bot, Chưa đọc")).toBeTruthy();
	});
});

describe("settings", () => {
	it("adds privacy, blocked users (from the server) and notifications to settings", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/privacy");
		expect(await screen.findByRole("heading", { level: 1, name: "Quyền riêng tư" }, LONG)).toBeTruthy();
		const email = await screen.findByRole("group", { name: "Ai tìm tôi bằng email" }, LONG);
		expect(within(email).getByRole("button", { name: "Không ai" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(within(email).getByRole("button", { name: "Danh bạ" }));
		expect(await screen.findByText("Đã lưu cài đặt riêng tư")).toBeTruthy();

		await userEvent.click(screen.getByRole("link", { name: "Người đã chặn" }));
		expect(await screen.findByText("Nhận quà 24h", {}, LONG)).toBeTruthy();
		await act(async () => {
			await userEvent.click(screen.getAllByRole("button", { name: "Bỏ chặn" })[0] as HTMLElement);
		});
		expect(await screen.findByText("Đã bỏ chặn Nhận quà 24h")).toBeTruthy();
		await waitFor(() => expect(demo.fixture.blocked.size).toBe(1));
		expect(screen.getByText("@cryptosignal_bot", { exact: false })).toBeTruthy();
	});
});

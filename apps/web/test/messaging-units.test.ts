import { describe, expect, it } from "vitest";
import shellEnSource from "../src/i18n/en.ts?raw";
import shellViSource from "../src/i18n/vi.ts?raw";
import enScreensSource from "../src/messaging/copy/en-screens.ts?raw";
import enSource from "../src/messaging/copy/en.ts?raw";
import viScreensSource from "../src/messaging/copy/vi-screens.ts?raw";
import viSource from "../src/messaging/copy/vi.ts?raw";
import type { MessageEntity } from "@app/core";
import { vi as copy } from "../src/messaging/copy/vi.ts";
import { en } from "../src/messaging/copy/en.ts";
import { enScreens } from "../src/messaging/copy/en-screens.ts";
import { viScreens } from "../src/messaging/copy/vi-screens.ts";
import { actionText, chatKind, countLabel, dayLabel, inFolder, isTrustedHost, listTime, oneLine, orgDomain, recentTime } from "../src/messaging/data/format.ts";
import { highlight } from "../src/messaging/data/highlight.ts";
import type { Remote, ServerTopic } from "../src/messaging/data/remote.ts";
import { loadNextTopicPage, loadTopicPages, toneForColor, topicIcon } from "../src/messaging/data/topic-mapping.ts";
import { isOwnAccount } from "../src/messaging/ui/people-search.ts";
import { entityTree } from "../src/messaging/ui/rich-text.tsx";
import { matchRoute, paths, returnPathFor } from "../src/router.tsx";
import { loginUrl } from "../src/screens/welcome.tsx";
import { presenceText } from "../src/messaging/ui/presence.tsx";
import { autoGroupName } from "../src/messaging/ui/create-dialogs.tsx";
import { initialLetter } from "../src/messaging/ui/contacts.tsx";
import { clampListWidth } from "../src/messaging/ui/list-resizer.tsx";

const NOW = new Date(2026, 9, 14, 18, 0); // Wed 14/10/2026 18:00 local time
const at = (y: number, m: number, d: number, h = 9, min = 42) => Math.floor(new Date(y, m, d, h, min).getTime() / 1000);

describe("format", () => {
	it("formats list times like the mock: clock, yesterday, weekday, date", () => {
		expect(listTime(at(2026, 9, 14), NOW, "vi", copy)).toBe("09:42");
		expect(listTime(at(2026, 9, 13), NOW, "vi", copy)).toBe("Hôm qua");
		expect(listTime(at(2026, 9, 12), NOW, "vi", copy)).toBe("T2");
		expect(listTime(at(2026, 9, 3), NOW, "vi", copy)).toBe("03/10");
		expect(dayLabel(at(2026, 9, 14), NOW, "vi", copy)).toBe("Hôm nay");
		expect(dayLabel(at(2026, 9, 12), NOW, "vi", copy)).toBe("Thứ Hai, 12/10");
	});

	it("formats recent times for session rows: today and yesterday with the clock, else the full date", () => {
		const viWords = { today: "hôm nay", yesterday: "hôm qua" };
		expect(recentTime(at(2026, 9, 14, 16, 40), NOW, "vi", viWords)).toBe("hôm nay 16:40");
		expect(recentTime(at(2026, 9, 13, 21, 52), NOW, "vi", viWords)).toBe("hôm qua 21:52");
		expect(recentTime(at(2026, 9, 12, 8, 5), NOW, "vi", viWords)).toBe("12/10/2026");
		expect(recentTime(at(2025, 11, 31), NOW, "vi", viWords)).toBe("31/12/2025");
		expect(recentTime(at(2026, 9, 13, 21, 52), NOW, "en", { today: "today", yesterday: "yesterday" })).toBe("yesterday 21:52");
		expect(recentTime(at(2026, 9, 2), NOW, "en", { today: "today", yesterday: "yesterday" })).toBe("10/02/2026");
	});

	it("maps chats to folders; channels only show under All and, when unread, Unread", () => {
		const bot = { id: 1, username: "b", name: "Bot", bio: "", isBot: true, isSelf: false, isBlocked: false };
		expect(chatKind(null, bot, false)).toBe("bot");
		expect(inFolder("bot", "bot", false)).toBe(true);
		expect(inFolder("bot", "private", false)).toBe(false);
		expect(inFolder("forum", "group", false)).toBe(true);
		expect(inFolder("channel", "group", true)).toBe(false);
		expect(inFolder("channel", "all", false)).toBe(true);
		expect(inFolder("channel", "unread", true)).toBe(true);
		expect(inFolder("private", "unread", false)).toBe(false);
	});

	it("says presence the way Zalo users know it", () => {
		const now = 1_760_000_000;
		expect(presenceText({ kind: "online" }, copy, "vi", now)).toBe("Đang hoạt động");
		expect(presenceText({ kind: "offline", lastSeen: now - 20 }, copy, "vi", now)).toBe("Vừa truy cập");
		expect(presenceText({ kind: "offline", lastSeen: now - 12 * 60 }, copy, "vi", now)).toBe("Truy cập 12 phút trước");
		expect(presenceText({ kind: "offline", lastSeen: now - 2 * 3600 }, copy, "vi", now)).toBe("Truy cập 2 giờ trước");
		expect(presenceText({ kind: "recently" }, copy, "vi", now)).toBe("Truy cập gần đây");
		expect(presenceText({ kind: "last_week" }, copy, "vi", now)).toBe("Truy cập trong tuần");
	});

	it("names a group without a name after its first three members", () => {
		expect(autoGroupName(["Quang Huy", "Lan Anh"])).toBe("Quang Huy, Lan Anh");
		expect(autoGroupName(["A", "B", "C", "D"])).toBe("A, B, C");
		expect(autoGroupName(["x".repeat(100), "y".repeat(100)]).length).toBe(128);
	});

	it("files contacts under their Vietnamese initial", () => {
		expect(initialLetter("Đức Anh")).toBe("Đ");
		expect(initialLetter("ánh dương")).toBe("A");
		expect(initialLetter("Bảo Ngọc")).toBe("B");
		expect(initialLetter("123")).toBe("#");
	});

	it("keeps the chat list between 280 and 420px", () => {
		expect(clampListWidth(100)).toBe(280);
		expect(clampListWidth(333.4)).toBe(333);
		expect(clampListWidth(900)).toBe(420);
	});

	it("trusts only the tenant's own hosts", () => {
		expect(isTrustedHost("wiki.hoandat.com", "chat.hoandat.com")).toBe(true);
		expect(isTrustedHost("hoandat.com", "chat.hoandat.com")).toBe(true);
		expect(isTrustedHost("hoandat.com.evil.io", "chat.hoandat.com")).toBe(false);
		expect(isTrustedHost("docs.example.com", "chat.hoandat.com")).toBe(false);
	});

	it("collapses whitespace in previews", () => {
		expect(oneLine("a\n\n  b")).toBe("a b");
		expect(oneLine("x".repeat(200)).length).toBe(141);
	});
});

describe("highlight", () => {
	it("marks accent-insensitive matches in the original text", () => {
		const segments = highlight("Build iOS lỗi ký số, đang xem", "ky so dang");
		expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["ký", "số", "đang"]);
		expect(segments.map((s) => s.text).join("")).toBe("Build iOS lỗi ký số, đang xem");
	});

	it("marks matches inside words, and only word starts for short words alone", () => {
		const marks = (text: string, query: string) =>
			highlight(text, query)
				.filter((s) => s.match)
				.map((s) => s.text);
		expect(marks("Lịch trực tuần này", "uần")).toEqual(["uần"]);
		expect(marks("Lịch trực tuần này", "truc tu")).toEqual(["trực", "tu"]);
		expect(marks("Lịch trực tuần này", "ich uc")).toEqual(["ịch", "ực"]);
		// Short words alone match word starts only, as the search does.
		expect(marks("Người trong nhóm", "ng")).toEqual(["Ng"]);
		expect(marks("đi ăn trưa, khoan", "di an")).toEqual(["đi", "ăn"]);
		// Punctuation of the query is not part of a word.
		expect(marks("Giá 1.250.000 ₫", "1.250.000₫")).toEqual(["1.250.000"]);
		expect(highlight("Lịch trực tuần này", "uần").map((s) => s.text).join("")).toBe("Lịch trực tuần này");
	});

	it("returns the text unmarked for an empty query", () => {
		expect(highlight("Xin chào", " ")).toEqual([{ text: "Xin chào", match: false }]);
	});
});

describe("entity tree", () => {
	it("nests entities and drops partial overlaps and out-of-range spans", () => {
		const text = "bold italic tail";
		const entities: MessageEntity[] = [
			{ type: "bold", offset: 0, length: 11 },
			{ type: "italic", offset: 5, length: 6 },
			{ type: "code", offset: 8, length: 6 },
			{ type: "url", offset: 14, length: 10 },
		];
		const root = entityTree(text, entities);
		expect(root.children).toHaveLength(1);
		expect(root.children[0]?.entity?.type).toBe("bold");
		expect(root.children[0]?.children.map((c) => c.entity?.type)).toEqual(["italic"]);
	});
});

describe("routes", () => {
	it("adds chat, topic, admin, invite and moderation routes only with messaging on", () => {
		expect(matchRoute("/settings/privacy")).toEqual({ name: "settings", tab: "privacy" });
		expect(matchRoute("/c/5001")).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "chat" });
		expect(matchRoute(paths.topic(5001, 12))).toEqual({ name: "chat", chatId: 5001, topicId: 12, panel: "chat" });
		expect(matchRoute(paths.chatAdmin(5001))).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "admin" });
		expect(matchRoute("/settings/privacy")).toEqual({ name: "settings", tab: "privacy" });
		expect(matchRoute(paths.moderation("R-1", true))).toEqual({ name: "moderation", reportId: "R-1", actions: true });
		expect(matchRoute(paths.feedback())).toEqual({ name: "feedback" });
		expect(matchRoute(paths.moderationLog())).toEqual({ name: "moderationLog" });
		expect(matchRoute(paths.moderationBot(7001))).toEqual({ name: "moderationBot", botId: 7001 });
		expect(matchRoute("/moderation/bots/x")).toBeNull();
		expect(matchRoute("/c/0")).toBeNull();
		expect(matchRoute("/c/12345678901234567")).toBeNull();
		expect(matchRoute("/moderation/%E0")).toBeNull();
	});

	it("opens the invite links the server hands out, and the older /+ form", () => {
		const token = "V-puXq3hT9mZ2cLk8RbkVUp";
		expect(paths.invite(token)).toBe(`/join/${token}`);
		expect(matchRoute(`/join/${token}`)).toEqual({ name: "invite", token });
		expect(matchRoute(`/join/${token}/`)).toEqual({ name: "invite", token });
		expect(matchRoute(`/+${token}`)).toEqual({ name: "invite", token });
		expect(matchRoute("/join/")).toBeNull();
		expect(matchRoute(`/join/${token}/more`)).toBeNull();
		expect(matchRoute("/join/bad token")).toBeNull();
	});

	it("asks sign-in to come back to the page a visitor opened", () => {
		expect(returnPathFor("/join/V-puXq3hT9mZ2cLk8RbkVUp")).toBe("/join/V-puXq3hT9mZ2cLk8RbkVUp");
		expect(returnPathFor("/")).toBeUndefined();
		expect(returnPathFor("/no/such/page")).toBeUndefined();
		expect(loginUrl("vi", false, "/c/5001")).toBe("/auth/login?locale=vi&return_to=%2Fc%2F5001");
		expect(loginUrl("en", true, "/")).toBe("/auth/login?prompt=create&locale=en");
	});

	it("maps a topic's icon colour to the nearest avatar tone", () => {
		expect(toneForColor(0x6fb9f0, 4)).toBe("blue");
		expect(toneForColor(0xffd67e, 4)).toBe("amber");
		expect(toneForColor(0xcb86db, 4)).toBe("violet");
		expect(toneForColor(0x8eee98, 4)).toBe("green");
		expect(toneForColor(0xff93b2, 4)).toBe("red");
		expect(toneForColor(0x808080, 4)).toBe("grey");
		expect(toneForColor(0, 4)).toBe("cyan");
	});
});

describe("copy", () => {
	it("has the same keys in Vietnamese and English", () => {
		const keys = (value: object, prefix = ""): string[] =>
			Object.entries(value).flatMap(([key, child]) =>
				child !== null && typeof child === "object" && !Array.isArray(child) ? keys(child as object, `${prefix}${key}.`) : [`${prefix}${key}`],
			);
		expect(keys(en).sort()).toEqual(keys(copy).sort());
		expect(keys(enScreens).sort()).toEqual(keys(viScreens).sort());
	});
});

describe("channel wording", () => {
	const nameOf = () => "Minh";

	it("names a channel a channel in system messages, in both languages", () => {
		const created = { kind: "chat_created", title: "Thông báo" } as const;
		expect(actionText(created, "Bạn", nameOf, copy, true)).toBe("Bạn đã tạo kênh “Thông báo”");
		expect(actionText(created, "Bạn", nameOf, copy, false)).toBe("Bạn đã tạo nhóm “Thông báo”");
		expect(actionText({ kind: "member_left" }, "Hà", nameOf, copy, true)).toBe("Hà đã rời kênh");
		expect(actionText({ kind: "member_removed", userId: 7, by: 1 }, "Bạn", nameOf, copy, true)).toBe("Bạn đã xoá Minh khỏi kênh");
		expect(actionText({ kind: "title_changed", title: "Tin" }, "Bạn", nameOf, copy, true)).toBe("Bạn đã đổi tên kênh thành “Tin”");
		expect(actionText({ kind: "photo_changed" }, "Bạn", nameOf, copy, true)).toBe("Bạn đã đổi ảnh kênh");
		expect(actionText(created, "You", nameOf, en, true)).toBe("You created the channel “Thông báo”");
		expect(actionText(created, "You", nameOf, en, false)).toBe("You created the group “Thông báo”");
	});

	it("counts subscribers, not members, in a channel; groups have a leader and deputies", () => {
		expect(viScreens.info.membersHead(5, true)).toBe("Người đăng ký · 5");
		expect(viScreens.info.membersHead(5, false)).toBe("Thành viên · 5");
		expect(viScreens.info.addMembers(true)).toBe("Thêm người đăng ký");
		expect(viScreens.info.owner(true)).toBe("Chủ kênh");
		expect(viScreens.info.owner(false)).toBe("Trưởng nhóm");
		expect(viScreens.info.admin(true)).toBe("Admin");
		expect(viScreens.info.admin(false)).toBe("Phó nhóm");
		expect(viScreens.admin.groupTitle).toBe("Quản lý nhóm");
		expect(viScreens.ownerLeave.transferLeave(false)).toBe("Chọn và rời nhóm");
		expect(viScreens.admin.creator(true)).toBe("Người tạo kênh");
		expect(viScreens.admin.allMembers(true)).toBe("Tất cả người đăng ký");
		expect(viScreens.admin.leave(true)).toBe("Rời kênh");
		expect(enScreens.info.membersHead(1, true)).toBe("Subscribers · 1");
		expect(enScreens.admin.sub("News", 2, true)).toBe("News · 2 subscribers");
	});

	it("has no release labels or coming-later teasers in the product copy", () => {
		for (const source of [viSource, enSource, viScreensSource, enScreensSource, shellViSource, shellEnSource]) {
			expect(source).not.toMatch(/bản sau|có ở bản|Sau R\d|later release|coming later|coming soon/i);
		}
	});

	it("uses the agreed Vietnamese terms: Huỷ/Xoá spelling, Thu hồi, Tắt thông báo, Đã xem, Thả cảm xúc, no Kết bạn", () => {
		for (const source of [viSource, viScreensSource, shellViSource]) {
			// Only the words people read: string and template literals, not keys.
			const texts = source.match(/"[^"\n]*"|`[^`\n]*`/g) ?? [];
			expect(texts.filter((text) => /Hủy|hủy|Xóa|xóa|Kết bạn|kết bạn|[Tt]ắt tiếng|reaction|(?<!\{)\bonline\b(?!\})/.test(text))).toEqual([]);
		}
		expect(copy.message.deleted).toBe("Tin nhắn đã thu hồi");
		expect(copy.message.read).toBe("Đã xem");
		expect(copy.list.muted).toBe("Đã tắt thông báo");
		expect(viScreens.menu.react).toBe("Thả cảm xúc");
		expect(viScreens.menu.moreReactions).toBe("Chọn biểu cảm");
		expect(viScreens.menu.recall).toBe("Thu hồi");
		expect(viScreens.menu.deleteForMe).toBe("Xoá ở phía tôi");
		expect(viScreens.menu.readBy).toBe("Xem ai đã xem");
		expect(viScreens.listMenu.markUnread).toBe("Đánh dấu chưa đọc");
		expect(viScreens.contacts.add).toBe("Thêm vào danh bạ");
		expect(copy.composer.placeholder("Lan Anh")).toBe("Nhập tin nhắn tới Lan Anh");
		expect(copy.composer.placeholderGroup("Vận hành hệ thống")).toBe("Nhập @ để nhắc tên, tin nhắn tới Vận hành hệ thống");
		expect(copy.composer.hint).toBe("Enter gửi · Shift+Enter xuống dòng");
		expect(copy.convo.membersOnline(12, 3)).toBe("12 thành viên · 3 đang hoạt động");
		expect(viScreens.addFailed.reasonTooMany(false)).toBe("Nhóm đã đủ số thành viên tối đa");
	});
});

describe("people search", () => {
	const self = { username: "thang_dt", email: "thang@example.com" };

	it("recognises the signed-in user's own username or email", () => {
		expect(isOwnAccount("thang_dt", self)).toBe(true);
		expect(isOwnAccount("  @Thang_DT ", self)).toBe(true);
		expect(isOwnAccount("THANG@example.com", self)).toBe(true);
		expect(isOwnAccount("thang", self)).toBe(false);
		expect(isOwnAccount("", self)).toBe(false);
		expect(isOwnAccount("", { username: "", email: "" })).toBe(false);
	});
});

describe("capped counts", () => {
	it("shows the server's cap of 1000 as 999+", () => {
		expect(countLabel(1)).toBe("1");
		expect(countLabel(999)).toBe("999");
		expect(countLabel(1000)).toBe("999+");
	});

	it("takes the tenant's domain from the chat host", () => {
		expect(orgDomain("chat.hoandat.com")).toBe("hoandat.com");
		expect(orgDomain("localhost:5173")).toBe("localhost:5173");
	});
});

describe("forum topics", () => {
	const topic = (id: number, extra: Partial<ServerTopic> = {}): ServerTopic => ({
		id,
		title: `T${id}`,
		iconColor: 0,
		creatorId: 1,
		createdAt: 1,
		pinned: false,
		closed: false,
		hidden: false,
		topSeq: 0,
		readInboxMaxSeq: 0,
		unreadCount: 0,
		icon: "",
		messageCount: 0,
		unreadMentions: 0,
		...extra,
	});
	/** A Remote that answers only GetForumTopics, from fixed pages keyed by cursor. */
	const pagedRemote = (pages: Record<string, { topics: ServerTopic[]; nextCursor: string }>): Remote =>
		({
			forumTopics: async (_chatId: number, cursor = "") => {
				const page = pages[cursor];
				if (page === undefined) throw new Error(`unexpected cursor ${cursor}`);
				return { topics: page.topics, tops: [], nextCursor: page.nextCursor };
			},
		}) as unknown as Remote; // Only forumTopics is called by the paging helpers.

	it("uses the server's icon when the client has it", () => {
		expect(topicIcon("code")).toBe("code");
		expect(topicIcon("")).toBe("hash");
		expect(topicIcon("rocket-2")).toBe("hash");
	});

	it("loads pages up to the count asked for, then appends the next page without duplicates", async () => {
		const remote = pagedRemote({
			"": { topics: [topic(1), topic(2, { unreadCount: 1000, unreadMentions: 3, messageCount: 12, icon: "flag" })], nextCursor: "a" },
			a: { topics: [topic(3)], nextCursor: "b" },
			b: { topics: [topic(3, { title: "moved" }), topic(4)], nextCursor: "" },
		});
		const first = await loadTopicPages(remote, 7, 1, "https://chat.example.test");
		expect(first.topics.map((t) => t.id)).toEqual([1, 2]);
		expect(first.nextCursor).toBe("a");
		expect(first.topics[1]).toMatchObject({ unreadCount: 1000, unreadMentions: 3, messageCount: 12, icon: "flag" });

		const two = await loadTopicPages(remote, 7, 2, "https://chat.example.test");
		expect(two.topics.map((t) => t.id)).toEqual([1, 2, 3]);
		expect(two.pages).toBe(2);

		const all = await loadNextTopicPage(remote, 7, two, "https://chat.example.test");
		expect(all.topics.map((t) => `${t.id}:${t.title}`)).toEqual(["1:T1", "2:T2", "3:moved", "4:T4"]);
		expect(all.nextCursor).toBe("");
		expect(all.pages).toBe(3);
	});
});


import { describe, expect, it } from "vitest";
import type { MessageEntity } from "@app/core";
import { vi as copy } from "../src/messaging/copy/vi.ts";
import { en } from "../src/messaging/copy/en.ts";
import { enScreens } from "../src/messaging/copy/en-screens.ts";
import { viScreens } from "../src/messaging/copy/vi-screens.ts";
import { chatKind, dayLabel, inFolder, isTrustedHost, listTime, oneLine } from "../src/messaging/data/format.ts";
import { highlight } from "../src/messaging/data/highlight.ts";
import { toneForColor } from "../src/messaging/data/topic-mapping.ts";
import { entityTree } from "../src/messaging/ui/rich-text.tsx";
import { matchRoute, paths } from "../src/router.tsx";

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

	it("maps chats to folders; channels only show under All", () => {
		const bot = { id: 1, username: "b", name: "Bot", bio: "", isBot: true, isSelf: false, isBlocked: false };
		expect(chatKind(null, bot, false)).toBe("bot");
		expect(inFolder("bot", "bot")).toBe(true);
		expect(inFolder("bot", "private")).toBe(false);
		expect(inFolder("forum", "group")).toBe(true);
		expect(inFolder("channel", "group")).toBe(false);
		expect(inFolder("channel", "all")).toBe(true);
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
		expect(matchRoute("/c/5001")).toBeNull();
		expect(matchRoute("/settings/privacy")).toBeNull();
		expect(matchRoute("/c/5001", true)).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "chat" });
		expect(matchRoute(paths.topic(5001, 12), true)).toEqual({ name: "chat", chatId: 5001, topicId: 12, panel: "chat" });
		expect(matchRoute(paths.chatAdmin(5001), true)).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "admin" });
		expect(matchRoute("/+q7XrN2bTabc", true)).toEqual({ name: "invite", token: "q7XrN2bTabc" });
		expect(matchRoute("/settings/privacy", true)).toEqual({ name: "settings", tab: "privacy" });
		expect(matchRoute(paths.moderation("R-1", true), true)).toEqual({ name: "moderation", reportId: "R-1", actions: true });
		expect(matchRoute("/c/0", true)).toBeNull();
		expect(matchRoute("/c/12345678901234567", true)).toBeNull();
		expect(matchRoute("/moderation/%E0", true)).toBeNull();
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

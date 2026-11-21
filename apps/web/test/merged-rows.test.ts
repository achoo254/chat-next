// What a person's merged timeline draws: an album's photos as one row, the
// unread divider above the oldest message that was unread when the screen
// opened, and finding a quoted message on the timeline.
import type { StoredMessage } from "@achoo254/chat-core";
import { describe, expect, it } from "vitest";
import type { MergedItem } from "../src/messaging/people/merged-order.ts";
import { albumMessages, groupMerged, rowOfMessage, unreadDividerKey } from "../src/messaging/people/merged-rows.ts";

const SELF = 1;

function message(chatId: number, seq: number, extra: Partial<StoredMessage> = {}): MergedItem {
	const value = { chatId, seq, fromId: 9, text: "", groupedId: 0, recalled: false, action: null, date: seq * 60, ...extra } as StoredMessage;
	return { kind: "message", key: `${chatId}:s${seq}`, chatId, app: "telegram", message: value } as MergedItem;
}

describe("merged rows", () => {
	it("joins the consecutive messages of one album into one row, with the captioned message carrying the bubble", () => {
		const items = [message(3, 1), message(3, 2, { groupedId: 5 }), message(3, 3, { groupedId: 5, text: "Ảnh đi chơi" }), message(3, 4, { groupedId: 5 }), message(3, 5)];
		const groups = groupMerged(items);
		expect(groups.map((g) => g.key)).toEqual(["3:s1", "3:s2", "3:s5"]);
		expect(groups[1]?.item.key).toBe("3:s3");
		expect(albumMessages(groups[1] ?? fail("no row")).map((m) => m.seq)).toEqual([2, 3, 4]);
		expect(groups[0]?.album).toEqual([]);
	});

	it("keeps the first message as the carrier when no photo has text, and does not join across chats or senders", () => {
		const items = [message(3, 1, { groupedId: 5 }), message(3, 2, { groupedId: 5 }), message(7, 3, { groupedId: 5 }), message(3, 4, { groupedId: 5, fromId: 8 })];
		const groups = groupMerged(items);
		expect(groups.map((g) => g.key)).toEqual(["3:s1", "7:s3", "3:s4"]);
		expect(groups[0]?.item.key).toBe("3:s1");
	});

	it("puts the divider above the oldest incoming message that was unread, in any chat", () => {
		const groups = groupMerged([message(3, 1), message(7, 2), message(3, 3), message(7, 4)]);
		const unread = new Map([
			[3, 3],
			[7, 4],
		]);
		expect(unreadDividerKey(groups, unread, SELF)).toBe("3:s3");
	});

	it("has no divider when nothing was unread, or once the reader answered below it", () => {
		const groups = groupMerged([message(3, 1), message(3, 2), message(3, 3, { fromId: SELF }), message(3, 4)]);
		expect(unreadDividerKey(groups, new Map(), SELF)).toBe("");
		expect(unreadDividerKey(groups, new Map([[3, 2]]), SELF)).toBe("");
		expect(unreadDividerKey(groups, new Map([[3, 4]]), SELF)).toBe("3:s4");
	});

	it("finds the row of a quoted message, an album member included, and null when it is not loaded", () => {
		const groups = groupMerged([message(3, 1), message(3, 2, { groupedId: 5 }), message(3, 3, { groupedId: 5 }), message(7, 4)]);
		expect(rowOfMessage(groups, 3, 3)).toBe("3:s2");
		expect(rowOfMessage(groups, 7, 4)).toBe("7:s4");
		expect(rowOfMessage(groups, 7, 1)).toBeNull();
		expect(rowOfMessage(groups, 3, 99)).toBeNull();
	});
});

function fail(reason: string): never {
	throw new Error(reason);
}

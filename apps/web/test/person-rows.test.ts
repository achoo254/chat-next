// Folding a linked person's private chats into one row of "Tất cả", the
// badge correction for them, and the person path the row opens.
import { describe, expect, it } from "vitest";
import type { ListEntry } from "../src/messaging/data/store.ts";
import type { LinkedPerson } from "../src/messaging/people/people-api.ts";
import { personIdFrom, personPath } from "../src/messaging/people/person-path.ts";
import { personBadgeExtra, withPersonRows } from "../src/messaging/people/person-rows.ts";

function entry(chatId: number, extras: Partial<ListEntry> = {}): ListEntry {
	return { chatId, kind: "private", saved: false, forum: false, unread: false, muted: false, pinned: false, app: "", ...extras };
}

const lan: LinkedPerson = {
	id: 7,
	name: "Lan Anh",
	members: [
		{ userId: 1, name: "Lan Anh", app: "", chatId: 10 },
		{ userId: 2, name: "Lan", app: "telegram", chatId: 20 },
		{ userId: 3, name: "Lan Zalo", app: "zalo", chatId: 30 },
	],
};

describe("withPersonRows", () => {
	it("puts one row for the person where its first chat is, the other chats unchanged", () => {
		const items = withPersonRows([entry(5), entry(20, { app: "telegram" }), entry(6), entry(10), entry(30, { app: "zalo" })], [lan]);
		expect(items).toEqual([5, { person: lan, chatIds: [20, 10, 30], apps: ["", "telegram", "zalo"], pinned: false }, 6]);
	});

	it("is pinned when one of the person's chats is pinned", () => {
		const [first] = withPersonRows([entry(10, { pinned: true }), entry(5), entry(20)], [lan]);
		expect(first).toMatchObject({ chatIds: [10, 20], pinned: true });
	});

	it("names only the apps of chats in the list, each once", () => {
		const twice: LinkedPerson = { ...lan, members: [...lan.members, { userId: 4, name: "Lan 2", app: "telegram", chatId: 40 }] };
		const [row] = withPersonRows([entry(40), entry(20)], [twice]);
		expect(row).toMatchObject({ chatIds: [40, 20], apps: ["telegram"] });
	});

	it("never folds a group, and leaves the list as it is without people", () => {
		const entries = [entry(10, { kind: "group" }), entry(5)];
		expect(withPersonRows(entries, [lan])).toEqual([10, 5]);
		expect(withPersonRows([entry(10), entry(20)], [])).toEqual([10, 20]);
	});
});

describe("personBadgeExtra", () => {
	it("counts each person's unread chats beyond the first", () => {
		const entries = [entry(10, { unread: true }), entry(20, { unread: true }), entry(30, { unread: true }), entry(5, { unread: true })];
		expect(personBadgeExtra(entries, [lan], false)).toBe(2);
	});

	it("leaves out muted chats unless muted chats count, and read chats", () => {
		const entries = [entry(10, { unread: true }), entry(20, { unread: true, muted: true }), entry(30)];
		expect(personBadgeExtra(entries, [lan], false)).toBe(0);
		expect(personBadgeExtra(entries, [lan], true)).toBe(1);
	});
});

describe("person path", () => {
	it("round-trips a person id and rejects other paths", () => {
		expect(personPath(12)).toBe("/p/12");
		expect(personIdFrom("/p/12")).toBe(12);
		expect(personIdFrom("/p/12/")).toBe(12);
		for (const path of ["/p/", "/p/0", "/p/abc", "/c/12", "/p/12/x", "/p/99999999999999999999"]) expect(personIdFrom(path)).toBeNull();
	});
});

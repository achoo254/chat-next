// The pieces behind sending from a person's merged screen (ADR 0025): the
// data source that fans a send out to the target chats, the choice of
// targets, and what the screen keeps on this device.
import { describe, expect, it } from "vitest";
import type { AlbumItemInput, MediaInput, PendingMessage } from "@achoo254/chat-core";
import type { ChatSource } from "../src/messaging/data/source.ts";
import { fanOutSource, NothingSent, SendCancelled, type FanOutPlan, type SendReport } from "../src/messaging/people/fan-out-source.ts";
import { PersonSendPrefs } from "../src/messaging/people/send-prefs.ts";
import { SendStatus } from "../src/messaging/people/send-status.ts";
import {
	effectiveTargets,
	hasRow,
	initialSelection,
	newestChat,
	primaryOf,
	toggleTarget,
	type SendTarget,
	type TargetReason,
} from "../src/messaging/people/send-targets.ts";

function pending(chatId: number, randomId: number): PendingMessage {
	return { outboxId: chatId, chatId, randomId, text: "", entities: [], replyToSeq: 0, date: 0, failure: null, seq: 0 } as unknown as PendingMessage;
}

interface Sent {
	kind: string;
	chatId: number;
	randomId: number | undefined;
	file?: Blob;
	items?: readonly AlbumItemInput[];
}

/** A source that records its sends; `fail` decides which chats throw. */
function recorder(fail: (chatId: number) => boolean = () => false): { source: ChatSource; sent: Sent[] } {
	const sent: Sent[] = [];
	const settle = <T>(chatId: number, value: T): Promise<T> => (fail(chatId) ? Promise.reject(new Error(`chat ${chatId} failed`)) : Promise.resolve(value));
	const source = {
		sendText: (chatId: number, _text: string, options?: { randomId?: number }) => {
			sent.push({ kind: "text", chatId, randomId: options?.randomId });
			return settle(chatId, pending(chatId, options?.randomId ?? 1));
		},
		sendMedia: (chatId: number, file: Blob, _media: MediaInput, options?: { randomId?: number }) => {
			sent.push({ kind: "media", chatId, randomId: options?.randomId, file });
			return settle(chatId, pending(chatId, options?.randomId ?? 1));
		},
		sendAlbum: (chatId: number, items: readonly AlbumItemInput[]) => {
			sent.push({ kind: "album", chatId, randomId: undefined, items });
			return settle(chatId, items.map((item, index) => pending(chatId, item.randomId ?? index + 1)));
		},
		editText: () => Promise.resolve(),
	} as unknown as ChatSource;
	return { source, sent };
}

function fanned(plan: FanOutPlan, options: { fail?: (chatId: number) => boolean; confirm?: boolean } = {}) {
	const { source, sent } = recorder(options.fail);
	const reports: SendReport[] = [];
	const asked: (readonly number[])[] = [];
	const wrapped = fanOutSource(source, {
		plan: () => plan,
		confirm: (chatIds) => {
			asked.push(chatIds);
			return Promise.resolve(options.confirm ?? true);
		},
		report: (report) => reports.push(report),
	});
	return { wrapped, sent, reports, asked };
}

const NONE = new Map<number, TargetReason>();

describe("the fan-out source", () => {
	it("sends a text to every target, the composer's chat with its random_id and the others with their own", async () => {
		const { wrapped, sent, reports, asked } = fanned({ targets: [1, 2, 3], blocked: NONE });
		const result = await wrapped.sendText(2, "Chào", { randomId: 77 });
		expect(sent).toEqual([
			{ kind: "text", chatId: 1, randomId: undefined },
			{ kind: "text", chatId: 2, randomId: 77 },
			{ kind: "text", chatId: 3, randomId: undefined },
		]);
		expect(result?.chatId).toBe(2);
		expect(asked).toEqual([[1, 2, 3]]);
		expect(reports.map((report) => [report.kind, report.chatId])).toEqual([
			["sent", 1],
			["sent", 2],
			["sent", 3],
		]);
	});

	it("passes a send through to its own chat alone, without asking, when it is the only target", async () => {
		const { wrapped, sent, asked } = fanned({ targets: [2], blocked: NONE });
		await wrapped.sendText(2, "Trả lời", { replyToSeq: 9 });
		expect(sent).toEqual([{ kind: "text", chatId: 2, randomId: undefined }]);
		expect(asked).toEqual([]);
	});

	it("sends the same file to each chat, and an album's files with no random_id outside the composer's chat", async () => {
		const { wrapped, sent } = fanned({ targets: [1, 2], blocked: NONE });
		const file = new Blob(["x"]);
		await wrapped.sendMedia(1, file, { kind: "document", fileName: "a.txt", mimeType: "text/plain" } as MediaInput, { randomId: 5 });
		expect(sent.map((s) => [s.chatId, s.file === file, s.randomId])).toEqual([
			[1, true, 5],
			[2, true, undefined],
		]);
		const items: AlbumItemInput[] = [
			{ file, media: { kind: "photo" } as MediaInput, randomId: 10, text: "Chú thích" },
			{ file, media: { kind: "photo" } as MediaInput, randomId: 11 },
		];
		const result = await wrapped.sendAlbum(1, items);
		const albums = sent.filter((s) => s.kind === "album");
		expect(albums[0]?.items).toBe(items);
		expect(albums[1]?.items?.map((item) => [item.file === file, item.randomId, item.text])).toEqual([
			[true, undefined, "Chú thích"],
			[true, undefined, undefined],
		]);
		expect(result.map((p) => p.randomId)).toEqual([10, 11]);
	});

	it("skips a chat that takes nothing, telling why, and sends to the others", async () => {
		const { wrapped, sent, reports } = fanned({ targets: [1, 2], blocked: new Map([[2, "readOnly"]]) });
		await wrapped.sendText(1, "Chào");
		expect(sent.map((s) => s.chatId)).toEqual([1]);
		expect(reports).toContainEqual({ kind: "skipped", chatId: 2, reason: "readOnly" });
	});

	it("fails only when nothing could be queued, so the composer keeps the text", async () => {
		const skipped = fanned({ targets: [1, 2], blocked: new Map<number, TargetReason>([[1, "readOnly"], [2, "closed"]]) });
		await expect(skipped.wrapped.sendText(1, "Chào")).rejects.toBeInstanceOf(NothingSent);
		const failing = fanned({ targets: [1, 2], blocked: NONE }, { fail: () => true });
		await expect(failing.wrapped.sendText(1, "Chào")).rejects.toThrow("chat 1 failed");
	});

	it("reports a failed chat with a retry while the other chat sent", async () => {
		let broken = true;
		const { wrapped, sent, reports } = fanned({ targets: [1, 2], blocked: NONE }, { fail: (chatId) => broken && chatId === 2 });
		const result = await wrapped.sendText(1, "Chào");
		expect(result?.chatId).toBe(1);
		const failed = reports.find((report) => report.kind === "failed");
		if (failed?.kind !== "failed") throw new Error("no failure reported");
		expect(failed.chatId).toBe(2);
		broken = false;
		await failed.retry();
		expect(sent.filter((s) => s.chatId === 2)).toHaveLength(2);
		expect(reports.at(-1)).toEqual({ kind: "sent", chatId: 2 });
	});

	it("sends nothing when the question is answered no", async () => {
		const { wrapped, sent } = fanned({ targets: [1, 2], blocked: NONE }, { confirm: false });
		await expect(wrapped.sendText(1, "Chào")).rejects.toBeInstanceOf(SendCancelled);
		expect(sent).toEqual([]);
	});

	it("leaves editing to the composer's chat", async () => {
		const { source } = recorder();
		const wrapped = fanOutSource(source, { plan: () => ({ targets: [1, 2], blocked: NONE }), confirm: () => Promise.resolve(true), report: () => undefined });
		expect(wrapped.editText).toBe(source.editText);
	});
});

const targets: SendTarget[] = [
	{ chatId: 1, app: "", reason: null },
	{ chatId: 2, app: "telegram", reason: null },
	{ chatId: 3, app: "zalo", reason: "readOnly" },
];

describe("choosing the targets", () => {
	it("first selects the chat of the newest message among those that can send", () => {
		const dates = new Map([
			[1, 100],
			[2, 200],
			[3, 300],
		]);
		expect(newestChat(targets, dates)).toBe(2);
		expect(newestChat(targets.slice(2), dates)).toBe(3);
		expect(newestChat(targets, new Map())).toBe(0);
		expect(initialSelection(targets, null, 2)).toEqual([2]);
		// Nothing dated yet: the first chat that can send.
		expect(initialSelection(targets, null, 0)).toEqual([1]);
	});

	it("keeps a remembered choice that is still among the chats", () => {
		expect(initialSelection(targets, [3, 1, 99], 2)).toEqual([1, 3]);
		expect(initialSelection(targets, [99], 2)).toEqual([2]);
	});

	it("toggles in row order and never leaves nothing selected", () => {
		expect(toggleTarget(targets, [2], 2)).toEqual([2]);
		expect(toggleTarget(targets, [2], 1)).toEqual([1, 2]);
		expect(toggleTarget(targets, [1, 2], 1)).toEqual([2]);
	});

	it("binds the composer to the first selected chat that takes messages", () => {
		expect(primaryOf(targets, [3, 2])).toBe(2);
		expect(primaryOf(targets, [3])).toBe(3);
		expect(primaryOf(targets, [])).toBe(0);
	});

	it("has a row from two chats that can send; with one, sends there only", () => {
		expect(hasRow(targets)).toBe(true);
		expect(effectiveTargets(targets, [1, 3])).toEqual([1, 3]);
		const one: SendTarget[] = [targets[0] ?? { chatId: 1, app: "", reason: null }, { chatId: 3, app: "zalo", reason: "readOnly" }];
		expect(hasRow(one)).toBe(false);
		expect(effectiveTargets(one, [3])).toEqual([1]);
	});
});

class MemoryStorage implements Storage {
	private readonly items = new Map<string, string>();
	get length(): number {
		return this.items.size;
	}
	clear(): void {
		this.items.clear();
	}
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.items.delete(key);
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

describe("what the screen keeps", () => {
	it("remembers the targets per person and per user, ignoring what it cannot read", () => {
		const storage = new MemoryStorage();
		const prefs = new PersonSendPrefs(7, storage);
		expect(prefs.targets(1)).toBeNull();
		prefs.setTargets(1, [10, 11]);
		prefs.setTargets(2, [20]);
		expect(prefs.targets(1)).toEqual([10, 11]);
		expect(prefs.targets(2)).toEqual([20]);
		expect(new PersonSendPrefs(8, storage).targets(1)).toBeNull();
		storage.setItem("chat:person-targets:7:3", "not json");
		expect(prefs.targets(3)).toBeNull();
		storage.setItem("chat:person-targets:7:4", JSON.stringify(["x", -1, 5]));
		expect(prefs.targets(4)).toEqual([5]);
	});

	it("remembers that the question is not to be asked again, for this user", () => {
		const storage = new MemoryStorage();
		const prefs = new PersonSendPrefs(7, storage);
		expect(prefs.confirmed()).toBe(false);
		prefs.setConfirmed();
		expect(prefs.confirmed()).toBe(true);
		expect(new PersonSendPrefs(8, storage).confirmed()).toBe(false);
	});

	it("keeps the choice for the page when storage is off", () => {
		const prefs = new PersonSendPrefs(7, null);
		prefs.setTargets(1, [10]);
		expect(prefs.targets(1)).toEqual([10]);
	});
});

describe("the send lines", () => {
	it("keeps one line per chat, clears it on a send that went, and tells a waiting one", () => {
		const status = new SendStatus();
		status.note({ kind: "skipped", chatId: 3, reason: "readOnly" }, undefined);
		status.note({ kind: "failed", chatId: 2, retry: () => Promise.resolve() }, undefined);
		expect(status.current().map((line) => [line.kind, line.chatId])).toEqual([
			["skipped", 3],
			["failed", 2],
		]);
		status.note({ kind: "sent", chatId: 2 }, undefined);
		expect(status.current().map((line) => line.chatId)).toEqual([3]);
		status.note({ kind: "sent", chatId: 4 }, "needsLogin");
		expect(status.current().at(-1)).toEqual({ kind: "waiting", chatId: 4, reason: "needsLogin" });
		status.dismiss(3);
		expect(status.current().map((line) => line.chatId)).toEqual([4]);
	});
});

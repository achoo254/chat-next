// The merged timeline of a person: the private chats with each identity in
// one chronological list, each chat buffered on its own from the newest
// message, shown between the newest message and the oldest point every chat
// with more history has loaded back to.
import { describe, expect, it, vi } from "vitest";
import { EventKeys } from "@achoo254/chat-core";
import { MergedTimeline } from "../src/messaging/people/merged-timeline.ts";
import { FakeHistorySource, pendingMessage, settle } from "./support/fake-history-source.ts";

const TELEGRAM = 3;
const CHAT = 7;

async function openTimeline(source: FakeHistorySource, chatIds: readonly number[] = [TELEGRAM, CHAT]): Promise<MergedTimeline> {
	const members = chatIds.map((chatId, i) => ({ userId: i + 1, name: "Lan Anh", app: chatId === TELEGRAM ? "telegram" : "", chatId }));
	const timeline = new MergedTimeline({ source, members: [...members, { userId: 99, name: "Lan Anh", app: "zalo", chatId: 0 }] });
	timeline.open();
	await settle();
	return timeline;
}

function shownKeys(timeline: MergedTimeline): string[] {
	return timeline.snapshot().items.map((item) => item.key);
}

/** Every message of the source in merged order: date, then chat, then seq. */
function fullOrder(source: FakeHistorySource): string[] {
	return [...source.messages.values()]
		.flat()
		.sort((a, b) => a.date - b.date || a.chatId - b.chatId || a.seq - b.seq)
		.map((m) => `${m.chatId}:s${m.seq}`);
}

/** Scrolls back page by page; after each page what shows must be exactly the newest part of the full order. */
async function scrollToStart(timeline: MergedTimeline, source: FakeHistorySource): Promise<void> {
	const full = fullOrder(source);
	for (let i = 0; i < 100 && timeline.snapshot().hasOlder; i++) {
		await timeline.loadOlder();
		await settle();
		const shown = shownKeys(timeline);
		expect(shown).toEqual(full.slice(full.length - shown.length));
	}
	expect(timeline.snapshot().hasOlder).toBe(false);
}

describe("merged timeline", () => {
	it("merges a busy chat and a quiet one in date order, hiding what is older than the loaded bound", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 200, (seq) => 1000 + seq * 10);
		source.fill(CHAT, 1, 5, (seq) => 1000 + seq * 400);
		const timeline = await openTimeline(source);
		const snapshot = timeline.snapshot();
		expect(snapshot.status).toBe("ready");
		const full = fullOrder(source);
		const shown = shownKeys(timeline);
		// The 30 newest Telegram messages reach back to date 2710: only Chat's newest message (3000) is newer.
		expect(shown).toEqual(full.slice(full.length - shown.length));
		expect(shown.filter((key) => key.startsWith(`${CHAT}:`))).toEqual([`${CHAT}:s5`]);
		expect(snapshot.items.find((item) => item.chatId === TELEGRAM)?.app).toBe("telegram");
		expect(snapshot.hasOlder).toBe(true);
		await scrollToStart(timeline, source);
		expect(shownKeys(timeline)).toEqual(full);
	});

	it("scrolls back far beyond the store's 120-message window without losing or misplacing a message", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 300, (seq) => 5000 + seq * 7);
		source.fill(CHAT, 1, 260, (seq) => 5000 + seq * 9);
		const timeline = await openTimeline(source);
		await scrollToStart(timeline, source);
		expect(shownKeys(timeline)).toHaveLength(560);
		expect(new Set(shownKeys(timeline)).size).toBe(560);
	});

	it("loads further back only the chat holding the bound; an exhausted chat never holds it", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 3, (seq) => 100 + seq);
		source.fill(CHAT, 1, 100, (seq) => 1000 + seq);
		const timeline = await openTimeline(source);
		// Telegram's whole history is older than Chat's newest page: hidden until Chat is loaded back that far.
		expect(shownKeys(timeline).some((key) => key.startsWith(`${TELEGRAM}:`))).toBe(false);
		expect(timeline.shownMaxSeq(TELEGRAM)).toBe(0);
		await timeline.loadOlder();
		expect(source.olderLoads(CHAT)).toBe(1);
		expect(source.olderLoads(TELEGRAM)).toBe(0);
		await scrollToStart(timeline, source);
		expect(source.olderLoads(TELEGRAM)).toBe(0);
		expect(shownKeys(timeline)).toEqual(fullOrder(source));
	});

	it("loads every chat tied at the bound date, and joins a second call while a load runs", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 60, (seq) => 1000 + seq);
		source.fill(CHAT, 1, 60, (seq) => 1000 + seq);
		const timeline = await openTimeline(source);
		const first = timeline.loadOlder();
		expect(timeline.snapshot().loadingOlder).toBe(true);
		expect(timeline.loadOlder()).toBe(first);
		await first;
		expect(timeline.snapshot().loadingOlder).toBe(false);
		expect(source.olderLoads(TELEGRAM)).toBe(1);
		expect(source.olderLoads(CHAT)).toBe(1);
	});

	it("orders messages with equal dates by chat, then seq", async () => {
		const source = new FakeHistorySource();
		source.fill(CHAT, 1, 3, () => 500);
		source.fill(TELEGRAM, 1, 3, () => 500);
		const timeline = await openTimeline(source, [CHAT, TELEGRAM]);
		expect(shownKeys(timeline)).toEqual(["3:s1", "3:s2", "3:s3", "7:s1", "7:s2", "7:s3"]);
	});

	it("shows a message arriving after a deep scroll at the end, keeping the older ones", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 150, (seq) => 1000 + seq * 2);
		source.fill(CHAT, 1, 150, (seq) => 1001 + seq * 2);
		const timeline = await openTimeline(source);
		for (let i = 0; i < 4; i++) await timeline.loadOlder();
		await settle();
		const before = shownKeys(timeline);
		source.fill(CHAT, 151, 151, () => 9000);
		source.emitHistory(CHAT, 151);
		await settle();
		expect(shownKeys(timeline)).toEqual([...before, `${CHAT}:s151`]);
		expect(timeline.shownMaxSeq(CHAT)).toBe(151);
	});

	it("updates an edited message and removes a deleted one, also deep in the buffer", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 80, (seq) => 1000 + seq);
		const timeline = await openTimeline(source, [TELEGRAM]);
		await scrollToStart(timeline, source);
		const untouched = timeline.snapshot().items.find((item) => item.key === `${TELEGRAM}:s2`);
		source.edit(TELEGRAM, 5, "sửa lại");
		source.emit(EventKeys.message(TELEGRAM, 5));
		await settle();
		const edited = timeline.snapshot().items.find((item) => item.key === `${TELEGRAM}:s5`);
		expect(edited?.kind === "message" ? edited.message.text : "").toBe("sửa lại");
		// Rows that did not change keep their identity.
		expect(timeline.snapshot().items.find((item) => item.key === `${TELEGRAM}:s2`)).toBe(untouched);
		source.remove(TELEGRAM, 6);
		source.remove(TELEGRAM, 79);
		source.emitHistory(TELEGRAM, 6, 79);
		await settle();
		const keys = shownKeys(timeline);
		expect(keys).not.toContain(`${TELEGRAM}:s6`);
		expect(keys).not.toContain(`${TELEGRAM}:s79`);
		expect(keys).toHaveLength(78);
	});

	it("keeps the same snapshot when an event changes nothing", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 10, (seq) => 1000 + seq);
		const timeline = await openTimeline(source, [TELEGRAM]);
		const listener = vi.fn();
		timeline.subscribe(listener);
		const snapshot = timeline.snapshot();
		source.emitHistory(TELEGRAM, 4);
		await settle();
		expect(timeline.snapshot()).toBe(snapshot);
		expect(listener).not.toHaveBeenCalled();
	});

	it("shows each chat's unconfirmed sends after the newest message", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 5, (seq) => 1000 + seq);
		source.fill(CHAT, 1, 5, (seq) => 2000 + seq);
		source.pending.set(TELEGRAM, [pendingMessage(TELEGRAM, 1, 1500)]);
		const timeline = await openTimeline(source);
		source.pending.set(CHAT, [pendingMessage(CHAT, 2, 2100)]);
		source.emit(EventKeys.outbox);
		await settle();
		const items = timeline.snapshot().items;
		expect(items.slice(-2).map((item) => [item.kind, item.chatId])).toEqual([
			["pending", TELEGRAM],
			["pending", CHAT],
		]);
		expect(items.slice(0, -2).every((item) => item.kind === "message")).toBe(true);
	});

	it("keeps showing the other chats when one fails, and recovers on refresh", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 50, (seq) => 1000 + seq);
		source.fill(CHAT, 1, 50, (seq) => 1000 + seq);
		source.failing.add(TELEGRAM);
		const timeline = await openTimeline(source);
		expect(timeline.snapshot().status).toBe("ready");
		expect(timeline.snapshot().failures.get(TELEGRAM)).toBe("retryable");
		expect(timeline.snapshot().failures.has(CHAT)).toBe(false);
		expect(shownKeys(timeline)).toHaveLength(30);
		source.failing.delete(TELEGRAM);
		await timeline.refresh();
		expect(timeline.snapshot().failures.size).toBe(0);
		expect(shownKeys(timeline).some((key) => key.startsWith(`${TELEGRAM}:`))).toBe(true);
	});

	it("reads the newest pages again after a reconnect, closing the gap of missed messages", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 40, (seq) => 1000 + seq);
		const timeline = await openTimeline(source, [TELEGRAM]);
		source.connection = "offline";
		source.emit(EventKeys.connection);
		await settle();
		// 75 messages arrive while offline: more than two newest pages.
		source.fill(TELEGRAM, 41, 115, (seq) => 1000 + seq);
		source.connection = "connected";
		source.emit(EventKeys.connection);
		await settle();
		const seqs = timeline.snapshot().items.map((item) => (item.kind === "message" ? item.message.seq : 0));
		expect(seqs).toEqual(Array.from({ length: 105 }, (_, i) => 11 + i));
		expect(timeline.shownMaxSeq(TELEGRAM)).toBe(115);
	});

	it("never reports a shown seq above the newest message shown", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 40, (seq) => 1000 + seq);
		const timeline = await openTimeline(source, [TELEGRAM]);
		expect(timeline.shownMaxSeq(TELEGRAM)).toBe(40);
		expect(timeline.shownMaxSeq(CHAT)).toBe(0);
		source.fill(TELEGRAM, 41, 41, () => 2000);
		// Not delivered yet: the new message is not shown, so it is not read.
		expect(timeline.shownMaxSeq(TELEGRAM)).toBe(40);
	});

	it("stops reacting after dispose and ignores answers that arrive late", async () => {
		const source = new FakeHistorySource();
		source.fill(TELEGRAM, 1, 10, (seq) => 1000 + seq);
		let release: () => void = () => undefined;
		source.gate = new Promise((resolve) => (release = resolve));
		const timeline = await openTimeline(source, [TELEGRAM]);
		const listener = vi.fn();
		timeline.subscribe(listener);
		const snapshot = timeline.snapshot();
		timeline.dispose();
		release();
		await settle();
		const calls = source.calls.length;
		source.emitHistory(TELEGRAM, 3);
		source.emit(EventKeys.connection);
		await settle();
		expect(source.calls).toHaveLength(calls);
		expect(timeline.snapshot()).toBe(snapshot);
		expect(snapshot.items).toEqual([]);
		expect(listener).not.toHaveBeenCalled();
		await expect(timeline.loadOlder()).resolves.toBeUndefined();
	});
});

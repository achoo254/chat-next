import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import type { Message } from "../src/model/types.ts";
import type { StoredMessage } from "../src/repo/repository.ts";
import { mergeSearchHits, sortNewestFirst } from "../src/search/merge.ts";
import { SearchSession, type SearchRequest, type SearchState, type ServerSearchResult } from "../src/search/session.ts";
import type { ServerSearchRequest } from "../src/search/server.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

function message(chatId: number, seq: number, text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
	const base: Message = {
		chatId,
		seq,
		fromId: 1,
		date: 1_000 + seq,
		text,
		entities: [],
		mediaKind: null,
		replyToSeq: 0,
		forward: null,
		editDate: 0,
		editVersion: 0,
		randomId: 0,
		groupedId: 0,
		viaBotId: 0,
		reactions: [],
		integrationLabel: "",
		buttons: [],
		action: null,
		topicId: 0,
		linkPreview: null,
		recalled: false,
		silent: false,
	};
	return { ...base, stale: false, ...extra };
}

const keys = (hits: readonly { message: StoredMessage; source: string }[]) => hits.map((h) => `${h.message.chatId}:${h.message.seq}:${h.source}`);

describe("mergeSearchHits", () => {
	it("keeps local rows in place, verifies them and appends what only the server found", () => {
		const local = [message(1, 9, "a"), message(2, 5, "b"), message(1, 3, "c")];
		const server = [message(3, 7, "x"), message(1, 9, "a", { editVersion: 2 }), message(1, 1, "y")];
		const hits = mergeSearchHits(local, { messages: server, complete: false });
		expect(keys(hits)).toEqual(["1:9:both", "2:5:local", "1:3:local", "3:7:server", "1:1:server"]);
		// The server's copy replaces the cached one.
		expect(hits[0]?.message.editVersion).toBe(2);
	});

	it("drops a stale local hit only once the server has answered in full", () => {
		const local = [message(1, 9, "kept", { stale: true }), message(1, 8, "gone", { stale: true }), message(1, 7, "fresh")];
		const server = [message(1, 9, "kept")];
		expect(keys(mergeSearchHits(local, { messages: server, complete: false }))).toEqual(["1:9:both", "1:8:local", "1:7:local"]);
		const complete = mergeSearchHits(local, { messages: server, complete: true });
		expect(keys(complete)).toEqual(["1:9:both", "1:7:local"]);
		// Verified: the stale flag is gone.
		expect(complete[0]?.message.stale).toBe(false);
	});

	it("never repeats a hit and shows local hits alone before the server answers", () => {
		const local = [message(1, 2, "a"), message(1, 2, "a")];
		expect(keys(mergeSearchHits(local, null))).toEqual(["1:2:local"]);
		expect(keys(mergeSearchHits([], { messages: [message(1, 2, "a"), message(1, 2, "a")], complete: true }))).toEqual(["1:2:server"]);
	});

	it("orders hits of a chat newest first for stepping through them", () => {
		const hits = mergeSearchHits([message(1, 3, "a")], { messages: [message(1, 9, "b"), message(1, 1, "c")], complete: true });
		expect(sortNewestFirst(hits).map((h) => h.message.seq)).toEqual([9, 3, 1]);
	});
});

describe("SearchSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const request = (text: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({ text, chatId: 0, topicId: 0, filters: {}, ...extra });

	function setup(server: (request: ServerSearchRequest) => Promise<ServerSearchResult>, online = true) {
		const states: SearchState[] = [];
		const local = vi.fn(async (text: string) => (text.includes("lich") ? [message(1, 5, "Lịch trực")] : []));
		const serverSpy = vi.fn(server);
		const session = new SearchSession({
			local,
			server: serverSpy,
			online,
			timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
			debounceMs: 300,
			onChange: (state) => states.push(state),
		});
		return { session, states, local, server: serverSpy };
	}

	const page = (messages: StoredMessage[], nextCursor = ""): ServerSearchResult => ({
		ok: true,
		page: { messages, chats: [], users: [], nextCursor },
	});

	it("shows local hits at once and merges the server's after a pause in typing", async () => {
		const { session, server } = setup(async () => page([message(1, 5, "Lịch trực"), message(2, 1, "Lịch họp")]));
		session.set(request("lich"));
		await vi.advanceTimersByTimeAsync(0);
		expect(session.current()).toMatchObject({ localReady: true, server: "waiting" });
		expect(keys(session.current().hits)).toEqual(["1:5:local"]);
		expect(server).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(300);
		expect(server).toHaveBeenCalledTimes(1);
		expect(session.current().server).toBe("done");
		expect(keys(session.current().hits)).toEqual(["1:5:both", "2:1:server"]);
	});

	it("asks the server once per pause and drops answers to an older query", async () => {
		let resolveFirst: (result: ServerSearchResult) => void = () => undefined;
		const answers: Promise<ServerSearchResult>[] = [
			new Promise((resolve) => {
				resolveFirst = resolve;
			}),
			Promise.resolve(page([message(9, 9, "lich moi")])),
		];
		const { session, server } = setup(() => answers.shift() ?? Promise.resolve(page([])));
		session.set(request("l"));
		await vi.advanceTimersByTimeAsync(100);
		session.set(request("li"));
		await vi.advanceTimersByTimeAsync(100);
		session.set(request("lich"));
		await vi.advanceTimersByTimeAsync(300);
		expect(server).toHaveBeenCalledTimes(1);
		session.set(request("lich m"));
		await vi.advanceTimersByTimeAsync(300);
		expect(server).toHaveBeenCalledTimes(2);
		// The first call ("lich") answers late: ignored.
		resolveFirst(page([message(7, 7, "old")]));
		await vi.advanceTimersByTimeAsync(0);
		expect(session.current().request?.text).toBe("lich m");
		expect(keys(session.current().hits)).toEqual(["1:5:local", "9:9:server"]);
		// Setting the same request again does nothing.
		session.set(request("lich m "));
		await vi.advanceTimersByTimeAsync(500);
		expect(server).toHaveBeenCalledTimes(2);
	});

	it("pages through the server's results", async () => {
		const { session, server } = setup(async (req) =>
			req.cursor === "" ? page([message(1, 5, "Lịch trực")], "next") : page([message(1, 2, "lịch cũ")]),
		);
		session.set(request("lich"));
		await vi.advanceTimersByTimeAsync(300);
		expect(session.current().hasMore).toBe(true);
		session.more();
		await vi.advanceTimersByTimeAsync(0);
		expect(server).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
		expect(session.current()).toMatchObject({ hasMore: false, loadingMore: false });
		expect(keys(session.current().hits)).toEqual(["1:5:both", "1:2:server"]);
	});

	it("keeps local hits offline and when the server fails, and retries on demand", async () => {
		let fail = true;
		const { session, server } = setup(async () => (fail ? { ok: false, failure: "retryable" } : page([message(3, 3, "lịch server")])), false);
		session.set(request("lich"));
		await vi.advanceTimersByTimeAsync(300);
		expect(server).not.toHaveBeenCalled();
		expect(session.current().server).toBe("offline");
		expect(keys(session.current().hits)).toEqual(["1:5:local"]);

		// Back online: asked at once.
		session.setOnline(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(server).toHaveBeenCalledTimes(1);
		expect(session.current().server).toBe("failed");
		expect(keys(session.current().hits)).toEqual(["1:5:local"]);

		fail = false;
		session.retry();
		await vi.advanceTimersByTimeAsync(0);
		expect(session.current().server).toBe("done");
		expect(keys(session.current().hits)).toEqual(["1:5:local", "3:3:server"]);
	});

	it("searches nothing without words or filters, and filters alone are enough", async () => {
		const { session, local, server } = setup(async () => page([]));
		session.set(request("  !? "));
		await vi.advanceTimersByTimeAsync(500);
		expect(session.current()).toMatchObject({ server: "idle", hits: [] });
		expect(local).not.toHaveBeenCalled();
		expect(server).not.toHaveBeenCalled();

		session.set(request("", { filters: { mediaKind: "photo" } }));
		await vi.advanceTimersByTimeAsync(300);
		expect(local).toHaveBeenCalledWith("", expect.objectContaining({ filters: { mediaKind: "photo" } }));
		expect(server).toHaveBeenCalledWith(expect.objectContaining({ filters: { mediaKind: "photo" } }));
	});

	it("orders in-chat hits newest first", async () => {
		const { session } = setup(async () => page([message(1, 9, "lịch mới"), message(1, 1, "lịch đầu")]));
		session.set(request("lich", { chatId: 1 }));
		await vi.advanceTimersByTimeAsync(300);
		expect(session.current().hits.map((h) => h.message.seq)).toEqual([9, 5, 1]);
	});
});

describe("search in the core", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("finds cached messages without accents and filters them by sender and date", async () => {
		const server = new FakeServer();
		const an = server.addUser("An");
		const binh = server.addUser("Bình");
		const chat = server.createChat(ChatType.GROUP, "Vận hành", [an, binh]);
		server.sendMessage(an, chat, "Lịch trực tuần này");
		server.sendMessage(binh, chat, "Lịch trực tuần sau");
		server.sendMessage(binh, chat, "Ăn trưa không?");
		const { core } = await startTestApp(server, an, new MemorySqlFactory());
		await settle(core);
		await core.history(chat);

		expect((await core.search("lich truc")).map((m) => m.text)).toEqual(["Lịch trực tuần sau", "Lịch trực tuần này"]);
		expect((await core.search("lich truc", { filters: { fromId: binh } })).map((m) => m.text)).toEqual(["Lịch trực tuần sau"]);
		// Filters alone list the matching messages.
		expect((await core.search("", { chatId: chat, filters: { fromId: binh } })).map((m) => m.text)).toEqual([
			"Ăn trưa không?",
			"Lịch trực tuần sau",
		]);
		const now = Math.floor(Date.now() / 1000);
		expect(await core.search("lich", { filters: { until: now - 3600 } })).toEqual([]);
		expect(await core.search("lich", { filters: { since: now - 3600, until: now + 60 } })).toHaveLength(2);
		expect(await core.search("an trua", { filters: { hasLink: true } })).toEqual([]);
	});

	it("asks the server, returns its hits without caching them as history and stores their senders", async () => {
		const server = new FakeServer();
		const an = server.addUser("An");
		const binh = server.addUser("Bình");
		const chi = server.addUser("Chi");
		const chat = server.createChat(ChatType.PRIVATE, "", [an, binh]);
		server.sendMessage(binh, chat, "Lịch trực tuần này");
		const foreign = server.createChat(ChatType.GROUP, "Không có An", [binh, chi]);
		server.sendMessage(chi, foreign, "Lịch trực của nhóm khác");
		const { core } = await startTestApp(server, an, new MemorySqlFactory());
		await settle(core);

		const result = await core.searchServer({ query: "lich truc" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.page.messages.map((m) => [m.chatId, m.text, m.stale])).toEqual([[chat, "Lịch trực tuần này", false]]);
		expect(result.page.chats.map((c) => c.id)).toEqual([chat]);
		expect((await core.users([binh]))[0]?.name).toBe("Bình");

		const inChat = await core.searchServer({ query: "tuan", chatId: chat });
		expect(inChat.ok && inChat.page.messages.length).toBe(1);
		// Not a member: refused, reported as a failure rather than thrown.
		const refused = await core.searchServer({ query: "lich", chatId: foreign });
		expect(refused).toEqual({ ok: false, failure: "permanent" });
	});
});

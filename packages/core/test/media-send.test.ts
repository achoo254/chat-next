// Media sends through the core: optimistic pending messages with the local
// thumbnail, upload then SendMedia/SendAlbum in chat order, the sender's
// file adopted by the media cache, purge on recall and wipe on sign-out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { startApp, type ChatCore } from "../src/app/start-app.ts";
import { FakeMedia, MemoryBlobs } from "./support/fake-media.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, testPlatform, TENANT } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

interface Setup {
	readonly server: FakeServer;
	readonly media: FakeMedia;
	readonly blobs: MemoryBlobs;
	readonly core: ChatCore;
	readonly self: number;
	readonly peer: number;
	readonly chat: number;
}

async function setup(withMedia = true): Promise<Setup> {
	const server = new FakeServer();
	const media = new FakeMedia();
	if (withMedia) server.media = media;
	const self = server.addUser("Tôi");
	const peer = server.addUser("An");
	const chat = server.createChat(ChatType.GROUP, "Nhóm", [self, peer]);
	const blobs = new MemoryBlobs();
	const platform = { ...testPlatform(server, self, new MemorySqlFactory()), ...(withMedia ? { http: media.http, blobs } : {}) };
	const result = await startApp(platform, {
		api: server.apiFor(self),
		realtimeUrl: "wss://chat.example.test/ws",
		appVersion: "test",
		client: "web",
		tenant: TENANT,
	});
	if (result.status !== "active") throw new Error("not started");
	await settle(result.core);
	return { server, media, blobs, core: result.core, self, peer, chat };
}

const file = (n: number, type = "image/jpeg"): Blob => new Blob([new Uint8Array(n).map((_, i) => i & 0xff)], { type });

describe("media sends", () => {
	it("shows a pending media message at once, then the server's message with the file", async () => {
		const { core, chat, media, server, self } = await setup();
		const thumb = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		const pending = await core.sendMedia(chat, file(10), { kind: "photo", fileName: "a.jpg", width: 4, height: 3, inlineThumb: thumb }, {
			text: "ảnh",
		});
		expect(pending?.media).toMatchObject({ kind: "photo", fileName: "a.jpg", size: 10, width: 4, height: 3 });
		expect([...(pending?.media?.inlineThumb ?? [])]).toEqual([...thumb]);
		expect((await core.history(chat)).pending).toHaveLength(1);
		expect(await core.pendingFile(pending?.media?.uploadKey ?? "")).not.toBeNull();

		await settle(core);
		const view = await core.history(chat);
		expect(view.pending).toEqual([]);
		const sent = view.messages.at(-1);
		expect(sent).toMatchObject({ text: "ảnh", mediaKind: "photo", randomId: pending?.randomId });
		expect(sent?.media?.fileId).toMatch(/^f/);
		expect(server.expectedMessages(chat, self).at(-1)?.media?.fileId).toBe(sent?.media?.fileId);
		expect(await core.uploadProgress(pending?.media?.uploadKey ?? "")).toBeNull();
		// The sender's own file is cached: no download.
		const cached = await core.mediaFile({ chatId: chat, seq: sent?.seq ?? 0, fileId: sent?.media?.fileId ?? "" });
		expect(cached.status).toBe("ok");
		expect(media.gets).toEqual([]);
		expect(await core.mediaCacheUsage()).toMatchObject({ files: 1, bytes: 10 });
	});

	it("sends an album as one group, in order", async () => {
		const { core, chat } = await setup();
		const pending = await core.sendAlbum(chat, [
			{ file: file(5), media: { kind: "photo" }, text: "một" },
			{ file: file(7, "video/mp4"), media: { kind: "video", duration: 1500 } },
		]);
		expect(pending.map((p) => p.media?.kind)).toEqual(["photo", "video"]);
		expect(new Set(pending.map((p) => p.albumId)).size).toBe(1);
		await settle(core);
		const messages = (await core.history(chat)).messages.slice(-2);
		expect(messages.map((m) => m.mediaKind)).toEqual(["photo", "video"]);
		expect(messages[0]?.groupedId).not.toBe(0);
		expect(messages[0]?.groupedId).toBe(messages[1]?.groupedId);
		expect(messages.map((m) => m.randomId)).toEqual(pending.map((p) => p.randomId));
	});

	it("marks the send failed when the file is refused, and keeps later sends going", async () => {
		const { core, chat, media } = await setup();
		media.refuse.add(2 /* VIDEO */);
		await core.sendMedia(chat, file(6, "video/mp4"), { kind: "video" });
		await core.sendText(chat, "sau");
		await settle(core);
		const view = await core.history(chat);
		expect(view.pending).toHaveLength(1);
		expect(view.pending[0]?.failure).toMatch(/content/);
		expect(view.messages.at(-1)?.text).toBe("sau");
		// Discarding drops the upload and its file.
		await core.discardOutbox(view.pending[0]?.outboxId ?? 0);
		expect(await core.pendingFile(view.pending[0]?.media?.uploadKey ?? "")).toBeNull();
	});

	it("evicts a received file when its message is recalled, and wipes media on sign-out", async () => {
		const { core, chat, server, peer, blobs, self } = await setup();
		const api = server.media?.apiFor(peer);
		if (api === undefined) throw new Error("no media");
		const session = await api.createUpload({ kind: 1, size: 3n, fileHash: "x", mimeType: "image/png" });
		if (session.result.case !== "upload") throw new Error("no session");
		const putting = server.media?.http.put(session.result.value.parts[0]?.url ?? "", new Blob([new Uint8Array([7, 8, 9])]));
		await vi.advanceTimersByTimeAsync(10);
		const put = await putting;
		const done = await api.completeUpload({ uploadId: session.result.value.uploadId, parts: [{ partNumber: 1, etag: put?.etag ?? "" }] });
		const fileId = done.media?.fileId ?? "";
		const { seq } = server.sendMessage(peer, chat, "", 0, { ...(done.media === undefined ? {} : { media: done.media }) });
		await settle(core);
		expect((await core.history(chat)).messages.at(-1)?.media?.fileId).toBe(fileId);
		const got = await core.mediaFile({ chatId: chat, seq, fileId });
		expect(got.status).toBe("ok");
		expect((await core.mediaCacheUsage()).files).toBe(1);

		server.deleteMessages(peer, chat, [seq]);
		await settle(core);
		await vi.advanceTimersByTimeAsync(1500);
		expect((await core.mediaCacheUsage()).files).toBe(0);

		await core.signOut();
		expect(blobs.stores.has(dbName(self))).toBe(false);
	});

	it("reports media as unsupported without the platform's HTTP and storage", async () => {
		const { core, chat } = await setup(false);
		await expect(core.sendMedia(chat, file(3), { kind: "document" })).rejects.toThrow(/media/);
		await expect(core.mediaFile({ chatId: chat, seq: 1, fileId: "f" })).rejects.toThrow(/media/);
	});
});

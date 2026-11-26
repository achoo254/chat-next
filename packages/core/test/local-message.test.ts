import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("localMessage", () => {
	it("reads a stored message from the local database, and null for one it does not hold", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const other = server.addUser("Đức Việt");
		const chat = server.createChat(ChatType.PRIVATE, "", [self, other]);
		const first = server.sendMessage(other, chat, "Dũng giờ thành ông trùm").seq;
		const { core } = await startTestApp(server, self, new MemorySqlFactory());
		await settle(core);
		await core.history(chat);
		await settle(core);
		expect(await core.localMessage(chat, Number(first))).toMatchObject({ seq: Number(first), text: "Dũng giờ thành ông trùm" });
		expect(await core.localMessage(chat, 9999)).toBeNull();
		await core.close();
	});
});

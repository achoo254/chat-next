// The two AI flags the client keeps: a chat the user hid from their AI tools
// (Dialog.hidden_from_ai, its update dialog_hidden_from_ai) and a message the
// user posted through an AI tool (Message.sent_via_ai, the sender's copy only).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { systemTimers } from "@achoo254/chat-platform";
import { ChatType, DialogSchema } from "@achoo254/chat-proto/chats";
import { MessageSchema } from "@achoo254/chat-proto/messages";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { EventBus } from "../src/events/bus.ts";
import { createRemoteApi } from "../src/protocol/api.ts";
import { toDialog, toMessage, toUpdate } from "../src/protocol/map.ts";
import { migrate } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { FakeServer } from "./support/fake-server.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-11-25T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

async function engineOn(server: FakeServer, self: number): Promise<{ engine: SyncEngine; repo: Repository }> {
	const sql = new MemorySqlFactory();
	const driver = await sql.open("engine.sqlite3");
	await migrate(driver);
	const repo = new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
	const engine = new SyncEngine({ repo, api: server.apiFor(self), timers: systemTimers, selfId: self, onSessionEnded: () => undefined });
	await engine.load();
	return { engine, repo };
}

async function idle(engine: SyncEngine): Promise<void> {
	for (let i = 0; i < 500 && engine.busy; i++) await vi.advanceTimersByTimeAsync(10);
	expect(engine.busy).toBe(false);
}

describe("protocol mapping of the AI flags", () => {
	it("maps hidden_from_ai, its update and sent_via_ai", () => {
		expect(toDialog(create(DialogSchema, { chatId: big(7), hiddenFromAi: true })).hiddenFromAi).toBe(true);
		expect(toDialog(create(DialogSchema, { chatId: big(7) })).hiddenFromAi).toBe(false);
		const update = toUpdate(create(UpdateSchema, { kind: { case: "dialogHiddenFromAi", value: { chatId: big(3), hidden: true } } }));
		expect(update.body).toEqual({ kind: "dialog_hidden_from_ai", chatId: 3, hidden: true });
		expect(toMessage(create(MessageSchema, { chatId: big(1), seq: big(2), sentViaAi: true })).sentViaAi).toBe(true);
		expect(toMessage(create(MessageSchema, { chatId: big(1), seq: big(2) })).sentViaAi).toBeUndefined();
	});

	it("exposes SetDialogHiddenFromAI through createRemoteApi", () => {
		expect(typeof createRemoteApi({} as never).chats.setDialogHiddenFromAI).toBe("function");
	});
});

describe("the AI flags in the local cache", () => {
	it("takes hidden_from_ai from the snapshot and follows the update from another session", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const lan = server.addUser("Lan");
		const hidden = server.createChat(ChatType.GROUP, "Ẩn", [self, lan]);
		const shown = server.createChat(ChatType.GROUP, "Hiện", [self, lan]);
		server.sendMessage(lan, hidden, "a");
		server.sendMessage(lan, shown, "b");
		server.hideDialogFromAi(self, hidden, true);
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		expect((await repo.dialog(hidden))?.hiddenFromAi).toBe(true);
		expect((await repo.dialog(shown))?.hiddenFromAi).toBe(false);

		server.hideDialogFromAi(self, shown, true);
		server.hideDialogFromAi(self, hidden, false);
		engine.requestDifference();
		await idle(engine);
		expect((await repo.dialog(shown))?.hiddenFromAi).toBe(true);
		expect((await repo.dialog(hidden))?.hiddenFromAi).toBe(false);
		const views = await repo.dialogViews(10);
		expect(views.find((v) => v.dialog.chatId === shown)?.dialog.hiddenFromAi).toBe(true);
	});

	it("keeps sent_via_ai on the sender's own message only", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const lan = server.addUser("Lan");
		const chat = server.createChat(ChatType.PRIVATE, "", [self, lan]);
		const mine = server.sendMessage(self, chat, "gửi qua AI", 0, { sentViaAi: true }).seq;
		const theirs = server.sendMessage(lan, chat, "của Lan qua AI", 0, { sentViaAi: true }).seq;
		const { engine, repo } = await engineOn(server, self);
		engine.requestDifference();
		await idle(engine);
		await engine.fetchHistory(chat, "older", 0, 60);
		expect((await repo.message(chat, mine))?.sentViaAi).toBe(true);
		expect((await repo.message(chat, theirs))?.sentViaAi).toBeUndefined();
	});
});

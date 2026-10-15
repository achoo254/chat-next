import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ChatType } from "@app/proto-ts/chats";
import { MessageSchema } from "@app/proto-ts/messages";
import { fromBase64 } from "../src/media/codec.ts";
import { toMessage } from "../src/protocol/map.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;
const utf8 = new TextEncoder();

describe("bot reply markup", () => {
	it("maps callback and URL buttons, keeping the callback data as base64", () => {
		const message = toMessage(
			create(MessageSchema, {
				chatId: big(5),
				seq: big(2),
				fromId: big(9),
				text: "Đẩy lên production không?",
				replyMarkup: {
					kind: {
						case: "inlineKeyboard",
						value: {
							rows: [
								{
									buttons: [
										{ text: "Lên production", action: { case: "callbackData", value: utf8.encode("deploy:2.4.1") } },
										{ text: "Hoãn", action: { case: "callbackData", value: new Uint8Array([0, 255, 7]) } },
									],
								},
								{ buttons: [{ text: "Xem changelog", action: { case: "url", value: "https://gitlab.example.invalid/r" } }] },
								{ buttons: [{ text: "Mini App", action: { case: "miniAppUrl", value: "https://app.example.invalid" } }] },
							],
						},
					},
				},
			}),
		);
		expect(message.buttons).toEqual([
			[
				{ text: "Lên production", url: null, callbackData: "ZGVwbG95OjIuNC4x" },
				{ text: "Hoãn", url: null, callbackData: "AP8H" },
			],
			[{ text: "Xem changelog", url: "https://gitlab.example.invalid/r" }],
			[{ text: "Mini App", url: null }],
		]);
		expect(fromBase64(message.buttons[0]?.[1]?.callbackData ?? "")).toEqual(new Uint8Array([0, 255, 7]));
		expect(message.keyboard).toBeUndefined();
	});

	it("maps a reply keyboard and its removal, and drops empty rows", () => {
		const keyboard = toMessage(
			create(MessageSchema, {
				chatId: big(5),
				seq: big(3),
				replyMarkup: {
					kind: {
						case: "keyboard",
						value: {
							rows: [{ buttons: [{ text: "staging" }, { text: "production" }] }, { buttons: [] }, { buttons: [{ text: "Huỷ" }] }],
							oneTime: true,
							placeholder: "Chọn môi trường",
						},
					},
				},
			}),
		);
		expect(keyboard.buttons).toEqual([]);
		expect(keyboard.keyboard).toEqual({
			kind: "keyboard",
			rows: [["staging", "production"], ["Huỷ"]],
			oneTime: true,
			placeholder: "Chọn môi trường",
			selective: false,
			hidden: false,
		});
		const removed = toMessage(create(MessageSchema, { chatId: big(5), seq: big(4), replyMarkup: { kind: { case: "remove", value: {} } } }));
		expect(removed.keyboard).toEqual({ kind: "remove", selective: false });
		const empty = toMessage(create(MessageSchema, { chatId: big(5), seq: big(5), replyMarkup: { kind: { case: "keyboard", value: { rows: [] } } } }));
		expect(empty.keyboard).toBeUndefined();
	});

	it("keeps callback buttons and reply keyboards in the local database across a restart", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const bot = server.addUser("Deploy Bot");
		const chat = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);

		const inline = server.sendMessage(bot, chat, "Đẩy lên production không?", 0, {
			replyMarkup: {
				kind: {
					case: "inlineKeyboard",
					value: { rows: [{ buttons: [{ text: "Lên production", action: { case: "callbackData", value: utf8.encode("go") } }] }] },
				},
			},
		}).seq;
		const keys = server.sendMessage(bot, chat, "Chọn môi trường", 0, {
			replyMarkup: { kind: { case: "keyboard", value: { rows: [{ buttons: [{ text: "staging" }] }], oneTime: true } } },
		}).seq;
		await settle(core);

		const expected = [
			{ seq: inline, buttons: [[{ text: "Lên production", url: null, callbackData: "Z28=" }]] },
			{ seq: keys, buttons: [], keyboard: { kind: "keyboard", rows: [["staging"]], oneTime: true, placeholder: "", selective: false, hidden: false } },
		];
		expect((await core.history(chat)).messages.filter((m) => m.seq >= inline)).toMatchObject(expected);
		await core.close();

		server.online = false;
		const again = await startTestApp(server, self, sql, { userIdHint: self });
		const cached = (await again.core.history(chat)).messages.filter((m) => m.seq >= inline);
		expect(cached).toMatchObject(expected);
		expect(cached[0]?.keyboard).toBeUndefined();
		await again.core.close();
	});

	it("keeps a keyboard hidden on this device across a restart and the bot's edits", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const bot = server.addUser("Deploy Bot");
		const chat = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		const seq = server.sendMessage(bot, chat, "Chọn môi trường", 0, {
			replyMarkup: { kind: { case: "keyboard", value: { rows: [{ buttons: [{ text: "staging" }] }], oneTime: true } } },
		}).seq;
		await settle(core);
		const keyboardOf = async (app: typeof core) => (await app.history(chat)).messages.find((m) => m.seq === seq)?.keyboard;
		expect(await keyboardOf(core)).toMatchObject({ kind: "keyboard", hidden: false });
		// The stored markup is what the bot sent; hidden lives in its own column.
		const stored = sql.db(dbName(self)).prepare("SELECT reply_keyboard FROM messages WHERE chat_id = ? AND seq = ?").get(chat, seq);
		expect(JSON.parse(String(stored?.reply_keyboard))).not.toHaveProperty("hidden");

		await core.setKeyboardHidden(chat, seq, true);
		expect(await keyboardOf(core)).toMatchObject({ kind: "keyboard", hidden: true });
		// The server's copy of the message (an edit) does not bring it back.
		server.editMessage(bot, chat, seq, "Chọn môi trường (cập nhật)");
		await settle(core);
		expect(await keyboardOf(core)).toMatchObject({ hidden: true });
		await core.close();

		server.online = false;
		const again = await startTestApp(server, self, sql, { userIdHint: self });
		expect(await keyboardOf(again.core)).toMatchObject({ kind: "keyboard", hidden: true });
		await again.core.setKeyboardHidden(chat, seq, false);
		expect(await keyboardOf(again.core)).toMatchObject({ hidden: false });
		await again.core.close();
	});

	it("finds the bot's newest keyboard markup of a chat in the local database", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const bot = server.addUser("Deploy Bot");
		const chat = server.createChat(ChatType.PRIVATE, "", [self, bot]);
		const { core } = await startTestApp(server, self, new MemorySqlFactory());
		await settle(core);
		expect(await core.botKeyboard(chat, bot)).toBeNull();

		const keys = (label: string) => ({ replyMarkup: { kind: { case: "keyboard" as const, value: { rows: [{ buttons: [{ text: label }] }] } } } });
		server.sendMessage(bot, chat, "Chọn ca", 0, keys("Ca cũ"));
		const newest = server.sendMessage(bot, chat, "Chọn ca mới", 0, keys("Ca mới")).seq;
		server.sendMessage(bot, chat, "Nhật ký");
		server.sendMessage(self, chat, "staging");
		await settle(core);
		expect(await core.botKeyboard(chat, bot)).toMatchObject({ seq: newest, keyboard: { kind: "keyboard", rows: [["Ca mới"]] } });

		const removed = server.sendMessage(bot, chat, "Xong", 0, { replyMarkup: { kind: { case: "remove", value: {} } } }).seq;
		await settle(core);
		expect(await core.botKeyboard(chat, bot)).toMatchObject({ seq: removed, keyboard: { kind: "remove" } });
		await core.close();
	});
});

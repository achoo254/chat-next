import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bot, Client } from "../src/index.ts";
import type { Context, Message, Update } from "../src/index.ts";
import { jsonOf, ok, startFake } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";

let fake: FakeServer;
let bot: Bot;

beforeEach(async () => {
	fake = await startFake((req, res) => {
		if (req.url.pathname === "/me") {
			ok(res, { id: 9, is_bot: true, name: "Echo", username: "EchoBot", privacy: true, tier: "default" });
			return;
		}
		ok(res, req.url.pathname === "/messages" ? { chat: { id: 1, type: "private" }, seq: 99, date: 1 } : true);
	});
	bot = new Bot(new Client("1:t", { baseUrl: fake.url }));
});

afterEach(async () => {
	await fake.close();
});

function messageUpdate(text: string, commandLength?: number, extra: Partial<Message> = {}): Update {
	const entities = commandLength === undefined ? [] : [{ type: "bot_command" as const, offset: 0, length: commandLength }];
	return {
		update_id: 1,
		message: { chat: { id: 1, type: "group" }, seq: 5, date: 1, text, entities, ...extra },
	};
}

function commandUpdate(text: string): Update {
	return messageUpdate(text, text.split(" ")[0]?.length);
}

describe("Bot commands", () => {
	it("matches /name@username of this bot only, case-insensitively, and trims args", async () => {
		const seen: { kind: string; command: string | undefined; args: string }[] = [];
		const record =
			(kind: string) =>
			(ctx: Context): void => {
				seen.push({ kind, command: ctx.command, args: ctx.args });
			};
		bot.command("start", record("start")).message(record("message"));

		await bot.handleUpdate(commandUpdate("/start@echobot   hello  world  "));
		await bot.handleUpdate(commandUpdate("/Start"));
		await bot.handleUpdate(commandUpdate("/start@OtherBot hi"));
		await bot.handleUpdate(commandUpdate("/help"));
		await bot.handleUpdate(messageUpdate("plain text"));

		expect(seen).toEqual([
			{ kind: "start", command: "start", args: "hello  world" },
			{ kind: "start", command: "start", args: "" },
			{ kind: "message", command: undefined, args: "" },
			{ kind: "message", command: "help", args: "" },
			{ kind: "message", command: undefined, args: "" },
		]);
		expect(bot.username).toBe("EchoBot");
		expect(fake.requests.filter((r) => r.url.pathname === "/me")).toHaveLength(1);
	});

	it("ignores a bot_command entity that is not at offset 0", async () => {
		let command: string | undefined = "unset";
		bot.command("start", () => {
			command = "start";
		});
		bot.message((ctx) => {
			command = ctx.command;
		});
		await bot.handleUpdate({
			update_id: 2,
			message: {
				chat: { id: 1, type: "private" },
				seq: 1,
				date: 1,
				text: "say /start",
				entities: [{ type: "bot_command", offset: 4, length: 6 }],
			},
		});
		expect(command).toBeUndefined();
	});

	it("replies into the message's chat and topic", async () => {
		bot.command("start", (ctx) => ctx.reply("Sẵn sàng."));
		await bot.handleUpdate(messageUpdate("/start", 6, { topic_id: 3 }));
		const send = fake.requests.find((r) => r.url.pathname === "/messages");
		expect(jsonOf(send)).toEqual({ chat_id: 1, topic_id: 3, text: "Sẵn sàng." });
	});
});

describe("Bot callbacks", () => {
	const press = (data: string): Update => ({
		update_id: 3,
		callback: {
			id: "cb1",
			from: { id: 2, is_bot: false, name: "An" },
			message: { chat: { id: 4, type: "private" }, seq: 8, date: 1 },
			data,
		},
	});

	it("routes to the longest matching prefix", async () => {
		const seen: string[] = [];
		bot.callback("pick:", (ctx) => seen.push(`short ${ctx.callback?.data}`));
		bot.callback("pick:a", (ctx) => seen.push(`long ${ctx.callback?.data}`));
		await bot.handleUpdate(press("pick:abc"));
		await bot.handleUpdate(press("pick:b"));
		await bot.handleUpdate(press("other"));
		expect(seen).toEqual(["long pick:abc", "short pick:b"]);
	});

	it("answers the press and replies into the pressed message's chat", async () => {
		bot.callback("pick:", async (ctx) => {
			await ctx.answer("Đã chọn A", true);
			await ctx.reply("ok");
		});
		await bot.handleUpdate(press("pick:a"));
		const answer = fake.requests.find((r) => r.url.pathname === "/callbacks/cb1:answer");
		expect(jsonOf(answer)).toEqual({ text: "Đã chọn A", show_alert: true });
		expect(jsonOf(fake.requests.find((r) => r.url.pathname === "/messages"))).toEqual({ chat_id: 4, text: "ok" });
	});
});

describe("Bot other kinds", () => {
	it("answers an inline query", async () => {
		bot.inlineQuery((ctx) =>
			ctx.answerInline([{ type: "article", id: "1", title: "HI", text: "hi" }], { cache_time: 0 }),
		);
		await bot.handleUpdate({
			update_id: 4,
			inline_query: { id: "q1", from: { id: 2, is_bot: false, name: "An" }, query: "hi", offset: "", chat_type: "private" },
		});
		const answer = fake.requests.find((r) => r.url.pathname === "/inline/q1:answer");
		expect(jsonOf(answer)).toEqual({ cache_time: 0, results: [{ type: "article", id: "1", title: "HI", text: "hi" }] });
	});

	it("routes on(kind) handlers and ignores unknown kinds", async () => {
		const seen: string[] = [];
		bot.on("reaction", (ctx) => seen.push(ctx.update.reaction?.emoji ?? ""));
		await bot.handleUpdate({
			update_id: 5,
			reaction: { chat: { id: 1, type: "group" }, seq: 2, user: { id: 2, is_bot: false, name: "An" }, emoji: "👍", date: 1 },
		});
		const future = JSON.parse('{"update_id": 6, "story_posted": {"id": 1}}') as Update;
		await expect(bot.handleUpdate(future)).resolves.toBeUndefined();
		expect(seen).toEqual(["👍"]);
	});

	it("returns a handler's WebhookAnswer and ignores other return values", async () => {
		bot.command("start", () => ({ method: "sendMessage", chat_id: 1, text: "hi" }));
		bot.message((ctx) => ctx.reply("echo"));
		await expect(bot.handleUpdate(commandUpdate("/start"))).resolves.toEqual({ method: "sendMessage", chat_id: 1, text: "hi" });
		await expect(bot.handleUpdate(messageUpdate("text"))).resolves.toBeUndefined();
	});
});

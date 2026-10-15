// The assistant bot's chat for an account that existed before it: created
// on the server without a message, it reaches a running app only as
// member_added, and a device may hold it without the bot (taken by an
// older build). Either way the list names the bot and the chat offers
// "Bắt đầu", never "Chat đã xoá".
import { Code } from "@connectrpc/connect";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const BOT = "Chat Trợ lý";

async function expectStartableBotChat(): Promise<void> {
	const list = await screen.findByRole("list", { name: /Danh sách chat|Chats/ }, LONG);
	const row = await within(list).findByText(BOT, {}, LONG);
	expect(within(list).queryByText("Chat đã xoá")).toBeNull();
	await userEvent.click(row);
	expect(await screen.findByRole("button", { name: "Bắt đầu" }, LONG)).toBeTruthy();
	expect(screen.queryByText("Chat đã xoá")).toBeNull();
}

describe("the assistant chat of an existing account", () => {
	it("names the bot when the chat arrives while the app runs, even without the bot in the update", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const bot = f.bots.seed(BOT, "tro_ly_bot", { description: "Trợ lý của bạn.", owned: false });
		renderMessaging(f, "/");
		await screen.findByRole("list", { name: /Danh sách chat|Chats/ }, LONG);

		// The server of the incident: the update carries the chat but not the
		// bot, and the follow-up refresh of the chat fails.
		f.server.framesWithoutPeers = true;
		f.server.faults.push({ method: "getChat", when: "before", code: Code.Unavailable, remaining: 1 });
		f.server.faults.push({ method: "getPeerDialogs", when: "before", code: Code.Unavailable, remaining: 1 });
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, bot]);
		f.server.addMember(chat, f.selfId, f.selfId);

		await expectStartableBotChat();
	});

	it("fetches the bot for a device that stored the chat without it", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const bot = f.bots.seed(BOT, "tro_ly_bot", { description: "Trợ lý của bạn.", owned: false });
		f.createChat(ChatType.PRIVATE, "", [f.selfId, bot]);
		const sql = new MemorySqlFactory();
		const first = renderMessaging(f, "/", sql);
		const list = await screen.findByRole("list", { name: /Danh sách chat|Chats/ }, LONG);
		await within(list).findByText(BOT, {}, LONG);
		first.unmount();

		// What an older build left behind: the chat and its dialog, no bot.
		for (const db of sql.files.values()) db.prepare("DELETE FROM users WHERE id = ?").run(bot);
		renderMessaging(f, "/", sql);

		await expectStartableBotChat();
	});
});

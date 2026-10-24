// The assistant bot's chat for an account that existed before it: created
// on the server without a message, it reaches a running app only as
// member_added, and a device may hold it without the bot (taken by an
// older build). Either way the list names the bot and the chat offers
// "Bắt đầu", never "Chat đã xoá".
import { Code } from "@connectrpc/connect";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatType } from "@achoo254/chat-proto/chats";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { App } from "../src/app.tsx";
import type { MessagingConnector } from "../src/messaging/data/connector.ts";
import { seedDemo } from "./support/demo-data.ts";
import { fixtureConnector } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { routerFetch } from "./support/router-fetch.ts";

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

	it.each([
		["without the bot", ""],
		["with no other person (peer 0)", "UPDATE chats SET peer_user_id = 0 WHERE id = ?"],
	])("repairs a device that stored the chat %s", async (_, corrupt) => {
		const demo = seedDemo();
		const f = demo.fixture;
		const bot = f.bots.seed(BOT, "tro_ly_bot", { description: "Trợ lý của bạn.", owned: false });
		const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, bot]);
		const sql = new MemorySqlFactory();
		const first = renderMessaging(f, "/", sql);
		const list = await screen.findByRole("list", { name: /Danh sách chat|Chats/ }, LONG);
		await within(list).findByText(BOT, {}, LONG);
		first.unmount();

		// What an older build left behind: the chat and its dialog, no bot.
		for (const db of sql.files.values()) {
			db.prepare("DELETE FROM users WHERE id = ?").run(bot);
			if (corrupt !== "") db.prepare(corrupt).run(chat);
		}
		renderMessaging(f, "/", sql);

		await expectStartableBotChat();
	});

	it("names the bot when every request of the client core for it fails", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const bot = f.bots.seed(BOT, "tro_ly_bot", { description: "Trợ lý của bạn.", owned: false });
		f.createChat(ChatType.PRIVATE, "", [f.selfId, bot]);
		const sql = new MemorySqlFactory();
		const first = renderMessaging(f, "/", sql);
		await within(await screen.findByRole("list", { name: /Danh sách chat|Chats/ }, LONG)).findByText(BOT, {}, LONG);
		first.unmount();
		for (const db of sql.files.values()) db.prepare("DELETE FROM users WHERE id = ?").run(bot);
		for (const method of ["getUsers", "getChat", "getPeerDialogs"]) {
			f.server.faults.push({ method, when: "before", code: Code.Unavailable, remaining: 5 });
		}
		renderMessaging(f, "/", sql);

		// The list asks the server itself.
		await expectStartableBotChat();
	});

	it("names the bot in a tab whose database is served by a tab of an older build", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const bot = f.bots.seed(BOT, "tro_ly_bot", { description: "Trợ lý của bạn.", owned: false });
		f.createChat(ChatType.PRIVATE, "", [f.selfId, bot]);
		// The leading tab's database has the chat but not the bot, and its
		// build never asks the server for a missing user.
		const base = fixtureConnector(f, async () => new MemorySqlFactory());
		const connector: MessagingConnector = async (options) => {
			const client = await base(options);
			const source = {
				...client.source,
				users: async (ids: readonly number[]) => (await client.source.users(ids)).filter((user) => user.id !== bot),
				dialogs: async (limit?: number) =>
					(await client.source.dialogs(limit)).map((view) => (view.peer?.id === bot ? { ...view, peer: null } : view)),
			};
			return { ...client, source };
		};
		window.history.replaceState(null, "", "/");
		render(<App rpcFetch={routerFetch((router) => f.routes(router))} messagingConnector={connector} />);

		await expectStartableBotChat();
	});
});


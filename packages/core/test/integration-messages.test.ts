import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema } from "@app/proto-ts/messages";
import { UpdateSchema } from "@app/proto-ts/updates";
import { ChatType } from "@app/proto-ts/chats";
import { toUpdate } from "../src/protocol/map.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

const big = BigInt;

describe("integration (incoming webhook) messages", () => {
	it("maps the label, inline buttons, silence and the notify flag of an edit", () => {
		const message = create(MessageSchema, {
			chatId: big(5),
			seq: big(2),
			text: "Firing DiskFull",
			integrationLabel: "Alertmanager prod",
			silent: true,
			replyMarkup: {
				kind: {
					case: "inlineKeyboard",
					value: {
						rows: [
							{ buttons: [{ text: "Mở nguồn", action: { case: "url", value: "https://prom.example.invalid/g" } }] },
							{ buttons: [{ text: "Bot", action: { case: "callbackData", value: new Uint8Array([1]) } }] },
							{ buttons: [] },
						],
					},
				},
			},
		});
		const added = toUpdate(create(UpdateSchema, { kind: { case: "messageNew", value: { message } } }));
		expect(added.body).toMatchObject({
			kind: "message_new",
			notify: false,
			message: {
				fromId: 0,
				integrationLabel: "Alertmanager prod",
				buttons: [[{ text: "Mở nguồn", url: "https://prom.example.invalid/g" }], [{ text: "Bot", url: null }]],
			},
		});
		const edited = toUpdate(create(UpdateSchema, { kind: { case: "messageEdit", value: { message, notify: true } } }));
		expect(edited.body).toMatchObject({ kind: "message_edit", notify: true });
		const plain = toUpdate(create(UpdateSchema, { kind: { case: "messageNew", value: { message: create(MessageSchema, { text: "x" }) } } }));
		expect(plain.body).toMatchObject({ notify: true, message: { buttons: [], integrationLabel: "" } });
	});

	it("notifies under the hook label, skips silent posts, notifies a state change and keeps buttons locally", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const chat = server.createChat(ChatType.GROUP, "Vận hành", [self]);
		const sql = new MemorySqlFactory();
		const { core, platform } = await startTestApp(server, self, sql);
		await settle(core);

		const alert = server.postIntegration(chat, "Alertmanager prod", "Firing DiskFull trên db-02", {
			buttons: [[{ text: "Mở nguồn", url: "https://prom.example.invalid/g" }]],
		});
		await settle(core);
		expect(platform.notifications.map((n) => [n.title, n.body])).toEqual([["Vận hành", "Alertmanager prod: Firing DiskFull trên db-02"]]);

		server.postIntegration(chat, "Jenkins build", "Build #318 thành công", { silent: true });
		server.editIntegration(chat, alert, "Firing DiskFull trên db-02 (lặp lại)", false);
		await settle(core);
		expect(platform.notifications).toHaveLength(1);

		server.editIntegration(chat, alert, "Resolved DiskFull trên db-02", true);
		await settle(core);
		expect(platform.notifications.map((n) => n.body)).toEqual([
			"Alertmanager prod: Firing DiskFull trên db-02",
			"Alertmanager prod: Resolved DiskFull trên db-02",
		]);

		const view = await core.history(chat);
		const posted = view.messages.find((m) => m.seq === alert);
		expect(posted).toMatchObject({
			fromId: 0,
			text: "Resolved DiskFull trên db-02",
			integrationLabel: "Alertmanager prod",
			buttons: [[{ text: "Mở nguồn", url: "https://prom.example.invalid/g" }]],
		});
		await core.close();

		// The buttons come back from the local database after a restart.
		server.online = false;
		const again = await startTestApp(server, self, sql, { userIdHint: self });
		const cached = (await again.core.history(chat)).messages.find((m) => m.seq === alert);
		expect(cached?.buttons).toEqual([[{ text: "Mở nguồn", url: "https://prom.example.invalid/g" }]]);
		await again.core.close();
	});
});

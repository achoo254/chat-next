// AI Agent › Liên hệ: a person linked across apps is one row over all of
// their one-to-one chats, groups are rows of their own; «Đẩy tin vào phiên»
// sends one ChatInboxSet per chat of the row and the row says what the
// machine reports (also when it pushes a new state); a machine before
// tunelo 3.28.0 gets a note and no request; «Mở phiên» opens or finds the
// chat's session, «Nhắn nhanh» opens it with the composer ready.
import { ChatInboxItemState, LoginState, ThreadState, type ChatInboxItem, type ChatInboxSet, type ThreadCreate, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { ChatType } from "@achoo254/chat-proto/chats";
import { create } from "@bufbuild/protobuf";
import { ChatInboxItemSchema } from "@achoo254/chat-proto/remote/remote";
import type { DialogView } from "@achoo254/chat-core";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/app.tsx";
import { statusText } from "../../src/machines/contacts-page.tsx";
import { contactRows, inboxSets, rowStatus, type ContactRow } from "../../src/machines/contacts-model.ts";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { MemorySqlFactory } from "../../../../packages/core/test/support/node-sql.ts";
import { defaultAnswer, FakeMachine, type Body, type FakeSocket } from "./fake-machine.ts";
import { ChatFixture, fixtureConnector } from "../support/fake-chat.ts";
import { FakeMachines } from "../support/fake-machines.ts";
import { boxValue } from "../support/plain-text-box.ts";
import { routerFetch } from "../support/router-fetch.ts";

const LONG = { timeout: 8000 };
let device: KeyPair;

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
	}),
}));

const NativeWebSocket = window.WebSocket;

beforeEach(async () => {
	window.localStorage.clear();
	device = await generateKeyPair();
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

const view = (fields: { id: number; type: "private" | "group" | "channel"; title?: string; app?: string; peer?: { id: number; name: string; isBot?: boolean }; hidden?: boolean; left?: boolean }): DialogView =>
	({
		dialog: { chatId: fields.id, hiddenFromAi: fields.hidden === true },
		chat: { id: fields.id, type: fields.type, title: fields.title ?? "", left: fields.left === true, peerUserId: fields.peer?.id ?? 0, ...(fields.app === undefined ? {} : { externalApp: fields.app }) },
		peer: fields.peer === undefined ? null : { id: fields.peer.id, name: fields.peer.name, isBot: fields.peer.isBot === true },
		topMessage: null,
	}) as unknown as DialogView;

describe("the rows of Liên hệ", () => {
	const views = new Map<number, DialogView>([
		[11, view({ id: 11, type: "private", peer: { id: 2, name: "Lan" } })],
		[12, view({ id: 12, type: "group", title: "Nhóm dự án", app: "telegram" })],
		[13, view({ id: 13, type: "private", app: "telegram", peer: { id: 3, name: "Lan Telegram" }, hidden: true })],
		[14, view({ id: 14, type: "private", peer: { id: 4, name: "Bot giờ" , isBot: true } })],
		[15, view({ id: 15, type: "private", peer: { id: 1, name: "Tôi" } })],
		[16, view({ id: 16, type: "channel", title: "Tin tức" })],
		[17, view({ id: 17, type: "private", app: "zalo", peer: { id: 5, name: "Bình" } })],
	]);
	const people = [{ id: 7, name: "Lan", members: [{ userId: 2, name: "Lan", app: "", chatId: 11 }, { userId: 3, name: "Lan Telegram", app: "telegram", chatId: 13 }] }];

	it("folds a person across apps into one row, keeps groups and other one-to-one chats, leaves bots, channels and the user out", () => {
		const rows = contactRows([13, 12, 11, 14, 15, 16, 17], (id) => views.get(id), people, 1);
		expect(rows.map((r) => [r.key, r.name, r.chats.map((c) => [c.chatId, c.app, c.hiddenFromAi])])).toEqual([
			["p7", "Lan", [[13, "telegram", true], [11, "", false]]],
			["c12", "Nhóm dự án", [[12, "telegram", false]]],
			["c17", "Bình", [[17, "zalo", false]]],
		]);
		expect(rows[1]?.group).toBe(true);
	});

	it("turns a person on with one ChatInboxSet per one-to-one chat", () => {
		const [lan] = contactRows([11, 13], (id) => views.get(id), people, 1);
		expect(inboxSets(lan as ContactRow, true, 20)).toEqual([
			{ chatId: 11n, title: "Lan", app: "", enabled: true, perHourLimit: 20 },
			{ chatId: 13n, title: "Lan Telegram", app: "telegram", enabled: true, perHourLimit: 20 },
		]);
	});

	it("says what the machine reports, the worst of a row's chats first", () => {
		const [lan] = contactRows([11, 13], (id) => views.get(id), people, 1) as [ContactRow];
		const item = (chatId: bigint, fields: Partial<Omit<ChatInboxItem, "$typeName">>) => create(ChatInboxItemSchema, { chatId, enabled: true, perHourLimit: 20, state: ChatInboxItemState.ACTIVE, ...fields });
		const text = (items: ChatInboxItem[]) => statusText(viMachines, rowStatus(lan, items));
		expect(text([])).toBe("");
		expect(text([item(11n, { deliveredLastHour: 2 }), item(13n, { deliveredLastHour: 1 })])).toBe("Đang đẩy · 3 lượt trong giờ qua");
		expect(text([item(11n, { enabled: false }), item(13n, { enabled: false })])).toBe("Đã tạm dừng");
		expect(text([item(11n, { state: ChatInboxItemState.HIDDEN })])).toBe("Chat đang ẩn với AI");
		expect(text([item(11n, { state: ChatInboxItemState.LIMITED, missed: 4 }), item(13n, {})])).toBe("Hết lượt trong giờ · bỏ lỡ 4 tin");
		expect(text([item(11n, { state: ChatInboxItemState.ERROR }), item(13n, { state: ChatInboxItemState.LIMITED })])).toBe("Không đọc được Chat, sẽ thử lại");
		expect(text([item(13n, { state: ChatInboxItemState.SIGNED_OUT }), item(11n, { state: ChatInboxItemState.ERROR })])).toBe("Máy chưa đăng nhập Chat: chạy tunelo login");
		expect(statusText(enMachines, rowStatus(lan, [item(11n, { deliveredLastHour: 1 })]))).toBe("Pushing · 1 turn in the last hour");
	});
});

describe("the layout of Liên hệ", () => {
	it("labels the switch shortly in a narrow column and keeps the rows clear of the docked mascot", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const sheet = readFileSync(resolve(process.cwd(), "src/machines/machines.css"), "utf8");
		expect(sheet).toMatch(/\.mx-contact-push-short \{ display: none; \}/);
		const narrow = /@container \(max-width: 560px\) \{[^@]*\.mx-contact-push-short \{ display: inline; \}/.exec(sheet);
		expect(narrow?.[0]).toContain(".mx-contact-push-long { display: none; }");
		expect(sheet).toContain(':root:has(.adv-mascot[data-side="right"]) .mx-contacts > .mx-body { padding-right: calc(var(--space-5) + 72px); }');
		expect([viMachines.contacts.pushShort, enMachines.contacts.pushShort]).toEqual(["Đẩy tin", "Push"]);
	});
});

describe("Liên hệ against a machine", () => {
	async function withMachine(version = "3.28.0", threads: ThreadSummary[] = []) {
		const machine = await FakeMachine.create();
		machine.trusted = [device.publicKey];
		const sets: ChatInboxSet[] = [];
		const created: ThreadCreate[] = [];
		let inbox: ChatInboxItem[] = [];
		let socket: FakeSocket | null = null;
		const state = (): Body => ({ case: "chatInboxState", value: { items: inbox } });
		machine.handler = (frame, from) => {
			socket = from;
			const b = frame.body;
			switch (b.case) {
				case "machineInfoRequest":
					return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: version, maxSessions: 3, providers: [{ id: "claude", name: "Claude Code", loginState: LoginState.OK }] } }];
				case "threadList":
					return [{ case: "threadListResult", value: { threads, openSessions: 0, maxSessions: 3 } }];
				case "chatInboxList":
					return [state()];
				case "chatInboxSet": {
					sets.push(b.value);
					const rest = inbox.filter((i) => i.chatId !== b.value.chatId);
					inbox = [...rest, create(ChatInboxItemSchema, { chatId: b.value.chatId, title: b.value.title, app: b.value.app, enabled: b.value.enabled, perHourLimit: b.value.perHourLimit || 20, state: ChatInboxItemState.ACTIVE })];
					return [state()];
				}
				case "threadCreate": {
					created.push(b.value);
					const thread = { id: "chat-new", title: b.value.chat?.title ?? "", dir: "/x", provider: b.value.provider, state: ThreadState.IDLE, chatId: b.value.chat?.chatId ?? 0n } as ThreadSummary;
					threads = [thread];
					return [{ case: "threadCreated", value: { thread } }];
				}
				default:
					return defaultAnswer(frame);
			}
		};
		window.WebSocket = function (url: string) {
			return machine.factory(url);
		} as unknown as typeof WebSocket;
		const machines = new FakeMachines();
		machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: machine.keys.publicKey });
		/** The machine says something changed, unasked. */
		const push = (items: ChatInboxItem[]) => {
			inbox = items;
			if (socket !== null) machine.send(socket, state());
		};
		return { machine, machines, sets, created, push, received: () => machine.received.map((f) => f.body.case) };
	}

	function setup() {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan");
		const lanTelegram = fixture.addUser("Lan Telegram");
		const lanChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		const lanTelegramChat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lanTelegram], { externalApp: "telegram" });
		const group = fixture.createChat(ChatType.GROUP, "Nhóm dự án", [fixture.selfId, lan]);
		fixture.send(lan, lanChat, "chào");
		fixture.send(lanTelegram, lanTelegramChat, "chào từ Telegram");
		fixture.send(lan, group, "họp nhé");
		fixture.people.link([lan, lanTelegram]);
		return { fixture, lanChat, lanTelegramChat, group };
	}

	function renderAt(fixture: ChatFixture, machines: FakeMachines, path: string) {
		window.history.replaceState(null, "", path);
		const sql = new MemorySqlFactory();
		const rpcFetch = routerFetch((router) => {
			fixture.routes(router);
			machines.routes(router);
		});
		return render(<App rpcFetch={rpcFetch} messagingConnector={fixtureConnector(fixture, async () => sql)} />);
	}

	const rowOf = async (name: string) => (await screen.findByText(name, { selector: ".mx-contact-name b" }, LONG)).closest("li") as HTMLElement;

	it("lists Lan once with both apps, turns her on with one request per chat, and follows what the machine pushes", async () => {
		const { fixture, lanChat, lanTelegramChat } = setup();
		const { machines, sets, push } = await withMachine();
		renderAt(fixture, machines, "/ai/contacts");
		const lan = await rowOf("Lan");
		expect(within(lan).getByText("Telegram")).toBeTruthy();
		expect(within(lan).getByText("Chat")).toBeTruthy();
		expect(await rowOf("Nhóm dự án")).toBeTruthy();
		const toggle = within(lan).getByRole("switch", { name: "Đẩy tin của Lan vào phiên" });
		// Both labels are drawn (CSS shows one by width); the switch keeps the full name.
		expect(within(lan).getByText("Đẩy tin vào phiên")).toBeTruthy();
		expect(within(lan).getByText("Đẩy tin")).toBeTruthy();
		await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(toggle);
		await waitFor(() => expect(sets).toHaveLength(2), LONG);
		expect(sets.map((s) => [Number(s.chatId), s.enabled, s.perHourLimit]).sort()).toEqual([[lanChat, true, 20], [lanTelegramChat, true, 20]].sort());
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"), LONG);
		expect(within(lan).getByRole("combobox", { name: "Giới hạn lượt mỗi giờ" })).toBeTruthy();
		expect(await within(lan).findByText("Đang đẩy · 0 lượt trong giờ qua", {}, LONG)).toBeTruthy();

		push([
			create(ChatInboxItemSchema, { chatId: BigInt(lanChat), enabled: true, perHourLimit: 20, state: ChatInboxItemState.LIMITED, missed: 4 }),
			create(ChatInboxItemSchema, { chatId: BigInt(lanTelegramChat), enabled: true, perHourLimit: 20, state: ChatInboxItemState.ACTIVE, deliveredLastHour: 20 }),
		]);
		expect(await within(lan).findByText("Hết lượt trong giờ · bỏ lỡ 4 tin", {}, LONG)).toBeTruthy();
	});

	it("tells an older machine to update and asks it nothing about subscriptions", async () => {
		const { fixture } = setup();
		const { machines, received } = await withMachine("3.27.2");
		renderAt(fixture, machines, "/ai/contacts");
		expect(await screen.findByText(/cập nhật lên 3\.28\.0 trở lên/, {}, LONG)).toBeTruthy();
		const lan = await rowOf("Lan");
		await waitFor(() => expect(received()).toContain("threadList"), LONG);
		expect((within(lan).getByRole("switch", { name: "Đẩy tin của Lan vào phiên" }) as HTMLButtonElement).disabled).toBe(true);
		expect(received()).not.toContain("chatInboxList");
		expect(received()).not.toContain("chatInboxSet");
	});

	it("«Mở phiên» opens a group's session with its chat, then shows it", async () => {
		const { fixture, group } = setup();
		const { machines, created } = await withMachine();
		renderAt(fixture, machines, "/ai/contacts");
		const row = await rowOf("Nhóm dự án");
		const open = within(row).getByRole("button", { name: "Mở phiên" });
		await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(open);
		await waitFor(() => expect(created).toHaveLength(1), LONG);
		expect(Number(created[0]?.chat?.chatId)).toBe(group);
		expect(created[0]?.dir).toBe("");
		expect(created[0]?.text).toContain(`chat_id: ${group}`);
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/chat-new"), LONG);
	});

	it("«Nhắn nhanh» opens the session the chat has and readies its composer", async () => {
		const { fixture, lanChat } = setup();
		const existing = { id: "lan-session", title: "Lan", dir: "/x", provider: "claude", state: ThreadState.IDLE, chatId: BigInt(lanChat) } as ThreadSummary;
		const { machines, created } = await withMachine("3.28.0", [existing]);
		renderAt(fixture, machines, "/ai/contacts");
		const lan = await rowOf("Lan");
		const quick = within(lan).getByRole("button", { name: "Nhắn nhanh" });
		await waitFor(() => expect((quick as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(quick);
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/lan-session"), LONG);
		const box = await screen.findByRole("textbox", { name: "Tin nhắn" }, LONG);
		await waitFor(() => expect(boxValue(box)).toBe("Nhắn cho Lan: "), LONG);
		expect(created).toHaveLength(0);
	});
});

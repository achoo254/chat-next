// The AI panel of a conversation and the two AI flags around it: «Hỏi AI» on
// a message opens the panel about it; "/ai …" in the chat's composer asks
// there and posts nothing in the chat; the first question opens the chat's
// own session on the user's machine (ThreadCreate with the chat and the
// context), whose replies go into the chat's composer («Đưa vào ô soạn tin»)
// replying to the message asked about; "Ẩn với AI" calls the server and
// follows its update; "qua AI" marks only the user's own messages.
import { LoginState, Role, ThreadState, type ThreadCreate, type ThreadSend, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { ChatType } from "@achoo254/chat-proto/chats";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.tsx";
import { aiQuestion } from "../src/messaging/ui/composer.tsx";
import { chatContext, chatThread, pickTarget } from "../src/messaging/ui/use-chat-ai.ts";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { defaultAnswer, FakeMachine, type Body } from "./machines/fake-machine.ts";
import { ChatFixture, fixtureConnector } from "./support/fake-chat.ts";
import { FakeMachines } from "./support/fake-machines.ts";
import { boxValue } from "./support/plain-text-box.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { routerFetch } from "./support/router-fetch.ts";

const LONG = { timeout: 8000 };
const QUESTION = "mai họp lúc mấy giờ?";
const REPLY = "Dạ, mai họp lúc 9 giờ ạ.";

let device: KeyPair;

vi.mock("../src/machines/link/device-keys.ts", () => ({
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

/** A chat with Lan and her question; the user is on its screen. */
function lanChat(): { fixture: ChatFixture; chatId: number; lan: number } {
	const fixture = new ChatFixture();
	const lan = fixture.addUser("Lan");
	const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
	fixture.send(lan, chatId, QUESTION);
	return { fixture, chatId, lan };
}

async function openMenuOf(text: string): Promise<void> {
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	fireEvent.contextMenu(await within(log).findByText(text, {}, LONG));
}

async function panel(): Promise<HTMLElement> {
	return screen.findByRole("complementary", { name: "AI" }, LONG);
}

describe("opening the AI panel", () => {
	it("«Hỏi AI» opens the panel about the message, with its sender and the quick questions", async () => {
		const { fixture, chatId } = lanChat();
		renderMessaging(fixture, `/c/${chatId}`);
		await openMenuOf(QUESTION);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));

		const shown = await panel();
		const quote = within(shown).getByRole("region", { name: "Tin đang hỏi" });
		expect(within(quote).getByText(QUESTION)).toBeTruthy();
		expect(within(quote).getByText("Lan")).toBeTruthy();
		const chips = within(quote).getByRole("group", { name: "Hỏi nhanh" });
		expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["Soạn trả lời", "Tóm tắt", "Dịch", "Giải thích"]);
		// No machine on the account: the panel says so, with the way to AI Agent.
		expect(await within(shown).findByText("Chưa có máy", {}, LONG)).toBeTruthy();
		expect(within(shown).getByRole("link", { name: "Mở AI Agent" }).getAttribute("href")).toBe("/ai");
		// The header's AI button shows the panel open, and closes it.
		const toggle = screen.getByRole("button", { name: "Hỏi AI", pressed: true });
		await userEvent.click(toggle);
		await waitFor(() => expect(screen.queryByRole("complementary", { name: "AI" })).toBeNull());
	});

	it("'/ai …' opens the panel with the question and sends nothing into the chat", async () => {
		const { fixture, chatId } = lanChat();
		renderMessaging(fixture, `/c/${chatId}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
		await userEvent.type(box, "/ai tóm tắt giúp tôi{Enter}");

		const shown = await panel();
		// No machine to take it yet: the question waits in the panel's box.
		const ask = within(shown).getByRole("textbox", { name: "Hỏi AI về hội thoại này…" }) as HTMLTextAreaElement;
		expect(ask.value).toBe("tóm tắt giúp tôi");
		expect(boxValue(box)).toBe("");
		const log = screen.getByRole("log", { name: "Tin nhắn" });
		expect(within(log).queryByText(/tóm tắt giúp tôi/)).toBeNull();
		expect(fixture.server.expectedMessages(chatId, fixture.selfId).filter((m) => m.fromId === fixture.selfId)).toHaveLength(0);
	});
});

describe("the chat's session on the machine", () => {
	/**
	 * A machine on the account that keeps one session per chat, as tunelo does. `version`: its tunelo;
	 * `knowsChats` false: it answers ThreadCreate with a session naming no chat; `holdCreate`: it answers
	 * ThreadCreate only when the test releases it.
	 */
	async function withMachine({ version = "3.30.0", knowsChats = true, holdCreate = false } = {}) {
		const held: (() => void)[] = [];
		const machine = await FakeMachine.create();
		machine.trusted = [device.publicKey];
		const created: ThreadCreate[] = [];
		const sends: ThreadSend[] = [];
		let threads: ThreadSummary[] = [];
		const items = (threadId: string): Body => ({
			case: "threadItems",
			value: {
				threadId,
				items: [
					{ id: "u1", seq: 1n, revision: 1, at: 1n, body: { case: "text", value: { role: Role.USER, text: created[0]?.text ?? "", clientMsgId: "" } } },
					{ id: "a1", seq: 2n, revision: 1, at: 2n, body: { case: "text", value: { role: Role.ASSISTANT, text: REPLY, clientMsgId: "" } } },
				],
				cursor: { epoch: 1n, seq: 2n },
			},
		});
		machine.handler = (frame, socket) => {
			const b = frame.body;
			switch (b.case) {
				case "machineInfoRequest":
					return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: version, maxSessions: 3, providers: [{ id: "claude", name: "Claude Code", loginState: LoginState.OK }] } }];
				case "threadList":
					return [{ case: "threadListResult", value: { threads, openSessions: 0, maxSessions: 3 } }];
				case "threadCreate": {
					created.push(b.value);
					const thread = { id: "chat-1", title: b.value.chat?.title ?? "", dir: "/Users/me/.tunelo/chats/1", provider: b.value.provider, state: ThreadState.IDLE, chatId: knowsChats ? (b.value.chat?.chatId ?? 0n) : 0n } as ThreadSummary;
					threads = [thread];
					const answer: Body = { case: "threadCreated", value: { thread } };
					if (!holdCreate) return [answer];
					held.push(() => machine.send(socket, answer, frame.id));
					return [];
				}
				case "threadSubscribe":
					return [items(b.value.threadId)];
				case "threadSend":
					sends.push(b.value);
					return [{ case: "ack", value: {} }];
				default:
					return defaultAnswer(frame);
			}
		};
		window.WebSocket = function (url: string) {
			return machine.factory(url);
		} as unknown as typeof WebSocket;
		const machines = new FakeMachines();
		machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: machine.keys.publicKey });
		const release = () => {
			for (const answer of held.splice(0)) answer();
		};
		return { machine, machines, created, sends, release };
	}

	function renderWith(fixture: ChatFixture, machines: FakeMachines, path: string) {
		window.history.replaceState(null, "", path);
		const sql = new MemorySqlFactory();
		const rpcFetch = routerFetch((router) => {
			fixture.routes(router);
			machines.routes(router);
		});
		return render(<App rpcFetch={rpcFetch} messagingConnector={fixtureConnector(fixture, async () => sql)} />);
	}

	it("opens the session with the chat and its context, and puts a reply into the composer replying to the message asked about", async () => {
		const { fixture, chatId } = lanChat();
		const { machines, created } = await withMachine();
		renderWith(fixture, machines, `/c/${chatId}`);
		await openMenuOf(QUESTION);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));
		const shown = await panel();

		const draft = await within(shown).findByRole("button", { name: "Soạn trả lời" }, LONG);
		await waitFor(() => expect((draft as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(draft);

		await waitFor(() => expect(created).toHaveLength(1), LONG);
		const request = created[0];
		expect(request?.chat?.chatId).toBe(BigInt(chatId));
		expect(request?.chat?.title).toBe("Lan");
		expect(request?.dir).toBe("");
		// The machine's own AI, never a fixed one.
		expect(request?.provider).toBe("claude");
		expect(request?.text).toContain(`chat_id: ${chatId}`);
		expect(request?.text).toContain("Gợi ý trả lời chỉ là bản nháp.");
		expect(request?.text).toContain(QUESTION);
		expect(request?.text).toContain("Soạn giúp tôi một câu trả lời cho tin này.");

		const use = await within(shown).findByRole("button", { name: "Đưa vào ô soạn tin" }, { timeout: 15_000 });
		await userEvent.click(use);
		const box = screen.getByRole("textbox", { name: /Tin nhắn tới/ });
		await waitFor(() => expect(boxValue(box)).toBe(REPLY), LONG);
		// Replying to Lan's message, sent by the user, not by the panel.
		await waitFor(() => expect(document.querySelector(".compose-bar")?.textContent ?? "").toContain(QUESTION), LONG);
		expect(fixture.server.expectedMessages(chatId, fixture.selfId).filter((m) => m.fromId === fixture.selfId)).toHaveLength(0);
	});

	it("asks before replacing what the user is typing", async () => {
		const { fixture, chatId } = lanChat();
		const { machines } = await withMachine();
		renderWith(fixture, machines, `/c/${chatId}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
		await userEvent.type(box, "đang viết dở");
		await userEvent.click(screen.getByRole("button", { name: "Hỏi AI" }));
		const shown = await panel();
		const ask = await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG);
		await waitFor(() => expect((ask as HTMLTextAreaElement).disabled).toBe(false), LONG);
		await userEvent.type(ask, "soạn câu trả lời{Enter}");

		await userEvent.click(await within(shown).findByRole("button", { name: "Đưa vào ô soạn tin" }, { timeout: 15_000 }));
		const dialog = await screen.findByRole("dialog", { name: "Thay nội dung đang soạn?" }, LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
		expect(boxValue(box)).toBe("đang viết dở");

		await userEvent.click(within(shown).getByRole("button", { name: "Đưa vào ô soạn tin" }));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Thay nội dung đang soạn?" }, LONG)).getByRole("button", { name: "Thay" }));
		await waitFor(() => expect(boxValue(box)).toBe(REPLY), LONG);
		// Asked from the header, not about a message: no reply is set.
		expect(document.querySelector(".compose-bar")).toBeNull();
	});

	it("asks for an update when the machine's tunelo does not know chats", async () => {
		const { fixture, chatId } = lanChat();
		const { machines } = await withMachine({ knowsChats: false });
		renderWith(fixture, machines, `/c/${chatId}`);
		await userEvent.click(await screen.findByRole("button", { name: "Hỏi AI" }, LONG));
		const shown = await panel();
		const ask = await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG);
		await waitFor(() => expect((ask as HTMLTextAreaElement).disabled).toBe(false), LONG);
		await userEvent.type(ask, "tóm tắt{Enter}");
		expect(await within(shown).findByText("Cập nhật tunelo để dùng AI trong hội thoại", {}, LONG)).toBeTruthy();
	});

	it("creates nothing on a tunelo older than chat sessions, and asks for an update", async () => {
		const { fixture, chatId } = lanChat();
		const { machines, created } = await withMachine({ version: "3.26.4" });
		renderWith(fixture, machines, `/c/${chatId}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
		await userEvent.type(box, "/ai tóm tắt{Enter}");
		const shown = await panel();
		expect(await within(shown).findByText("Cập nhật tunelo để dùng AI trong hội thoại", {}, LONG)).toBeTruthy();
		// The question stays in the panel's box, whose send button is off while the machine is too old.
		const ask = within(shown).getByRole("textbox", { name: "Hỏi AI về hội thoại này…" }) as HTMLTextAreaElement;
		expect(ask.value).toBe("tóm tắt");
		expect((within(shown).getByRole("button", { name: "Gửi cho AI" }) as HTMLButtonElement).disabled).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(created).toHaveLength(0);
	});

	it("sends the same '/ai' question asked again while the first one opens the session, once each", async () => {
		const { fixture, chatId } = lanChat();
		const { machines, created, sends, release } = await withMachine({ holdCreate: true });
		renderWith(fixture, machines, `/c/${chatId}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
		await userEvent.type(box, "/ai tóm tắt{Enter}");
		await panel();
		await waitFor(() => expect(created).toHaveLength(1), LONG);
		await userEvent.type(box, "/ai tóm tắt{Enter}");
		expect(boxValue(box)).toBe("");
		release();
		// The second goes to the session the first one opened: no second session.
		await waitFor(() => expect(sends.map((s) => s.text)).toEqual(["tóm tắt"]), LONG);
		expect(created).toHaveLength(1);
		expect(created[0]?.text.endsWith("\n\ntóm tắt")).toBe(true);
	});

	it("asks before ending an edit in progress, then leaves the edit for the AI's text", async () => {
		const { fixture, chatId } = lanChat();
		fixture.send(fixture.selfId, chatId, "tin cũ của tôi");
		const { machines } = await withMachine();
		renderWith(fixture, machines, `/c/${chatId}`);
		await openMenuOf("tin cũ của tôi");
		await userEvent.click(await screen.findByRole("menuitem", { name: "Sửa" }, LONG));
		const box = screen.getByRole("textbox", { name: /Tin nhắn tới/ });
		await waitFor(() => expect(boxValue(box)).toBe("tin cũ của tôi"), LONG);

		await userEvent.click(screen.getByRole("button", { name: "Hỏi AI" }));
		const shown = await panel();
		const ask = await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG);
		await waitFor(() => expect((ask as HTMLTextAreaElement).disabled).toBe(false), LONG);
		await userEvent.type(ask, "soạn câu trả lời{Enter}");
		const use = await within(shown).findByRole("button", { name: "Đưa vào ô soạn tin" }, { timeout: 15_000 });

		await userEvent.click(use);
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Thay nội dung đang soạn?" }, LONG)).getByRole("button", { name: "Huỷ" }));
		expect(boxValue(box)).toBe("tin cũ của tôi");
		expect(document.querySelector(".compose-bar")).not.toBeNull();

		await userEvent.click(use);
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Thay nội dung đang soạn?" }, LONG)).getByRole("button", { name: "Thay" }));
		await waitFor(() => expect(boxValue(box)).toBe(REPLY), LONG);
		// The edit is over (no bar) and the message kept its text.
		await waitFor(() => expect(document.querySelector(".compose-bar")).toBeNull(), LONG);
		expect(fixture.server.expectedMessages(chatId, fixture.selfId).some((m) => m.text === "tin cũ của tôi")).toBe(true);
	});

	it("asks nothing about a chat hidden from AI until it is shown again", async () => {
		const { fixture, chatId } = lanChat();
		fixture.server.hideDialogFromAi(fixture.selfId, chatId, true);
		const { machines } = await withMachine();
		renderWith(fixture, machines, `/c/${chatId}`);
		await userEvent.click(await screen.findByRole("button", { name: "Hỏi AI" }, LONG));
		const shown = await panel();
		expect(await within(shown).findByText(/Chat này đang ẩn với AI/, {}, LONG)).toBeTruthy();
		expect(within(shown).queryByRole("textbox", { name: "Hỏi AI về hội thoại này…" })).toBeNull();
		await userEvent.click(within(shown).getByRole("button", { name: "Bỏ ẩn với AI" }));
		await waitFor(() => expect(fixture.hiddenFromAiRequests).toEqual([{ chatId, hidden: false }]), LONG);
		expect(await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG)).toBeTruthy();
	});
});

describe("Ẩn với AI", () => {
	it("calls the server and follows its update", async () => {
		const { fixture, chatId } = lanChat();
		renderMessaging(fixture, `/c/${chatId}`);
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		const toggle = await within(info).findByRole("switch", { name: "Ẩn với AI" }, LONG);
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await userEvent.click(toggle);
		await waitFor(() => expect(fixture.hiddenFromAiRequests).toEqual([{ chatId, hidden: true }]), LONG);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"), LONG);
		expect(await screen.findByText("Đã ẩn chat này với AI", {}, LONG)).toBeTruthy();

		// Shown again on another session: the update reaches this one.
		fixture.server.hideDialogFromAi(fixture.selfId, chatId, false);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"), LONG);
	});
});

describe("qua AI", () => {
	it("marks the user's own message sent through AI, never somebody else's", async () => {
		const fixture = new ChatFixture();
		const lan = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, lan]);
		fixture.send(lan, chatId, "tin của Lan", { sentViaAi: true });
		fixture.send(fixture.selfId, chatId, "tin tôi gửi qua AI", { sentViaAi: true });
		fixture.send(fixture.selfId, chatId, "tin tôi tự gửi");
		renderMessaging(fixture, `/c/${chatId}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const bubble = async (text: string) => (await within(log).findByText(text, {}, LONG)).closest(".bubble") as HTMLElement;
		expect(within(await bubble("tin tôi gửi qua AI")).getByText("qua AI")).toBeTruthy();
		expect(within(await bubble("tin tôi tự gửi")).queryByText("qua AI")).toBeNull();
		expect(within(await bubble("tin của Lan")).queryByText("qua AI")).toBeNull();
	});
});

describe("helpers", () => {
	it("reads '/ai' commands only", () => {
		expect(aiQuestion("/ai tóm tắt")).toBe("tóm tắt");
		expect(aiQuestion("  /ai  ")).toBe("");
		expect(aiQuestion("/ai\ndòng hai")).toBe("dòng hai");
		expect(aiQuestion("/aide")).toBeNull();
		expect(aiQuestion("hỏi /ai")).toBeNull();
	});

	it("finds the chat's session and picks the machine", () => {
		const thread = (id: string, chatId: bigint, archived = false) => ({ id, chatId, archived }) as ThreadSummary;
		expect(chatThread([thread("a", 5n, true), thread("b", 5n), thread("c", 6n)], 5)?.id).toBe("b");
		expect(chatThread([thread("c", 6n)], 5)).toBeNull();
		const view = (ref: string, kind: "on" | "offline") => ({ entry: { ref } as never, conn: kind === "on" ? { kind } : { kind, lastSeenMs: 0 } });
		expect(pickTarget([view("1", "offline"), view("2", "on")], "")).toBe("2");
		expect(pickTarget([view("1", "offline"), view("2", "on")], "1")).toBe("1");
		expect(pickTarget([view("1", "offline")], "9")).toBe("1");
		expect(pickTarget([], "")).toBe("");
		expect(chatContext({ id: 42, externalApp: "telegram" }, "Lan")).toContain("Ứng dụng: telegram\nchat_id: 42");
	});
});

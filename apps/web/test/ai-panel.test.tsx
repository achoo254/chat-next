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
import { placeName } from "../src/machines/use-machines.ts";
import { hasLocalmanRequest } from "../src/messaging/ui/ai-localman-hints.ts";
import { draftText, plainText } from "../src/messaging/ui/ai-plain-text.ts";
import { chatContext, chatThread, pickTarget } from "../src/messaging/ui/use-chat-ai.ts";
import { splitAsked, wrapChatContext, wrapQuotedMessages } from "../src/machines/chat-question.ts";
import { toolStep } from "../src/machines/cards/tool-step.ts";
import { viMachines } from "../src/machines/copy-vi.ts";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { defaultAnswer, FakeMachine, type Body } from "./machines/fake-machine.ts";
import { ChatFixture, fixtureConnector } from "./support/fake-chat.ts";
import { FakeMachines } from "./support/fake-machines.ts";
import { boxValue } from "./support/plain-text-box.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { routerFetch } from "./support/router-fetch.ts";

const LONG = { timeout: 8000 };
const QUESTION = "mai họp lúc mấy giờ?";
const REPLY = "Dạ, mai họp lúc **9 giờ** ạ, ở `phòng 2`.";
/** The reply as the chat's composer gets it: plain text, no markdown marks. */
const REPLY_PLAIN = "Dạ, mai họp lúc 9 giờ ạ, ở phòng 2.";

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
	// The panel is named after the conversation it follows: "AI · Lan".
	return screen.findByRole("complementary", { name: /^AI/ }, LONG);
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
		await waitFor(() => expect(screen.queryByRole("complementary", { name: /^AI/ })).toBeNull());
	});

	it("«Hỏi AI» of several selected messages opens the panel about them all", async () => {
		const { fixture, chatId, lan } = lanChat();
		fixture.send(lan, chatId, "và mang theo laptop nhé");
		renderMessaging(fixture, `/c/${chatId}`);
		await openMenuOf(QUESTION);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Chọn" }, LONG));
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		fireEvent.click(within(log).getByText("và mang theo laptop nhé"));
		const bar = await screen.findByRole("toolbar", { name: "Thao tác với các tin đã chọn" }, LONG);
		await waitFor(() => expect(within(bar).getByText("Đã chọn 2 tin")).toBeTruthy());
		await userEvent.click(within(bar).getByRole("button", { name: "Hỏi AI" }));
		const quote = within(await panel()).getByRole("region", { name: "Tin đang hỏi" });
		expect(within(quote).getByText("2 tin đã chọn")).toBeTruthy();
		expect(quote.querySelector("blockquote")?.textContent).toBe(`Lan: ${QUESTION}\nLan: và mang theo laptop nhé`);
		// Selecting ends: the composer is back.
		expect(await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG)).toBeTruthy();
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
		const archived: string[] = [];
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
					const thread = { id: `chat-${created.length}`, title: b.value.chat?.title ?? "", dir: "/Users/me/.tunelo/chats/1", provider: b.value.provider, state: ThreadState.IDLE, chatId: knowsChats ? (b.value.chat?.chatId ?? 0n) : 0n } as ThreadSummary;
					threads = [...threads, thread];
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
				case "threadSetArchived":
					archived.push(b.value.threadId);
					threads = threads.map((x) => (x.id === b.value.threadId ? ({ ...x, archived: b.value.archived } as ThreadSummary) : x));
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
		return { machine, machines, created, sends, archived, release };
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
		await waitFor(() => expect(boxValue(box)).toBe(REPLY_PLAIN), LONG);
		// The reply's button says it went in (no notice over the composer), then offers it again.
		expect(use.textContent).toBe("Đã đưa vào ô soạn tin");
		expect(use.getAttribute("aria-live")).toBe("polite");
		expect(screen.getAllByText("Đã đưa vào ô soạn tin")).toHaveLength(1);
		await waitFor(() => expect(use.textContent).toBe("Đưa vào ô soạn tin"), { timeout: 4000 });
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
		// Kept their own text: the button does not say it went in.
		expect(within(shown).queryByRole("button", { name: "Đã đưa vào ô soạn tin" })).toBeNull();

		await userEvent.click(within(shown).getByRole("button", { name: "Đưa vào ô soạn tin" }));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Thay nội dung đang soạn?" }, LONG)).getByRole("button", { name: "Thay" }));
		await waitFor(() => expect(boxValue(box)).toBe(REPLY_PLAIN), LONG);
		expect(within(shown).getByRole("button", { name: "Đã đưa vào ô soạn tin" })).toBeTruthy();
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
		await waitFor(() => expect(boxValue(box)).toBe(REPLY_PLAIN), LONG);
		// The edit is over (no bar) and the message kept its text.
		await waitFor(() => expect(document.querySelector(".compose-bar")).toBeNull(), LONG);
		expect(fixture.server.expectedMessages(chatId, fixture.selfId).some((m) => m.text === "tin cũ của tôi")).toBe(true);
	});

	/** The chat's session open in the panel, its first question answered; resolves to the panel and the session's box. */
	async function openSession(fixture: ChatFixture, chatId: number, machines: FakeMachines): Promise<{ shown: HTMLElement; sessionBox: HTMLElement }> {
		renderWith(fixture, machines, `/c/${chatId}`);
		await userEvent.click(await screen.findByRole("button", { name: "Hỏi AI" }, LONG));
		const shown = await panel();
		const ask = await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG);
		await waitFor(() => expect((ask as HTMLTextAreaElement).disabled).toBe(false), LONG);
		await userEvent.type(ask, "chào{Enter}");
		const sessionBox = await within(shown).findByRole("textbox", { name: "Tin nhắn" }, { timeout: 15_000 });
		return { shown, sessionBox };
	}

	it("sends the message asked about with the user's own question, never through the session's box, once", async () => {
		const { fixture, chatId, lan } = lanChat();
		fixture.send(lan, chatId, "tin thứ hai của Lan");
		const { machines, sends } = await withMachine();
		const { shown, sessionBox } = await openSession(fixture, chatId, machines);

		await openMenuOf(QUESTION);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));
		await within(shown).findByRole("region", { name: "Tin đang hỏi" }, LONG);
		// The quote stays a card: the session's box keeps only what the user types.
		expect(boxValue(sessionBox)).toBe("");
		// Another «Hỏi AI» takes its place.
		await openMenuOf("tin thứ hai của Lan");
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));
		await waitFor(() => expect(within(within(shown).getByRole("region", { name: "Tin đang hỏi" })).queryByText(QUESTION)).toBeNull(), LONG);
		expect(boxValue(sessionBox)).toBe("");

		await userEvent.type(sessionBox, "ý Lan là gì?{Enter}");
		await waitFor(() => expect(sends.map((x) => x.text).some((text) => text.includes("ý Lan là gì?"))).toBe(true), LONG);
		const sent = sends.find((x) => x.text.includes("ý Lan là gì?"))?.text ?? "";
		expect(splitAsked(sent)).toEqual({ context: "", quote: expect.stringContaining("tin thứ hai của Lan"), question: "ý Lan là gì?" });
		expect(sent).not.toContain(QUESTION);
		// Asked: the card is gone, and the next question goes alone.
		await waitFor(() => expect(within(shown).queryByRole("region", { name: "Tin đang hỏi" })).toBeNull(), LONG);
		await userEvent.type(sessionBox, "còn gì nữa?{Enter}");
		await waitFor(() => expect(sends.map((x) => x.text)).toContain("còn gì nữa?"), LONG);
	});

	it("does not ask a quote again once it was asked, when the panel is built again", async () => {
		const { fixture, chatId } = lanChat();
		const { machines, sends } = await withMachine();
		const { shown } = await openSession(fixture, chatId, machines);
		await openMenuOf(QUESTION);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));
		const summarize = await within(shown).findByRole("button", { name: "Tóm tắt" }, LONG);
		await waitFor(() => expect((summarize as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(summarize);
		await waitFor(() => expect(sends.some((x) => x.text.includes("Tóm tắt tin này"))).toBe(true), LONG);
		await waitFor(() => expect(within(shown).queryByRole("region", { name: "Tin đang hỏi" })).toBeNull(), LONG);

		// Closed and opened again (as another chat and back builds it again): no quote comes back.
		await userEvent.click(within(shown).getByRole("button", { name: "Đóng AI" }));
		await userEvent.click(screen.getByRole("button", { name: "Hỏi AI" }));
		const again = await panel();
		await within(again).findByRole("textbox", { name: "Tin nhắn" }, { timeout: 15_000 });
		expect(within(again).queryByRole("region", { name: "Tin đang hỏi" })).toBeNull();
	});

	it("starts the chat's next session in the panel on '/clear' and «Phiên mới», putting the old one away", async () => {
		const { fixture, chatId } = lanChat();
		const { machines, sends, archived, created } = await withMachine();
		const { shown, sessionBox } = await openSession(fixture, chatId, machines);
		await userEvent.type(sessionBox, "/clear{Enter}");
		await waitFor(() => expect(archived).toEqual(["chat-1"]), LONG);
		// Nothing typed into the session, and the screen stays on the chat.
		expect(sends.map((x) => x.text)).not.toContain("/clear");
		expect(window.location.pathname).toBe(`/c/${chatId}`);
		const ask = await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG);
		await userEvent.type(ask, "lại từ đầu{Enter}");
		await waitFor(() => expect(created).toHaveLength(2), LONG);
		expect(created[1]?.text).toContain(`chat_id: ${chatId}`);

		await within(shown).findByRole("textbox", { name: "Tin nhắn" }, { timeout: 15_000 });
		await userEvent.click(within(shown).getByRole("button", { name: "Bắt đầu phiên mới, phiên cũ vào lưu trữ" }));
		await waitFor(() => expect(archived).toEqual(["chat-1", "chat-2"]), LONG);
		expect(await within(shown).findByRole("textbox", { name: "Hỏi AI về hội thoại này…" }, LONG)).toBeTruthy();
	});

	it("offers Localman's quick actions on a message with a request, and asks the session to run it", async () => {
		const { fixture, chatId, lan } = lanChat();
		fixture.send(lan, chatId, 'Gọi thử body này: {"user": "lan", "age": 3}');
		const { machines, created } = await withMachine();
		renderWith(fixture, machines, `/c/${chatId}`);
		await openMenuOf('Gọi thử body này: {"user": "lan", "age": 3}');
		await userEvent.click(await screen.findByRole("menuitem", { name: "Hỏi AI" }, LONG));
		const shown = await panel();
		const chips = within(within(shown).getByRole("region", { name: "Tin đang hỏi" })).getByRole("group", { name: "Hỏi nhanh" });
		expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["Soạn trả lời", "Tóm tắt", "Dịch", "Giải thích", "Chạy bằng Localman", "Lưu vào collection"]);
		const runIt = within(chips).getByRole("button", { name: "Chạy bằng Localman" });
		await waitFor(() => expect((runIt as HTMLButtonElement).disabled).toBe(false), LONG);
		await userEvent.click(runIt);
		await waitFor(() => expect(created).toHaveLength(1), LONG);
		expect(created[0]?.text).toContain("Dùng tool localman_send_request để gọi request trong tin này");
		expect(created[0]?.text).toContain('{"user": "lan", "age": 3}');
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
	it("folds a panel question's context and quote away from what the user typed", () => {
		const text = `${wrapChatContext("Hội thoại: Lan\nchat_id: 7")}\n\n${wrapQuotedMessages("Về tin #3 của Lan:\nxin chào\n\nđoạn hai")}\n\nnghĩa là gì?`;
		expect(splitAsked(text)).toEqual({ context: "Hội thoại: Lan\nchat_id: 7", quote: "Về tin #3 của Lan:\nxin chào\n\nđoạn hai", question: "nghĩa là gì?" });
		expect(splitAsked(wrapQuotedMessages("chỉ tin"))).toEqual({ context: "", quote: "chỉ tin", question: "" });
		// Typed elsewhere, or sent before the tags: shown as it is.
		expect(splitAsked("Hội thoại: Lan\n\ncâu hỏi")).toBeNull();
	});

	it("puts only the reply's quoted draft into the chat's composer, the whole reply when it quotes none", () => {
		const reply = "**Tóm tắt:** nhóm hẹn đá bóng.\n\n> Ok anh em, chốt **sân sau** nhé.\n> Mấy giờ ạ?\n\nZalo không cho gửi thay bạn.";
		expect(draftText(reply)).toBe("Ok anh em, chốt sân sau nhé.\nMấy giờ ạ?");
		expect(draftText("Dạ, mai họp lúc **9 giờ**.")).toBe("Dạ, mai họp lúc 9 giờ.");
	});

	it("names tool calls as plain steps for the AI panel", () => {
		const step = viMachines.transcript.step;
		expect(toolStep("mcp__tunelo__chat_search_messages", step)).toBe("Tìm tin trong chat");
		expect(toolStep("mcp__tunelo__chat_get_messages", step)).toBe("Đọc tin nhắn");
		expect(toolStep("Bash", step)).toBe("Chạy lệnh");
		expect(toolStep("mcp__other__send_message", step)).toBe("Dùng công cụ send message");
		expect(toolStep("custom_tool", step)).toBe("Dùng công cụ custom tool");
	});

	it("names a Chat conversation's folder by the app, every other folder by its name", () => {
		expect(placeName("/Users/me/.tunelo/chat-sessions/48")).toBe("Chat");
		expect(placeName("C:\\Users\\me\\.tunelo\\chat-sessions\\48\\")).toBe("Chat");
		expect(placeName("/Users/me/code/48")).toBe("48");
		expect(placeName("/Users/me/chat-sessions/notes")).toBe("notes");
	});

	it("asks for the workspace, then the collection, each by a choice, before saving to Localman", async () => {
		const [{ enScreens }, { zhCNScreens }, { viScreens }] = await Promise.all([import("../src/messaging/copy/en-screens.ts"), import("../src/messaging/copy/zh-CN-screens.ts"), import("../src/messaging/copy/vi-screens.ts")]);
		for (const screens of [viScreens, enScreens, zhCNScreens]) {
			const prompt = screens.aiPanel.prompt.localmanSave;
			const order = ["localman_list_workspaces", "localman_list_collections", "localman_create_collection_node"].map((tool) => prompt.indexOf(tool));
			expect(order.every((at) => at >= 0)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
		}
		expect(viScreens.aiPanel.prompt.localmanSave).toContain("nếu có nhiều workspace thì HỎI TÔI chọn workspace nào bằng câu hỏi có lựa chọn");
	});

	it("finds a request Localman could run in a message: curl, a URL or JSON, not prose", () => {
		expect(hasLocalmanRequest("chạy thử: curl -s https://x.example/health")).toBe(true);
		expect(hasLocalmanRequest("$ curl localhost:3000/api")).toBe(true);
		expect(hasLocalmanRequest("API mới ở https://api.example.com/v2 nhé")).toBe(true);
		expect(hasLocalmanRequest('{"user": "lan", "age": 3}')).toBe(true);
		expect(hasLocalmanRequest('Body nè: [{"id": 1}] gửi thử')).toBe(true);
		expect(hasLocalmanRequest("Payload:\n```json\n{\n  \"ok\": true\n}\n```")).toBe(true);
		expect(hasLocalmanRequest("đây `{\"k\": 1}` nhé")).toBe(true);
		// Telegram code entities count like fenced blocks.
		expect(hasLocalmanRequest("xem đoạn code", ['{"k": 1}'])).toBe(true);
		expect(hasLocalmanRequest("mai họp lúc mấy giờ? {đã chốt} [ghi chú]")).toBe(false);
		expect(hasLocalmanRequest("mình curl tóc rồi")).toBe(false);
		expect(hasLocalmanRequest("{} và []")).toBe(false);
		expect(hasLocalmanRequest("```\nchỉ là chữ\n```")).toBe(false);
	});

	it("turns the AI's markdown into plain text for a chat message", () => {
		expect(plainText("Mai họp **9 giờ**, _phòng_ `2` ~~cũ~~.")).toBe("Mai họp 9 giờ, phòng 2 cũ.");
		expect(plainText("Xem [lịch](https://lich.example/a) hoặc https://x.example")).toBe("Xem lịch (https://lich.example/a) hoặc https://x.example");
		expect(plainText("# Việc\n\n- **một**\n- hai\n\n1. ba\n2. bốn")).toBe("Việc\n\n- một\n- hai\n\n1. ba\n2. bốn");
		expect(plainText("Dòng một  \ndòng hai\n\n```json\n{\"a\": 1}\n```")).toBe('Dòng một\ndòng hai\n\n{"a": 1}');
		expect(plainText("- [x] xong\n- [ ] chưa\n  - con")).toBe("- [x] xong\n- [ ] chưa\n  - con");
		expect(plainText("Giá \\*không\\* đổi & <b>x</b>")).toBe("Giá *không* đổi & <b>x</b>");
	});

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
		const telegram = chatContext({ id: 42, externalApp: "telegram" }, "Lan");
		expect(telegram).toContain("Ứng dụng: telegram\nchat_id: 42");
		expect(telegram).toContain("chat_send_file");
		expect(telegram).not.toContain("Zalo");
		const zalo = chatContext({ id: 43, externalApp: "zalo" }, "Bình");
		expect(zalo).toContain("Hội thoại này ở Zalo: tool không gửi được tin hay tệp vào đây");
		expect(zalo).toContain("bảo người dùng bấm «Đưa vào ô soạn tin»");
	});
});

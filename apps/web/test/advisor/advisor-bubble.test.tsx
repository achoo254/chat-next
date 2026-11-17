// Advisor's bubble against a machine over the real end-to-end link (the fake
// machine of fake-machine.ts): a question goes as ThreadCreate{kind: ADVISOR}
// then ThreadSend{client_msg_id, advisor_attachments} with the copy's
// context; the answer (read from the Advisor thread's journal) opens only on
// the device that asked, another device gets a dot; "Gửi sang phiên" fills
// the session's composer; a sensitive folder asks first (NEEDS_CONSENT);
// Stop names the question; an outdated machine puts the mascot to sleep.
import { createConnectTransport } from "@connectrpc/connect-web";
import { AdvisorTone, ErrorCode, ErrorReason, LoginState, Role, ThreadKind, ThreadState, TurnState, type Frame, type ThreadCreate, type ThreadSend } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdvisorLive from "../../src/advisor/advisor-bubble.tsx";
import { AdvisorStore, EMPTY_CONTEXT, type CopyContext } from "../../src/advisor/advisor-store.ts";
import { lookOf } from "../../src/advisor/looks.ts";
import { viAdvisor } from "../../src/advisor/copy-vi.ts";
import { isCommand } from "../../src/advisor/use-advisor-presence.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { Composer } from "../../src/machines/composer.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { boxValue } from "../support/plain-text-box.ts";
import { routerFetch } from "../support/router-fetch.ts";
import type { FakeSocket } from "../machines/fake-machine.ts";
import { defaultAnswer, FakeMachine, type Body } from "../machines/fake-machine.ts";

const t = viAdvisor;
let machine: FakeMachine;
let device: KeyPair;
let socket: FakeSocket | null;
let created: ThreadCreate[];
let sends: ThreadSend[];
let interrupts: { threadId: string; clientMsgId: string }[];
/** What the machine says about Advisor: tunelo before 3.13 says nothing. */
let advisor: { available: boolean; keySet: boolean } | undefined;
let advisorSession: boolean;
/** The machine gives Claude's CLI in a terminal Advisor too (tunelo after 3.13 says so). */
let terminalAdvisor: boolean;
let needsConsent: boolean;
/** The machine answers a question at once; false leaves it running. */
let answers: boolean;
/** The question waits in the machine's queue behind another one: no item of it yet. */
let queued: boolean;
/** The Advisor thread as the machine lists it (after a reload). */
let listedAdvisor: { state: ThreadState } | null;
/** The thread's journal opens on its newest page only; the question (this id) is on the oldest page. */
let paged: string;
/** Pages between the newest and the question's (each asked for with ThreadEarlier). */
let middlePages: number;
/** Every ThreadEarlier fails (the machine refuses it). */
let earlierFails: boolean;
let earlierAsked: string[];

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
const WAIT = { timeout: 4000 };
const ADVISOR_THREAD = "advisor-1";
const SESSION = { id: "s1", title: "Sửa lỗi push", dir: "/w/app", provider: "claude", model: "", state: ThreadState.IDLE, pending: 0, updatedAt: 1n, open: false, preview: "", previewTool: "", terminalSession: 0 };
const PICK = "Rebase lên origin/main rồi push lại";

/** The Advisor thread's journal for a question: the question, its turn, the AI's reply and Jev's verdict. */
function answerItems(id: string, text: string, done: boolean): Body {
	const items = [
		{ id: `u-${id}`, seq: 1n, revision: 1, at: 1n, body: { case: "text" as const, value: { role: Role.USER, text, clientMsgId: id } } },
		{ id: `turn-${id}`, seq: 2n, revision: done ? 2 : 1, at: 2n, body: { case: "turn" as const, value: { state: done ? TurnState.COMPLETED : TurnState.RUNNING, clientMsgId: id } } },
	];
	if (done) {
		items.push(
			{ id: `a-${id}`, seq: 3n, revision: 1, at: 3n, body: { case: "text", value: { role: Role.ASSISTANT, text: "Nhánh của máy đi sau origin 1 commit.", clientMsgId: "" } } } as never,
			{
				id: `v-${id}`,
				seq: 4n,
				revision: 1,
				at: 4n,
				body: {
					case: "advisorVerdict",
					value: {
						toolId: "tool-1",
						turnId: `turn-${id}`,
						kind: "answer",
						question: "Vì sao push hỏng?",
						options: [
							{ text: PICK, probability: 0.82 },
							{ text: "/reset --hard", probability: 0.18 },
						],
						context: "push rejected (non-fast-forward)",
						confidence: 0.8,
						verdict: "confident",
						error: "",
					},
				},
			} as never,
		);
	}
	return { case: "threadItems", value: { threadId: ADVISOR_THREAD, items, cursor: { epoch: 1n, seq: 10n } } };
}

beforeEach(async () => {
	window.sessionStorage.clear();
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
	created = [];
	sends = [];
	interrupts = [];
	advisor = { available: true, keySet: true };
	advisorSession = true;
	terminalAdvisor = false;
	needsConsent = false;
	answers = true;
	queued = false;
	listedAdvisor = null;
	paged = "";
	middlePages = 0;
	earlierFails = false;
	earlierAsked = [];
	socket = null;
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	machine.handler = (frame: Frame, from) => {
		socket = from;
		const b = frame.body;
		switch (b.case) {
			case "machineInfoRequest":
				return [
					{
						case: "machineInfo",
						value: {
							name: "Mac mini",
							os: "darwin",
							agentVersion: "3.13.0",
							maxSessions: 3,
							...(advisor === undefined ? {} : { advisor: { ...advisor, keyFingerprint: advisor.keySet ? "a1b2c3" : "" } }),
							providers: [
								{ id: "claude", name: "Claude Code", loginState: LoginState.OK, capabilities: { sessionMcp: true, advisorSession, terminalAdvisor } },
								{ id: "antigravity", name: "Antigravity", loginState: LoginState.OK, capabilities: { sessionMcp: true, advisorSession: false } },
							],
						},
					},
				];
			case "threadList":
				return [
					{
						case: "threadListResult",
						value: {
							threads: [SESSION, ...(listedAdvisor === null ? [] : [{ id: ADVISOR_THREAD, kind: ThreadKind.ADVISOR, dir: "/w/app", provider: "claude", archived: true, state: listedAdvisor.state }])],
							openSessions: 0,
							maxSessions: 3,
						},
					},
				];
			case "threadSubscribe":
				if (paged !== "" && b.value.threadId === ADVISOR_THREAD) {
					const newest = { id: "u-other", seq: 20n, revision: 1, at: 20n, body: { case: "text" as const, value: { role: Role.USER, text: "later", clientMsgId: "other" } } };
					return [{ case: "threadItems", value: { threadId: ADVISOR_THREAD, items: [newest], cursor: { epoch: 1n, seq: 20n }, earlier: "page-1" } }];
				}
				return defaultAnswer(frame);
			case "threadEarlier": {
				earlierAsked.push(b.value.earlier);
				if (earlierFails) return [{ case: "error", value: { code: ErrorCode.INVALID, message: "no", reason: ErrorReason.UNSPECIFIED, subject: "" } }];
				const n = Number(b.value.earlier.replace("page-", ""));
				if (n <= middlePages) {
					// A page of another device's turns, older than the newest one.
					const other = { id: `u-p${n}`, seq: BigInt(10 - n), revision: 1, at: BigInt(10 - n), body: { case: "text" as const, value: { role: Role.USER, text: `page ${n}`, clientMsgId: `p${n}` } } };
					return [{ case: "threadEarlierResult", value: { threadId: ADVISOR_THREAD, items: [other], earlier: `page-${n + 1}` } }];
				}
				const page = answerItems(paged, "Câu cũ", true);
				const items = page.case === "threadItems" ? (page.value.items ?? []) : [];
				return [{ case: "threadEarlierResult", value: { threadId: ADVISOR_THREAD, items, earlier: "" } }];
			}
			case "threadCreate":
				created.push(b.value);
				if (needsConsent && b.value.consent?.sensitive !== true) {
					return [{ case: "error", value: { code: ErrorCode.NEEDS_CONSENT, message: "sensitive folder", reason: ErrorReason.SENSITIVE_FOLDER, subject: b.value.dir } }];
				}
				return [{ case: "threadCreated", value: { thread: { id: ADVISOR_THREAD, kind: ThreadKind.ADVISOR, dir: b.value.dir, provider: b.value.provider, archived: true, state: ThreadState.IDLE } } }];
			case "threadSend": {
				sends.push(b.value);
				const { clientMsgId, text } = b.value;
				if (!queued) setTimeout(() => machine.send(from, answerItems(clientMsgId, text, answers)), 0);
				return [{ case: "ack", value: {} }];
			}
			case "threadInterrupt":
				interrupts.push({ threadId: b.value.threadId, clientMsgId: b.value.clientMsgId });
				return [{ case: "ack", value: {} }];
			default:
				return defaultAnswer(frame);
		}
	};
	window.WebSocket = function (url: string) {
		return machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

function open(store: AdvisorStore, lastSeenAt = Math.floor(Date.now() / 1000)) {
	const machines = new FakeMachines();
	machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(lastSeenAt), publicKey: machine.keys.publicKey });
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
	const services = { toasts: { show: () => undefined }, transport } as unknown as Services;
	const view = render(
		<I18nProvider>
			<ServicesContext value={services}>
				<MachineLinksProvider>
					<AdvisorLive name="Cố vấn" look={lookOf("owl")} tone="short" store={store} />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
	return Object.assign(view, { machines });
}

const scmCopy: CopyContext = {
	...EMPTY_CONTEXT,
	screen: "scm",
	machine: "1",
	threadId: "s1",
	dir: "/w/app",
	branch: "main",
	panel: "scm",
	action: "push",
	errorCode: "GIT_DIVERGED",
	failureId: "fail-42",
};

async function ask(question: string) {
	const box = await screen.findByRole("textbox", { name: t.ask.placeholder }, WAIT);
	await userEvent.type(box, question);
	const send = screen.getByRole("button", { name: t.ask.send });
	await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false), WAIT);
	await userEvent.click(send);
}

describe("attached and recent copies", () => {
	it("says what an attached copy is for, and lists only the copies not attached yet (none: no list)", async () => {
		const store = new AdvisorStore();
		store.remember("lỗi một", scmCopy);
		store.remember("lỗi hai", { ...scmCopy, failureId: "fail-43" });
		store.setOpen(true);
		open(store);
		// The newest is offered as a chip; the other waits in the list of recent copies.
		await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${t.ask.attach}`) }, WAIT));
		expect(await screen.findByText(t.ask.attachedTitle, undefined, WAIT)).toBeTruthy();
		expect(screen.getByText(t.ask.attachedHint)).toBeTruthy();
		expect(screen.getByPlaceholderText(t.ask.placeholderAttached)).toBeTruthy();
		expect(screen.getByText(t.ask.recent(1))).toBeTruthy();
		// Attach the other too: nothing is left to pick, so the list goes.
		await userEvent.click(screen.getByText(t.ask.recent(1)));
		await userEvent.click(await screen.findByText("lỗi một", { selector: ".adv-recent-item .adv-clip" }, WAIT));
		await waitFor(() => expect(screen.queryByText(t.ask.recent(1))).toBeNull(), WAIT);
	});
});

describe("automatic Advisor in the menu", () => {
	it("is switchable for a session in Chat mode and says why it is not for one held by a terminal", async () => {
		const store = new AdvisorStore();
		store.setSession({ machine: "1", threadId: "s1" });
		store.setOpen(true);
		open(store);
		await userEvent.click(await screen.findByRole("button", { name: t.menu.label }, WAIT));
		const toggle = await screen.findByRole("switch", { name: t.menu.auto }, WAIT);
		await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false), WAIT);
		expect(screen.getByText(t.menu.autoHint)).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		cleanup();

		// The same session, now run by the terminal's own claude.
		SESSION.terminalSession = 2;
		try {
			const held = new AdvisorStore();
			held.setSession({ machine: "1", threadId: "s1" });
			held.setOpen(true);
			open(held);
			await userEvent.click(await screen.findByRole("button", { name: t.menu.label }, WAIT));
			await screen.findByText(t.menu.autoTerminal, undefined, WAIT);
			const off = await screen.findByRole("switch", { name: t.menu.auto }, WAIT);
			expect((off as HTMLButtonElement).disabled).toBe(true);
		} finally {
			SESSION.terminalSession = 0;
		}
	});

	it("is switchable for a session held by a terminal when the machine gives the terminal's CLI Advisor", async () => {
		terminalAdvisor = true;
		SESSION.terminalSession = 2;
		try {
			const store = new AdvisorStore();
			store.setSession({ machine: "1", threadId: "s1" });
			store.setOpen(true);
			open(store);
			await userEvent.click(await screen.findByRole("button", { name: t.menu.label }, WAIT));
			const toggle = await screen.findByRole("switch", { name: t.menu.auto }, WAIT);
			await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false), WAIT);
			expect(screen.getByText(t.menu.autoHint)).toBeTruthy();
			expect(screen.queryByText(t.menu.autoTerminal)).toBeNull();
		} finally {
			SESSION.terminalSession = 0;
		}
	});
});

describe("a page left open", () => {
	it("looks at the directory again when the bubble opens, so a machine seen since is found", async () => {
		const store = new AdvisorStore();
		// The page loaded when the machine had not been seen for an hour: nothing to ask yet.
		const view = open(store, Math.floor(Date.now() / 1000) - 3600);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});
		const first = view.machines.machines[0];
		if (first === undefined) throw new Error("no machine");
		first.lastSeenAt = BigInt(Math.floor(Date.now() / 1000));
		act(() => store.setOpen(true));
		await ask("Còn máy nào không?");
		await waitFor(() => expect(sends).toHaveLength(1), WAIT);
	});
});

describe("asking", () => {
	it("opens the Advisor thread of the copy's folder, sends the question with the copy, and shows the pick", async () => {
		const store = new AdvisorStore();
		store.remember("! [rejected] main -> main (non-fast-forward)", scmCopy);
		store.setOpen(true);
		open(store);
		await userEvent.click(await screen.findByRole("button", { name: `${t.ask.attach} (Quản lý mã nguồn · app · main)` }, WAIT));
		await ask("Vì sao push hỏng?");
		await waitFor(() => expect(sends).toHaveLength(1), WAIT);
		expect(created[0]).toMatchObject({ kind: ThreadKind.ADVISOR, dir: "/w/app", provider: "claude", text: "" });
		const sent = sends[0];
		const question = store.snapshot().questions[0];
		expect(sent?.threadId).toBe(ADVISOR_THREAD);
		expect(sent?.clientMsgId).toBe(question?.id);
		// The question as typed; the profile's tone goes as its enum, worded by the machine.
		expect(sent?.text).toBe("Vì sao push hỏng?");
		expect(sent?.advisorTone).toBe(AdvisorTone.SHORT);
		expect(sent?.advisorAttachments).toHaveLength(1);
		expect(sent?.advisorAttachments[0]?.text).toBe("! [rejected] main -> main (non-fast-forward)");
		expect(sent?.advisorAttachments[0]?.context).toMatchObject({ screen: "scm", dir: "/w/app", branch: "main", threadId: "s1", panel: "scm", action: "push", errorCode: "GIT_DIVERGED", failureId: "fail-42" });
		// The copy was attached: it is not offered again.
		expect(store.offer()).toBeNull();

		expect(await screen.findByText(PICK, undefined, WAIT)).toBeTruthy();
		expect(screen.getByText("82%")).toBeTruthy();
		expect(screen.getByText("Nhánh của máy đi sau origin 1 commit.")).toBeTruthy();
		expect(screen.getByText("Vì sao push hỏng?")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: t.answer.all }));
		expect(screen.getByText("/reset --hard")).toBeTruthy();
		expect(screen.getByText("push rejected (non-fast-forward)")).toBeTruthy();
	});

	it("'Gửi sang phiên' fills the composer of a session in the folder and opens it; the user sends it", async () => {
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		// Copied while the bubble shows: the chip appears.
		act(() => store.remember("error", scmCopy));
		await userEvent.click(await screen.findByRole("button", { name: /Đính kèm đoạn vừa copy/ }, WAIT));
		await ask("Sửa sao?");
		await userEvent.click(await screen.findByRole("button", { name: t.answer.toSession }, WAIT));
		await userEvent.click(screen.getByRole("button", { name: /Sửa lỗi push/ }));
		expect(window.location.pathname).toBe("/ai/1/s/s1");
		expect(store.snapshot().open).toBe(false);
		const fill = store.snapshot().fills.get("1\ns1");
		expect(fill?.text).toBe(PICK);

		// The session's composer takes it once; nothing is sent until the user does.
		const onSend = vi.fn(async () => undefined);
		const onFilled = vi.fn();
		render(
			<I18nProvider>
				<Composer ai="Claude Code" machine="Mac" online running={false} prompting={false} commands={[]} fill={fill} onFilled={onFilled} onSend={onSend} onStop={() => Promise.resolve()} />
			</I18nProvider>,
		);
		const box = screen.getByRole("textbox", { name: "Tin nhắn" });
		await waitFor(() => expect(boxValue(box)).toBe(PICK));
		expect(onFilled).toHaveBeenCalledWith(fill?.id);
		expect(onSend).not.toHaveBeenCalled();
		// An option that would run as a command never goes to a session.
		expect(isCommand("/reset --hard")).toBe(true);
		expect(isCommand("  !rm -rf build")).toBe(true);
		expect(isCommand(PICK)).toBe(false);
	});

	it("asks before reading in a sensitive folder, then sends the consent", async () => {
		needsConsent = true;
		const store = new AdvisorStore();
		store.remember("error", { ...scmCopy, dir: "/Users/me" });
		store.setOpen(true);
		open(store);
		await userEvent.click(await screen.findByRole("button", { name: /Đính kèm đoạn vừa copy/ }, WAIT));
		await ask("Có gì ở đây?");
		expect(await screen.findByText(t.ask.consent("/Users/me"), undefined, WAIT)).toBeTruthy();
		expect(sends).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: t.ask.allow }));
		await waitFor(() => expect(sends).toHaveLength(1), WAIT);
		expect(created.map((c) => c.consent?.sensitive ?? false)).toEqual([false, true]);
	});

	it("stops only the question it asked", async () => {
		answers = false;
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		await ask("Chạy lâu quá?");
		await userEvent.click(await screen.findByRole("button", { name: t.answer.stop }, WAIT));
		await waitFor(() => expect(interrupts).toHaveLength(1), WAIT);
		expect(interrupts[0]).toEqual({ threadId: ADVISOR_THREAD, clientMsgId: store.snapshot().questions[0]?.id });
		expect(store.snapshot().mood).toBe("thinking");
	});
});

describe("questions that will never be answered", () => {
	it("stopping a question still queued on the machine ends it here: back to asking, and 'Xong' shows all along", async () => {
		queued = true;
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		await ask("Còn chờ à?");
		expect(await screen.findByText(t.answer.waiting, undefined, WAIT)).toBeTruthy();
		// A way out even while it waits.
		expect(screen.getByRole("button", { name: t.answer.close })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: t.answer.stop }));
		await waitFor(() => expect(interrupts).toHaveLength(1), WAIT);
		await waitFor(() => expect(store.snapshot().questions).toHaveLength(0), WAIT);
		expect(await screen.findByRole("textbox", { name: t.ask.placeholder }, WAIT)).toBeTruthy();
		await waitFor(() => expect(store.snapshot().mood).not.toBe("thinking"), WAIT);
	});

	it("a question kept from before a reload that the idle thread no longer knows is lost: it says so and lets the user ask again", async () => {
		listedAdvisor = { state: ThreadState.IDLE };
		window.sessionStorage.setItem("advisor:questions", JSON.stringify([{ id: "q-gone", machine: "1", threadId: ADVISOR_THREAD, dir: "/w/app", askedAt: Date.now() - 60_000 }]));
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(t.answer.lost, undefined, WAIT)).toBeTruthy();
		await waitFor(() => expect(store.snapshot().mood).not.toBe("thinking"), WAIT);
		expect(screen.queryByRole("button", { name: t.answer.stop })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: t.answer.askAgain }));
		expect(await screen.findByRole("textbox", { name: t.ask.placeholder }, WAIT)).toBeTruthy();
	});

	it("a question older than the thread's newest page is read from the pages before, not called lost", async () => {
		listedAdvisor = { state: ThreadState.IDLE };
		paged = "q-old";
		window.sessionStorage.setItem("advisor:questions", JSON.stringify([{ id: "q-old", machine: "1", threadId: ADVISOR_THREAD, dir: "/w/app", askedAt: Date.now() - 60_000 }]));
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(PICK, undefined, WAIT)).toBeTruthy();
		expect(screen.getByText("Câu cũ")).toBeTruthy();
		expect(screen.queryByText(t.answer.lost)).toBeNull();
	});

	it("reads page after page back to the question, each with the mark the last one gave", async () => {
		listedAdvisor = { state: ThreadState.IDLE };
		paged = "q-old";
		middlePages = 2;
		window.sessionStorage.setItem("advisor:questions", JSON.stringify([{ id: "q-old", machine: "1", threadId: ADVISOR_THREAD, dir: "/w/app", askedAt: Date.now() - 60_000 }]));
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(PICK, undefined, WAIT)).toBeTruthy();
		expect(earlierAsked).toEqual(["page-1", "page-2", "page-3"]);
		expect(screen.queryByText(t.answer.lost)).toBeNull();
	});

	it("older pages that cannot be read: a few tries, then the question is lost and the mascot stops waiting", async () => {
		listedAdvisor = { state: ThreadState.IDLE };
		paged = "q-old";
		earlierFails = true;
		window.sessionStorage.setItem("advisor:questions", JSON.stringify([{ id: "q-old", machine: "1", threadId: ADVISOR_THREAD, dir: "/w/app", askedAt: Date.now() - 60_000 }]));
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(t.answer.lost, undefined, WAIT)).toBeTruthy();
		expect(earlierAsked).toEqual(["page-1", "page-1", "page-1"]);
		await waitFor(() => expect(store.snapshot().mood).not.toBe("thinking"), WAIT);
	});
});

describe("devices and machines", () => {
	it("opens the answer only on the device that asked: another one gets a dot", async () => {
		const other = new AdvisorStore();
		other.setOpen(true);
		open(other);
		await screen.findByRole("textbox", { name: t.ask.placeholder }, WAIT);
		act(() => other.setOpen(false));
		await waitFor(() => expect(socket).not.toBeNull(), WAIT);
		const thread = { id: ADVISOR_THREAD, kind: ThreadKind.ADVISOR, dir: "/w/app", provider: "claude", archived: true };
		act(() => {
			if (socket === null) return;
			machine.send(socket, { case: "threadStatus", value: { thread: { ...thread, state: ThreadState.RUNNING } } });
			machine.send(socket, { case: "threadStatus", value: { thread: { ...thread, state: ThreadState.IDLE } } });
		});
		await waitFor(() => expect(other.snapshot().dot).toBe(true), WAIT);
		act(() => other.setOpen(true));
		expect(await screen.findByText(t.answer.elsewhere, undefined, WAIT)).toBeTruthy();
		expect(screen.queryByText(PICK)).toBeNull();
		act(() => other.setOpen(false));
		expect(other.snapshot().dot).toBe(false);
	});

	it("sleeps on a machine whose tunelo knows no Advisor, and says so", async () => {
		advisor = undefined;
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(t.notes.update, undefined, WAIT)).toBeTruthy();
		expect(store.snapshot().mood).toBe("sleeping");
		await userEvent.type(screen.getByRole("textbox", { name: t.ask.placeholder }), "Có ai không?");
		expect((screen.getByRole("button", { name: t.ask.send }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("says so when no AI of the machine can run Advisor's read-only session (Antigravity cannot yet)", async () => {
		advisorSession = false;
		const store = new AdvisorStore();
		store.setOpen(true);
		open(store);
		expect(await screen.findByText(t.notes["no-ai"], undefined, WAIT)).toBeTruthy();
		expect(store.snapshot().mood).toBe("sleeping");
	});
});

// Advisor's verdict card in a session's transcript: the advisor_weigh call
// folds into its verdict (by tool id, never by the tool's name), two calls
// side by side keep their own verdicts, the card shows exactly what was sent
// with each option's probability, its chips send through the session and
// stay dimmed while a turn runs, a failed call says why without chips or
// the call's raw input, and a turn whose AI never asked gets a quiet line.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { AdvisorVerdictItemSchema, ItemSchema, Role, ThreadState, ThreadSummarySchema, ToolKind, TurnItemSchema, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { viAdvisor } from "../../src/advisor/copy-vi.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AdvisorVerdictCard } from "../../src/machines/cards/advisor-verdict.tsx";
import { TurnLine } from "../../src/machines/cards/turn-line.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { Transcript, verdictChipsSend } from "../../src/machines/session-chat.tsx";
import { foldTranscript } from "../../src/machines/transcript/tool-fold.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";

type Body = NonNullable<MessageInitShape<typeof ItemSchema>["body"]>;

const t = viAdvisor;
const NAME = "Bác Cú";
/** The user's Advisor profile, as the synced store gives it (the same object until it changes). */
const PROFILE = { name: NAME, lookId: "owl", tone: "short" };
const services = {
	toasts: { show: () => undefined },
	store: { subscribe: () => () => undefined, advisorProfile: () => PROFILE },
} as unknown as Services;
const wrap = (node: ReactNode) =>
	render(
		<I18nProvider>
			<ServicesContext value={services}>{node}</ServicesContext>
		</I18nProvider>,
	);

let seq = 0n;
function item(id: string, body: Body): Item {
	seq += 1n;
	return create(ItemSchema, { id, seq, revision: 1, at: seq, provider: "claude", model: "", body });
}
const RAW_SECRET = "glpat-abcdefghijklmnopqrstu";
const call = (toolId: string, input = "{}"): Body => ({ case: "toolCall", value: { toolId, kind: ToolKind.OTHER, name: "mcp__tunelo__advisor_weigh", summary: "advisor_weigh", input } });
const result = (toolId: string): Body => ({ case: "toolResult", value: { toolId, ok: true, output: '{"advisor":"verdict"}' } });
const verdictOf = (init: MessageInitShape<typeof AdvisorVerdictItemSchema>) => create(AdvisorVerdictItemSchema, init);
const NEXT = verdictOf({
	toolId: "w1",
	turnId: "turn:1",
	kind: "next_steps",
	question: "Làm gì tiếp sau khi sửa lỗi push?",
	options: [
		{ text: "Chạy lại test", probability: 0.2 },
		{ text: "Rebase lên origin/main rồi push", probability: 0.7 },
		{ text: "/compact", probability: 0.1 },
	],
	context: "Nhánh đi sau origin 1 commit.",
	confidence: 0.64,
	verdict: "confident",
});

describe("folding Advisor's verdicts", () => {
	it("folds the advisor_weigh call and its result into the verdict by tool id", () => {
		const items = [
			item("u1", { case: "text", value: { role: Role.USER, text: "sửa push" } }),
			item("turn:1", { case: "turn", value: { state: TurnState.COMPLETED, durationMs: 1_000n } }),
			item("c-bash", { case: "toolCall", value: { toolId: "b1", kind: ToolKind.SHELL, name: "Bash", summary: "git status", input: "{}" } }),
			item("c-w1", call("w1")),
			item("r-w1", result("w1")),
			item("advisor:w1", { case: "advisorVerdict", value: NEXT }),
		];
		const blocks = foldTranscript(items);
		const rows = blocks.flatMap((b) => (b.kind === "tools" ? b.runs : []));
		expect(rows.map((r) => r.call?.toolId)).toEqual(["b1"]);
		expect(blocks.filter((b) => b.kind === "advisor").map((b) => b.id)).toEqual(["advisor:w1"]);
		// The call still counts as a tool the turn ran.
		expect(blocks.find((b) => b.kind === "turn")).toMatchObject({ tools: 2 });
	});

	it("keeps two calls side by side apart, each with its own verdict", () => {
		const second = verdictOf({ toolId: "w2", turnId: "turn:1", kind: "decision", question: "Giữ hay bỏ file cũ?", options: [{ text: "Giữ", probability: 0.4 }, { text: "Bỏ", probability: 0.6 }], verdict: "unsure", confidence: 0.3 });
		const items = [
			item("c-w1", call("w1")),
			item("c-w2", call("w2")),
			item("r-w2", result("w2")),
			item("advisor:w2", { case: "advisorVerdict", value: second }),
			item("r-w1", result("w1")),
			item("advisor:w1", { case: "advisorVerdict", value: NEXT }),
		];
		const blocks = foldTranscript(items);
		expect(blocks.some((b) => b.kind === "tools")).toBe(false);
		const cards = blocks.flatMap((b) => (b.kind === "advisor" ? [[b.id, b.verdict.toolId, b.verdict.question]] : []));
		expect(cards).toEqual([
			["advisor:w2", "w2", "Giữ hay bỏ file cũ?"],
			["advisor:w1", "w1", NEXT.question],
		]);
	});

	it("leaves a call Advisor has no verdict on yet as an ordinary row", () => {
		const blocks = foldTranscript([item("c-w1", call("w1"))]);
		expect(blocks.flatMap((b) => (b.kind === "tools" ? b.runs : [])).map((r) => r.call?.toolId)).toEqual(["w1"]);
	});
});

describe("Advisor's verdict card", () => {
	it("shows the name, exactly what was sent, each option's share and the verdict", () => {
		wrap(<AdvisorVerdictCard verdict={NEXT} onSend={async () => undefined} past={false} running={false} unavailable={false} ai="Claude" />);
		expect(screen.getByRole("group", { name: t.card.title(NAME) })).toBeTruthy();
		expect(screen.getByText(NEXT.question)).toBeTruthy();
		expect(screen.getByText(NEXT.context)).toBeTruthy();
		expect(screen.getByText(`${t.answer.confident} · ${t.answer.confidence(64)}`)).toBeTruthy();
		const options = screen.getByRole("list", { name: t.card.options });
		// In the order the AI gave them, each with its probability.
		expect([...options.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Chạy lại test20%", "Rebase lên origin/main rồi push70%", "/compact10%"]);
		expect(options.querySelector("li.top")?.textContent).toContain("Rebase");
	});

	it("labels an unsure verdict", () => {
		wrap(<AdvisorVerdictCard verdict={verdictOf({ ...NEXT, kind: "decision", verdict: "unsure", confidence: 0.3 })} past={false} running={false} unavailable={false} ai="Claude" />);
		expect(screen.getByText(`${t.answer.unsure} · ${t.answer.confidence(30)}`)).toBeTruthy();
		// A decision is the AI's to act on: no chips.
		expect(screen.queryByRole("group", { name: t.card.next })).toBeNull();
	});

	it("sends a next step with one tap, best first, never a command", async () => {
		const onSend = vi.fn(async (_text: string) => undefined);
		wrap(<AdvisorVerdictCard verdict={NEXT} onSend={onSend} past={false} running={false} unavailable={false} ai="Claude" />);
		const chips = screen.getByRole("group", { name: t.card.next });
		const buttons = [...chips.querySelectorAll("button")];
		expect(buttons.map((b) => b.textContent)).toEqual(["Rebase lên origin/main rồi push", "Chạy lại test"]);
		await userEvent.click(screen.getByRole("button", { name: "Rebase lên origin/main rồi push" }));
		expect(onSend).toHaveBeenCalledWith("Rebase lên origin/main rồi push");
		// Taken once: the card's chips are done, the one sent is marked.
		expect(screen.getByRole("button", { name: /Rebase lên origin\/main rồi push.*Đã gửi/ })).toHaveProperty("disabled", true);
		await userEvent.click(screen.getByRole("button", { name: "Chạy lại test" }));
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it("dims its chips while a turn runs and sends nothing then", async () => {
		const onSend = vi.fn(async (_text: string) => undefined);
		const view = wrap(<AdvisorVerdictCard verdict={NEXT} onSend={onSend} past={false} running unavailable={false} ai="Claude" />);
		const chip = screen.getByRole("button", { name: "Chạy lại test" });
		expect(chip).toHaveProperty("disabled", true);
		expect(screen.getByText(t.card.locked)).toBeTruthy();
		await userEvent.click(chip);
		expect(onSend).not.toHaveBeenCalled();
		view.rerender(
			<I18nProvider>
				<ServicesContext value={services}>
					<AdvisorVerdictCard verdict={NEXT} onSend={onSend} past={false} running={false} unavailable={false} ai="Claude" />
				</ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Chạy lại test" })).toHaveProperty("disabled", false);
	});

	it("says why a send failed and lets the user try again", async () => {
		const onSend = vi.fn(async (_text: string): Promise<void> => {
			throw new Error("link down");
		});
		wrap(<AdvisorVerdictCard verdict={NEXT} onSend={onSend} past={false} running={false} unavailable={false} ai="Claude" />);
		await userEvent.click(screen.getByRole("button", { name: "Chạy lại test" }));
		expect(screen.getByRole("alert").textContent).not.toBe("");
		expect(screen.getByRole("button", { name: "Chạy lại test" })).toHaveProperty("disabled", false);
	});

	it.each([
		["timeout", "Cố vấn không trả lời kịp."],
		["key_invalid", "Khoá Cố vấn không hợp lệ."],
		["interrupted", "Đã dừng."],
		["something_new", "Cố vấn gặp lỗi."],
	])("words error %s, with no chips", (error, text) => {
		const failed = verdictOf({ toolId: "w1", kind: "next_steps", question: NEXT.question, options: [{ text: "Chạy lại test", probability: 0 }], error });
		wrap(<AdvisorVerdictCard verdict={failed} onSend={async () => undefined} past={false} running={false} unavailable={false} ai="Claude" />);
		expect(screen.getByText(text)).toBeTruthy();
		expect(screen.queryByRole("group", { name: t.card.next })).toBeNull();
		expect(screen.queryByRole("list", { name: t.card.options })).toBeNull();
	});
});

describe("Advisor in the session's transcript", () => {
	const state = { info: null, full: new Map(), journals: new Map(), threads: [] } as unknown as LinkState;
	const link = { activity: () => undefined, onActivity: () => () => undefined, request: () => Promise.reject(new Error("not used")) };
	const thread = create(ThreadSummarySchema, { id: "t1", title: "Push", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: 1n });

	it("never shows the raw input of a call Advisor refused to send", () => {
		const refused = verdictOf({ toolId: "w1", kind: "decision", error: "refused" });
		const blocks = foldTranscript([item("c-w1", call("w1", JSON.stringify({ question: `token ${RAW_SECRET}` }))), item("r-w1", result("w1")), item("advisor:w1", { case: "advisorVerdict", value: refused })]);
		const view = wrap(<Transcript blocks={blocks} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live onSend={async () => undefined} />);
		expect(screen.getByText(t.answer.errors.refused ?? "")).toBeTruthy();
		expect(view.container.textContent).not.toContain(RAW_SECRET);
		expect(view.container.textContent).not.toContain("advisor_weigh");
	});

	it("dims the chips while the session's turn runs and sends a tap through the session once it ended", async () => {
		const onSend = vi.fn(async (_text: string) => undefined);
		const blocks = foldTranscript([item("c-w1", call("w1")), item("advisor:w1", { case: "advisorVerdict", value: NEXT })]);
		const at = (running: boolean) => (
			<I18nProvider>
				<ServicesContext value={services}>
					<Transcript blocks={blocks} state={state} running={running} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live onSend={onSend} />
				</ServicesContext>
			</I18nProvider>
		);
		const view = render(at(true));
		expect(screen.getByRole("button", { name: "Chạy lại test" })).toHaveProperty("disabled", true);
		view.rerender(at(false));
		await userEvent.click(screen.getByRole("button", { name: "Chạy lại test" }));
		expect(onSend).toHaveBeenCalledWith("Chạy lại test");
	});

	it("offers no chips in Advisor's own session (nothing is sent there)", () => {
		const blocks = foldTranscript([item("advisor:w1", { case: "advisorVerdict", value: NEXT })]);
		wrap(<Transcript blocks={blocks} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live />);
		expect(screen.getByText(NEXT.question)).toBeTruthy();
		expect(screen.queryByRole("group", { name: t.card.next })).toBeNull();
	});

	it("dims the chips while the session cannot take a message", () => {
		const blocks = foldTranscript([item("advisor:w1", { case: "advisorVerdict", value: NEXT })]);
		wrap(<Transcript blocks={blocks} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live onSend={async () => undefined} sendLocked />);
		expect(screen.getByRole("button", { name: "Chạy lại test" })).toHaveProperty("disabled", true);
	});
});

describe("a turn whose AI never asked Advisor", () => {
	it("gets a quiet line naming the user's Advisor", () => {
		const turn = create(TurnItemSchema, { state: TurnState.COMPLETED, durationMs: 1_200n, advisorMissed: true });
		wrap(<TurnLine turn={turn} tools={0} files={0} t={viMachines} locale="vi" />);
		expect(screen.getByText("Xong · 1,2 giây")).toBeTruthy();
		expect(screen.getByText(t.card.missed(NAME))).toBeTruthy();
	});

	it("says nothing of Advisor otherwise", () => {
		const turn = create(TurnItemSchema, { state: TurnState.COMPLETED, durationMs: 1_200n });
		wrap(<TurnLine turn={turn} tools={0} files={0} t={viMachines} locale="vi" />);
		expect(screen.queryByText(t.card.missed(NAME))).toBeNull();
	});
});

describe("chips spent once the user went on (read from the transcript)", () => {
	const state = { info: null, full: new Map(), journals: new Map(), threads: [] } as unknown as LinkState;
	const link = { activity: () => undefined, onActivity: () => () => undefined, request: () => Promise.reject(new Error("not used")) };
	const thread = create(ThreadSummarySchema, { id: "t1", title: "Push", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: 1n });
	const verdict = (id: string, v = NEXT) => item(id, { case: "advisorVerdict", value: v });
	const userText = (id: string, text: string, clientMsgId = "") => item(id, { case: "text", value: { role: Role.USER, text, clientMsgId } });
	const turn = (id: string) => item(id, { case: "turn", value: { state: TurnState.COMPLETED, durationMs: 1_000n } });
	const show = (blocks: ReturnType<typeof foldTranscript>) =>
		wrap(<Transcript blocks={blocks} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live onSend={async () => undefined} />);
	const opens = (blocks: ReturnType<typeof foldTranscript>) => blocks.flatMap((b) => (b.kind === "advisor" ? [b.open] : []));

	it("keeps the newest verdict open while nothing of the user follows", () => {
		expect(opens(foldTranscript([userText("u1", "sửa push"), turn("turn:1"), verdict("advisor:w1")]))).toEqual([true]);
	});

	it("spends an older turn's chips once the user typed their own message, even after that turn ended", () => {
		const blocks = foldTranscript([userText("u1", "sửa push"), turn("turn:1"), verdict("advisor:w1"), userText("u2", "Ok, build lại luôn nhé"), turn("turn:2")]);
		expect(opens(blocks)).toEqual([false]);
		show(blocks);
		expect(screen.getByRole("button", { name: "Chạy lại test" })).toHaveProperty("disabled", true);
		expect(screen.getByText(t.card.past)).toBeTruthy();
	});

	it("keeps a sent chip's card spent after a reload (a fresh transcript of the same journal)", async () => {
		const onSend = vi.fn(async (_text: string) => undefined);
		const before = foldTranscript([turn("turn:1"), verdict("advisor:w1")]);
		const first = wrap(<Transcript blocks={before} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live onSend={onSend} />);
		await userEvent.click(screen.getByRole("button", { name: "Chạy lại test" }));
		expect(onSend).toHaveBeenCalledTimes(1);
		first.unmount();
		// The machine echoed the message and ran its turn; the page loads again.
		show(foldTranscript([turn("turn:1"), verdict("advisor:w1"), userText("u2", "Chạy lại test", "m1"), turn("turn:2")]));
		for (const chip of screen.getByRole("group", { name: t.card.next }).querySelectorAll("button")) expect(chip.disabled).toBe(true);
	});

	it("spends every open card while a sent message is still on its way, a second next-steps card of the turn included", () => {
		const second = verdictOf({ toolId: "w2", turnId: "turn:1", kind: "next_steps", question: "Còn gì nữa?", verdict: "confident", confidence: 0.8, options: [{ text: "Viết thêm test", probability: 0.9 }, { text: "Thôi", probability: 0.1 }] });
		const items = [turn("turn:1"), verdict("advisor:w1"), verdict("advisor:w2", second)];
		expect(opens(foldTranscript(items))).toEqual([true, true]);
		const blocks = foldTranscript(items, [{ clientMsgId: "m1", text: "Chạy lại test" }]);
		expect(opens(blocks)).toEqual([false, false]);
		show(blocks);
		expect(screen.getByRole("button", { name: "Viết thêm test" })).toHaveProperty("disabled", true);
		// Once echoed, the message itself closes them.
		expect(opens(foldTranscript([...items, userText("u2", "Chạy lại test", "m1")], [{ clientMsgId: "m1", text: "Chạy lại test" }]))).toEqual([false, false]);
	});

	it("says why chips wait when the session cannot take a message, not that a turn runs", () => {
		wrap(<AdvisorVerdictCard verdict={NEXT} onSend={async () => undefined} past={false} running={false} unavailable ai="Claude" />);
		expect(screen.getByText(t.card.unavailable)).toBeTruthy();
		expect(screen.queryByText(t.card.locked)).toBeNull();
	});
});

describe("where chips may send", () => {
	it("only in a listed working session, never in Advisor's own nor before the list came", () => {
		expect(verdictChipsSend(true, false)).toBe(true);
		expect(verdictChipsSend(true, true)).toBe(false);
		expect(verdictChipsSend(false, false)).toBe(false);
	});
});

describe("a verdict naming no call", () => {
	it("shows its card and folds no call (tunelo always names the call)", () => {
		const nameless = verdictOf({ ...NEXT, toolId: "" });
		const blocks = foldTranscript([item("c-w1", call("w1")), item("advisor:", { case: "advisorVerdict", value: nameless })]);
		expect(blocks.map((b) => b.kind)).toEqual(["tools", "advisor"]);
	});
});

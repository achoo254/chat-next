// After the AI's CLI in the session's terminal went on in another
// conversation (/clear, /resume), the machine writes a conversation break: a
// status item with no text under a reserved id. The session shows the
// conversation from the latest break on; the earlier ones stay behind one
// small row that opens and closes them in place. A page from before breaks
// existed draws the break as nothing, and an item type this page does not
// know draws nothing either.
import { create } from "@bufbuild/protobuf";
import { ItemSchema, Role, ThreadState, ThreadSummarySchema, type Item } from "@achoo254/chat-proto/remote/remote";
import { conversationBreakItem } from "@achoo254/chat-remote-protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { TRANSCRIPT_PAGE, Transcript, type PreviousConversation } from "../../src/machines/session-chat.tsx";
import { messageCount, splitConversations } from "../../src/machines/transcript/conversation-break.ts";
import { foldTranscript, type Block } from "../../src/machines/transcript/tool-fold.ts";

afterEach(cleanup);

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

function text(id: string, seq: number, at: number, role: Role, words: string): Item {
	return create(ItemSchema, { id, seq: BigInt(seq), revision: 1, at: BigInt(at), body: { case: "text", value: { role, text: words } } });
}

function conversationBreak(segment: number, seq: number, at: number): Item {
	return create(ItemSchema, { ...conversationBreakItem(segment, `session-${segment}`), seq: BigInt(seq), revision: 1, at: BigInt(at) });
}

/** Two messages and a thought before the break, two after: in display order (by time). */
const items: Item[] = [
	text("u1", 1, 1_000, Role.USER, "build it"),
	text("th1", 2, 1_500, Role.THINKING, "hmm"),
	text("a1", 3, 2_000, Role.ASSISTANT, "Built."),
	conversationBreak(1, 4, 3_000),
	text("u2", 5, 4_000, Role.USER, "now the docs"),
	text("a2", 6, 5_000, Role.ASSISTANT, "Docs written."),
];

const texts = (list: readonly Item[]): string[] => list.flatMap((i) => (i.body.case === "text" ? [i.body.value.text] : []));

describe("splitting a thread at its latest conversation break", () => {
	it("keeps everything when there is no break", () => {
		const none = items.filter((i) => i.body.case !== "status");
		expect(splitConversations(none)).toEqual({ previous: [], current: none, breakId: "" });
	});

	it("splits by when an item was written (seq), not by its time: a conversation gone back to (/resume) is after the break", () => {
		const back = [conversationBreak(0, 3, 2_500), ...items.slice(0, 3), conversationBreak(2, 7, 6_000), text("u1-again", 8, 500, Role.USER, "the old question")];
		const { previous, current, breakId } = splitConversations(back);
		expect(texts(previous)).toEqual(["build it", "hmm", "Built."]);
		expect(texts(current)).toEqual(["the old question"]);
		expect(breakId).toBe("conversation-break:2:session-2");
		expect([...previous, ...current].some((i) => i.body.case === "status")).toBe(false);
	});

	it("leaves an ordinary status line where it is", () => {
		const note = create(ItemSchema, { id: "status:1", seq: 7n, revision: 1, at: 6_000n, body: { case: "status", value: { text: "Compacted" } } });
		expect(splitConversations([...items, note]).current.at(-1)?.id).toBe("status:1");
	});

	it("counts the messages of the user and the AI, not thoughts", () => {
		const { previous, current } = splitConversations(items);
		expect(messageCount(previous)).toBe(2);
		expect(messageCount(current)).toBe(2);
	});

	it("draws nothing for a break (as pages from before breaks do), nor for an item type this page does not know", () => {
		const unknown = create(ItemSchema, { id: "x", seq: 9n, revision: 1, at: 9_000n });
		expect(unknown.body.case).toBeUndefined();
		const blocks = foldTranscript([conversationBreak(1, 1, 1), unknown, text("u", 2, 2, Role.USER, "hi")]);
		expect(blocks.map((b) => b.kind)).toEqual(["user"]);
	});
});

describe("the session's conversation after a break", () => {
	const state = { info: null, full: new Map(), journals: new Map(), threads: [] } as unknown as LinkState;
	const link = { activity: () => undefined, onActivity: () => () => undefined, request: () => Promise.reject(new Error("not used")) };
	const thread = create(ThreadSummarySchema, { id: "t1", title: "Build", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: 1n });

	const view = (blocks: readonly Block[], previous: PreviousConversation | null) => (
		<Transcript blocks={blocks} previous={previous} state={state} running={false} startedAt={null} waiting={false} fetchFull={() => Promise.resolve()} link={link} threadId="t1" thread={thread} live />
	);

	function show() {
		const { previous, current, breakId } = splitConversations(items);
		return wrap(view(foldTranscript(current), { blocks: foldTranscript(previous), messages: messageCount(previous), breakId }));
	}

	it("shows only the new conversation, with one folded row for the earlier one that opens and closes it in place", async () => {
		const shown = show();
		const row = screen.getByRole("button", { name: "Cuộc trò chuyện trước (2 tin nhắn)" });
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("now the docs")).toBeTruthy();
		expect(screen.queryByText("Docs written.")).toBeTruthy();
		expect(screen.queryByText("build it")).toBeNull();
		expect(screen.queryByText("Built.")).toBeNull();
		// The row is where the new conversation begins.
		expect(row.compareDocumentPosition(screen.getByText("now the docs")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		await act(async () => row.click());
		expect(row.getAttribute("aria-expanded")).toBe("true");
		const earlier = screen.getByText("build it");
		expect(screen.queryByText("Built.")).toBeTruthy();
		// The earlier conversation comes above the row, the new one stays below it.
		expect(earlier.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(row.compareDocumentPosition(screen.getByText("now the docs")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(shown.container.querySelectorAll("[data-id=transcript-previous]")).toHaveLength(1);

		await act(async () => row.click());
		expect(row.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("build it")).toBeNull();
		expect(screen.queryByText("now the docs")).toBeTruthy();
	});

	it("has no row when there was no break", () => {
		const shown = wrap(view(foldTranscript(items), null));
		expect(shown.container.querySelector("[data-id=transcript-previous]")).toBeNull();
		expect(screen.queryByText("build it")).toBeTruthy();
	});

	it("a /clear while the user reads further up shows the new conversation, not an empty page", async () => {
		const long: Block[] = Array.from({ length: TRANSCRIPT_PAGE * 2 + 5 }, (_, i): Block => ({ kind: "text", id: `a${i}`, text: `reply ${i}`, partial: false }));
		const shown = wrap(view(long, null));
		// Scrolled up a page: the window now starts part way into the conversation.
		await act(async () => screen.getByRole("button", { name: `Xem ${TRANSCRIPT_PAGE} mục trước` }).click());
		expect(screen.queryByText("reply 5")).toBeTruthy();
		const fresh: Block[] = [
			{ kind: "user", id: "n1", text: "now the docs", pending: false, attachments: [] },
			{ kind: "text", id: "n2", text: "Docs written.", partial: false },
		];
		shown.rerender(<I18nProvider>{view(fresh, { blocks: long, messages: long.length, breakId: "conversation-break:1:s" })}</I18nProvider>);
		expect(screen.queryByText("now the docs")).toBeTruthy();
		expect(screen.queryByText("Docs written.")).toBeTruthy();
		expect(screen.getByRole("button", { name: `Cuộc trò chuyện trước (${long.length} tin nhắn)` })).toBeTruthy();
	});
});
